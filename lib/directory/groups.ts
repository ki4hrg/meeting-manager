/* Groups belong to a context and act as parties alongside people. */

import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { NotFoundError, ValidationError, inTransaction, type Executor } from '../core/types'
import { groupEmails, groupMembers, groups, people, personEmails } from '../db/schema'
import { notDeleted, onShelf, shelvedNote, type Shelf } from '../db/shelf'
import { getContext } from './contexts'
import { getPerson } from './people'

export type Group = typeof groups.$inferSelect

export type GroupWithCount = Group & { memberCount: number }

export async function listGroups(
  exec: Executor,
  contextId: string,
  shelf: Shelf = 'live',
): Promise<GroupWithCount[]> {
  return exec
    .select({
      id: groups.id,
      contextId: groups.contextId,
      name: groups.name,
      createdAt: groups.createdAt,
      updatedAt: groups.updatedAt,
      archivedAt: groups.archivedAt,
      deletedAt: groups.deletedAt,
      memberCount: sql<number>`(select count(*)::int from ${groupMembers}
        where ${groupMembers.groupId} = ${groups.id})`,
    })
    .from(groups)
    .where(and(eq(groups.contextId, contextId), onShelf(groups, shelf)))
    .orderBy(sql`lower(${groups.name})`)
}

export async function getGroup(exec: Executor, id: string): Promise<Group> {
  const [row] = await exec
    .select()
    .from(groups)
    .where(and(eq(groups.id, id), notDeleted(groups)))
    .limit(1)
  if (!row) throw new NotFoundError('Group', id)
  return row
}

async function assertNameFree(exec: Executor, contextId: string, name: string, exceptId?: string) {
  const [taken] = await exec
    .select({ id: groups.id, archivedAt: groups.archivedAt, deletedAt: groups.deletedAt })
    .from(groups)
    .where(and(eq(groups.contextId, contextId), sql`lower(${groups.name}) = lower(${name})`))
    .limit(1)
  if (taken && taken.id !== exceptId) {
    throw new ValidationError(`There is already a group called ${name}${shelvedNote(taken)}.`)
  }
}

export async function createGroup(
  exec: Executor,
  input: { contextId: string; name: string },
): Promise<Group> {
  const name = input.name.trim()
  if (name === '') throw new ValidationError('Enter a name.')
  await getContext(exec, input.contextId)
  await assertNameFree(exec, input.contextId, name)

  const [row] = await exec.insert(groups).values({ contextId: input.contextId, name }).returning()
  return row!
}

export async function renameGroup(exec: Executor, id: string, name: string): Promise<Group> {
  const trimmed = name.trim()
  if (trimmed === '') throw new ValidationError('Enter a name.')
  const group = await getGroup(exec, id)
  await assertNameFree(exec, group.contextId, trimmed, id)

  const [row] = await exec
    .update(groups)
    .set({ name: trimmed, updatedAt: new Date() })
    .where(eq(groups.id, id))
    .returning()
  return row!
}

export type Member = { id: string; name: string; isSelf: boolean }

export async function listMembers(exec: Executor, groupId: string): Promise<Member[]> {
  return exec
    .select({ id: people.id, name: people.name, isSelf: people.isSelf })
    .from(groupMembers)
    .innerJoin(people, eq(people.id, groupMembers.personId))
    .where(and(eq(groupMembers.groupId, groupId), notDeleted(people)))
    .orderBy(sql`lower(${people.name})`)
}

/** The live groups in a context that a person is in. */
export async function groupsOf(
  exec: Executor,
  contextId: string,
  personId: string,
): Promise<Array<{ id: string; name: string }>> {
  return exec
    .select({ id: groups.id, name: groups.name })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(and(eq(groupMembers.personId, personId), eq(groups.contextId, contextId), onShelf(groups, 'live')))
    .orderBy(sql`lower(${groups.name})`)
}

export async function addMember(exec: Executor, groupId: string, personId: string): Promise<void> {
  await getGroup(exec, groupId)
  await getPerson(exec, personId)
  await exec.insert(groupMembers).values({ groupId, personId }).onConflictDoNothing()
}

