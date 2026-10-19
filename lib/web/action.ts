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
import { createPerson } from '../directory/people'
import { resolvePerson } from '../directory/resolve'
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
 * The people a picker submits under `name`: ids, and `new:<name>` for someone
 * to add to the directory now. Whatever was typed and not picked (`<name>Text`)
 * is looked up by name, and refused by name when it finds nobody.
 */
export async function pickedPeople(exec: Executor, formData: FormData, name: string): Promise<string[]> {
  const ids: string[] = []
  for (const value of formData.getAll(name).map(String).filter(Boolean)) {
    // Groups and series ride in the same picker; read on their own.
    if (value.startsWith('group:') || value.startsWith('series:')) continue
    if (value.startsWith('new:')) ids.push((await createPerson(exec, { name: value.slice(4) })).id)
    else ids.push(value.replace(/^person:/, ''))
  }
  for (const typed of field(formData, `${name}Text`).split(',')) {
    if (typed.trim()) ids.push((await resolvePerson(exec, typed.trim())).id)
  }
  return [...new Set(ids)]
}

/** The groups a picker submits under `name`, as `group:<id>`, among its people. */
export function pickedGroups(formData: FormData, name: string): string[] {
  return [
    ...new Set(
      formData
        .getAll(name)
        .map(String)
        .filter((value) => value.startsWith('group:'))
        .map((value) => value.slice(6)),
    ),
  ]
}

/**
 * The one a Report to picker names: a person (a new one added to the
 * directory now), a group, or `series:<id>`, whose next meeting raises it.
 */
export async function pickedReportTo(exec: Executor, formData: FormData, name: string): Promise<ReportTo | null> {
  const series = formData
    .getAll(name)
    .map(String)
    .filter((value) => value.startsWith('series:'))
    .map((value) => ({ seriesId: value.slice(7) }))
  const groups = pickedGroups(formData, name).map((groupId) => ({ groupId }))
  const people = (await pickedPeople(exec, formData, name)).map((personId) => ({ personId }))
  const picked: ReportTo[] = [...people, ...groups, ...series]
  if (picked.length > 1) throw new ValidationError('Report to one at a time.')
  return picked[0] ?? null
}
