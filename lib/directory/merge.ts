/*
 * Two rows for one person, or one group: everything on the duplicate moves to
 * the one kept, and the duplicate goes. Where both are already on the same
 * thing (an item, a meeting, a roster, a group), the kept one's place stands.
 * Ids held in JSON (pending proposals, undo entries) are rewritten too, so a
 * proposal still resolves and an undo still restores.
 */

import { sql } from 'drizzle-orm'
import { ValidationError, inTransaction, type Executor } from '../core/types'
import { getGroup, type Group } from './groups'
import { getPerson, type Person } from './people'

async function rewriteJson(tx: Executor, from: string, to: string) {
  await tx.execute(sql`
    update proposals set payload = replace(payload::text, ${from}, ${to})::jsonb
    where payload::text like ${`%${from}%`}`)
  await tx.execute(sql`
    update undo_entries set data = replace(data::text, ${from}, ${to})::jsonb
    where data::text like ${`%${from}%`}`)
}

/** Folds `fromId` into `intoId`, which keeps its name. John can be kept but never folded away. */
export async function mergePeople(exec: Executor, fromId: string, intoId: string): Promise<Person> {
  return inTransaction(exec, async (tx) => {
    if (fromId === intoId) throw new ValidationError('Pick someone else to merge with.')
    const from = await getPerson(tx, fromId)
    await getPerson(tx, intoId)
    if (from.isSelf) throw new ValidationError('You can’t be merged away; merge the other one into you.')

    await tx.execute(sql`update person_emails set person_id = ${intoId}, is_primary = false
      where person_id = ${fromId}`)

    await tx.execute(sql`delete from item_parties a using item_parties b
      where a.person_id = ${fromId} and b.person_id = ${intoId} and a.item_id = b.item_id`)
    await tx.execute(sql`update item_parties set person_id = ${intoId} where person_id = ${fromId}`)

    for (const [table, key] of [
      ['group_members', 'group_id'],
      ['series_people', 'series_id'],
      ['meeting_people', 'meeting_id'],
      ['meeting_absences', 'meeting_id'],
    ] as const) {
      await tx.execute(sql`delete from ${sql.identifier(table)} a using ${sql.identifier(table)} b
        where a.person_id = ${fromId} and b.person_id = ${intoId}
          and a.${sql.identifier(key)} = b.${sql.identifier(key)}`)
      await tx.execute(sql`update ${sql.identifier(table)} set person_id = ${intoId} where person_id = ${fromId}`)
    }
    // Someone at a meeting is not also away from it.
    await tx.execute(sql`delete from meeting_absences a using meeting_people p
      where a.person_id = ${intoId} and p.person_id = ${intoId} and a.meeting_id = p.meeting_id`)

    await tx.execute(sql`update agenda_lines set leader_person_id = ${intoId} where leader_person_id = ${fromId}`)
    await rewriteJson(tx, fromId, intoId)

    await tx.execute(sql`delete from people where id = ${fromId}`)
    await tx.execute(sql`update people set updated_at = now() where id = ${intoId}`)
    return getPerson(tx, intoId)
  })
}

/** Folds group `fromId` into `intoId`, in the same context; the kept one keeps its name. */
export async function mergeGroups(exec: Executor, fromId: string, intoId: string): Promise<Group> {
  return inTransaction(exec, async (tx) => {
    if (fromId === intoId) throw new ValidationError('Pick another group to merge with.')
    const from = await getGroup(tx, fromId)
    const into = await getGroup(tx, intoId)
    if (from.contextId !== into.contextId) throw new ValidationError('Groups merge only within one context.')

    await tx.execute(sql`update group_emails set group_id = ${intoId} where group_id = ${fromId}`)

    await tx.execute(sql`delete from item_parties a using item_parties b
      where a.group_id = ${fromId} and b.group_id = ${intoId} and a.item_id = b.item_id`)
    await tx.execute(sql`update item_parties set group_id = ${intoId} where group_id = ${fromId}`)

    for (const [table, key] of [
      ['group_members', 'person_id'],
      ['series_groups', 'series_id'],
      ['meeting_groups', 'meeting_id'],
    ] as const) {
      await tx.execute(sql`delete from ${sql.identifier(table)} a using ${sql.identifier(table)} b
        where a.group_id = ${fromId} and b.group_id = ${intoId}
          and a.${sql.identifier(key)} = b.${sql.identifier(key)}`)
      await tx.execute(sql`update ${sql.identifier(table)} set group_id = ${intoId} where group_id = ${fromId}`)
    }

    await tx.execute(sql`update meeting_people set group_id = ${intoId} where group_id = ${fromId}`)
    await tx.execute(sql`update bindings set group_id = ${intoId} where group_id = ${fromId}`)
    await rewriteJson(tx, fromId, intoId)

    await tx.execute(sql`delete from groups where id = ${fromId}`)
    await tx.execute(sql`update groups set updated_at = now() where id = ${intoId}`)
    return getGroup(tx, intoId)
  })
}