export async function removeMember(
  exec: Executor,
  groupId: string,
  personId: string,
): Promise<void> {
  await exec
    .delete(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.personId, personId)))
}

// ─── addresses ───────────────────────────────────────────────────────────────

/* A distribution list's addresses: an invitee at one brings the group to the
   meeting. An address is on one person or one group, never both. */

function cleanEmail(value: string): string {
  const email = value.trim().toLowerCase()
  if (email === '') throw new ValidationError('Enter an email address.')
  if (!email.includes('@')) throw new ValidationError('Enter a valid email address.')
  return email
}

export async function listGroupEmails(exec: Executor, groupId: string): Promise<string[]> {
  const rows = await exec
    .select({ email: groupEmails.email })
    .from(groupEmails)
    .where(eq(groupEmails.groupId, groupId))
    .orderBy(asc(groupEmails.createdAt))
  return rows.map((row) => row.email)
}

/** Who holds an address already, person or group, if anyone. */
export async function holderOfEmail(
  exec: Executor,
  email: string,
): Promise<{ type: 'person' | 'group'; id: string; name: string } | null> {
  const [person] = await exec
    .select({ id: people.id, name: people.name })
    .from(personEmails)
    .innerJoin(people, eq(people.id, personEmails.personId))
    .where(sql`lower(${personEmails.email}) = ${email}`)
    .limit(1)
  if (person) return { type: 'person', ...person }
  const [group] = await exec
    .select({ id: groups.id, name: groups.name })
    .from(groupEmails)
    .innerJoin(groups, eq(groups.id, groupEmails.groupId))
    .where(sql`lower(${groupEmails.email}) = ${email}`)
    .limit(1)
  return group ? { type: 'group', ...group } : null
}

export async function addGroupEmail(exec: Executor, groupId: string, value: string): Promise<void> {
  const email = cleanEmail(value)
  await getGroup(exec, groupId)
  const taken = await holderOfEmail(exec, email)
  if (taken) {
    if (taken.type === 'group' && taken.id === groupId) return
    throw new ValidationError(`${email} already belongs to ${taken.name}.`)
  }
  await exec.insert(groupEmails).values({ groupId, email })
}

export async function removeGroupEmail(exec: Executor, groupId: string, value: string): Promise<void> {
  const email = value.trim().toLowerCase()
  await exec
    .delete(groupEmails)
    .where(and(eq(groupEmails.groupId, groupId), sql`lower(${groupEmails.email}) = ${email}`))
}

/** Set a group's addresses to exactly these. */
export async function setGroupEmails(exec: Executor, groupId: string, values: string[]): Promise<void> {
  const emails = [...new Set(values.map(cleanEmail))]
  await inTransaction(exec, async (tx) => {
    for (const email of emails) await addGroupEmail(tx, groupId, email)
    for (const email of await listGroupEmails(tx, groupId)) {
      if (!emails.includes(email.toLowerCase())) await removeGroupEmail(tx, groupId, email)
    }
  })
}

/** The live groups of a context at any of these addresses: who a list on an invite brings. */
export async function groupsByEmail(exec: Executor, contextId: string, emails: string[]): Promise<string[]> {
  const wanted = [...new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean))]
  if (wanted.length === 0) return []
  const rows = await exec
    .select({ id: groups.id })
    .from(groupEmails)
    .innerJoin(groups, eq(groups.id, groupEmails.groupId))
    .where(
      and(
        inArray(sql`lower(${groupEmails.email})`, wanted),
        eq(groups.contextId, contextId),
        onShelf(groups),
      ),
    )
  return [...new Set(rows.map((row) => row.id))]
}

/** Every group address, lower-cased: what is no longer an unknown invitee. */
export async function allGroupEmails(exec: Executor): Promise<Set<string>> {
  const rows = await exec
    .select({ email: groupEmails.email })
    .from(groupEmails)
    .innerJoin(groups, eq(groups.id, groupEmails.groupId))
    .where(notDeleted(groups))
  return new Set(rows.map((row) => row.email.toLowerCase()))
}
