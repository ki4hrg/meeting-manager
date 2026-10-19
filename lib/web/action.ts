/*
 * The shape every server action in the app shares.
 *
 * A server action is a public endpoint whatever page it is called from, so
 * each one authenticates here rather than relying on the layout. A refusal the
 * domain layer can explain goes back as `error` for the form to show; anything
 * else is a bug and is thrown.
 */

import { revalidatePath } from 'next/cache'
import { after } from 'next/server'
import { requireUser, type AuthUser } from '../auth/guards'
import { AppError, ValidationError, type ActorContext, type Executor } from '../core/types'
import { createNamed } from '../directory/create'
import { NoMatchError, resolveParty, resolvePerson } from '../directory/resolve'
import type { PartyRef, ReportTo } from '../items/items'
import { syncTodoistSoon } from '../jobs'
import { webActor } from './context'

/** `undoId` names what an Undo on the toast would put back (see `IconAction`). */
export type ActionResult = { error?: string; undoId?: string }

export async function act(
  work: (actor: ActorContext, user: AuthUser) => Promise<void | { undoId: string }>,
): Promise<ActionResult> {
  const user = await requireUser()

  let done: void | { undoId: string }
  try {
    done = await work(webActor(user), user)
  } catch (err) {
    if (err instanceof AppError) return { error: err.message }
    // An id that is not a uuid never matched anything; say so rather than 500.
    if (isInvalidUuid(err)) return { error: 'That no longer exists.' }
    throw err
  }

  // One user and small pages: refreshing everything is simpler than tracking
  // which lists an item appears in.
  revalidatePath('/', 'layout')
  /* Whatever changed may be an item with a task; the sync finds out cheaply
     when nothing is. */
  after(syncTodoistSoon)
  return done ? { undoId: done.undoId } : {}
}

/* 22P02 is invalid_text_representation, which is what Postgres answers when a
   uuid column is compared with something that is not one. */
function isInvalidUuid(err: unknown): boolean {
  let current: unknown = err
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if ((current as Error & { code?: string }).code === '22P02') return true
    current = current.cause
  }
  return false
}

export function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? '').trim()
}

/** `person:<id>` or `group:<id>`, as the party selects submit it. */
export function partyRef(value: string): PartyRef | null {
  if (value === '') return null
  const [type, id] = value.split(':')
  if (type === 'person' && id) return { personId: id }
  if (type === 'group' && id) return { groupId: id }
  throw new ValidationError('Pick a person or a group.')
}

/**
 * Who a picker submits under `name`: `person:<id>` (or a bare id),
 * `group:<id>`, and `new-person:<name>` / `new-group:<name>` for one to add
 * to the directory now (`new:<name>` is an older spelling of a new person).
 * A new one is made through `createNamed`, so a name already taken is refused.
 *
 * Whatever was typed and not picked (`<name>Text`) is looked up by name. When
 * the picker offers new names (`<name>New`), a typed name that matches nobody
 * becomes a new person, the same as picking it; otherwise it is refused.
 *
 * With a `contextId` the picker takes groups, made and found in that context;
 * without one it takes people only.
 */
export async function pickedParties(
  exec: Executor,
  formData: FormData,
  name: string,
  contextId: string | null,
): Promise<{ people: string[]; groups: string[] }> {
  const people: string[] = []
  const groups: string[] = []
  const noGroups = () => new ValidationError('Pick a person.')
  /* A person belongs to no context; `createNamed` only needs one for a group. */
  const make = async (kind: 'person' | 'group', named: string) => {
    if (kind === 'group' && !contextId) throw noGroups()
    return (await createNamed(exec, contextId ?? '', kind, named)).id
  }

  for (const value of formData.getAll(name).map(String).filter(Boolean)) {
    const fresh = NEW_VALUE.exec(value)
    if (fresh) {
      const kind = fresh[1] === 'group' ? 'group' : 'person'
      ;(kind === 'group' ? groups : people).push(await make(kind, fresh[2]!))
    } else if (value.startsWith('series:')) {
      // A series rides in a Report to picker; `pickedReportTo` reads it.
      continue
    } else if (value.startsWith('group:')) {
      if (!contextId) throw noGroups()
      groups.push(value.slice(6))
    } else {
      people.push(value.replace(/^person:/, ''))
    }
  }

  const offersNew = formData.get(`${name}New`) !== null
  for (const raw of field(formData, `${name}Text`).split(',')) {
    const typed = raw.trim()
    if (typed === '') continue
    try {
      if (contextId) {
        const found = await resolveParty(exec, contextId, typed)
        ;(found.type === 'group' ? groups : people).push(found.id)
      } else {
        people.push((await resolvePerson(exec, typed)).id)
      }
    } catch (err) {
      if (!(offersNew && err instanceof NoMatchError)) throw err
      people.push(await make('person', typed.replace(/^@/, '')))
    }
  }
  return { people: [...new Set(people)], groups: [...new Set(groups)] }
}

/** `new-person:<name>`, `new-group:<name>`, or the older `new:<name>` for a person. */
const NEW_VALUE = /^new(?:-(person|group))?:(.*)$/s

/** The people a picker that takes no groups submits under `name` (see `pickedParties`). */
export async function pickedPeople(exec: Executor, formData: FormData, name: string): Promise<string[]> {
  return (await pickedParties(exec, formData, name, null)).people
}

/**
 * The one a Report to picker names, in the item's context: a person or a
 * group (a new one made now, as `pickedParties` does), or `series:<id>`,
 * whose next meeting raises it.
 */
export async function pickedReportTo(
  exec: Executor,
  formData: FormData,
  name: string,
  contextId: string,
): Promise<ReportTo | null> {
  const series = formData
    .getAll(name)
    .map(String)
    .filter((value) => value.startsWith('series:'))
    .map((value) => ({ seriesId: value.slice(7) }))
  const { people, groups } = await pickedParties(exec, formData, name, contextId)
  const picked: ReportTo[] = [
    ...people.map((personId) => ({ personId })),
    ...groups.map((groupId) => ({ groupId })),
    ...series,
  ]
  if (picked.length > 1) throw new ValidationError('Report to one at a time.')
  return picked[0] ?? null
}
