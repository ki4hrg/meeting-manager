/*
 * The shape every server action in the app shares.
 *
 * A server action is a public endpoint whatever page it is called from, so
 * each one authenticates here rather than relying on the layout. A refusal the
 * domain layer can explain goes back as `error` for the form to show; anything
 * else is a bug and is thrown.
 */

import { revalidatePath } from 'next/cache'
import { requireUser, type AuthUser } from '../auth/guards'
import { AppError, ValidationError, type ActorContext } from '../core/types'
import type { PartyRef } from '../items/items'
import { webActor } from './context'

export type ActionResult = { error?: string }

export async function act(
  work: (actor: ActorContext, user: AuthUser) => Promise<void>,
): Promise<ActionResult> {
  const user = await requireUser()

  try {
    await work(webActor(user), user)
  } catch (err) {
    if (err instanceof AppError) return { error: err.message }
    // An id that is not a uuid never matched anything; say so rather than 500.
    if (isInvalidUuid(err)) return { error: 'That no longer exists.' }
    throw err
  }

  // One user and small pages: refreshing everything is simpler than tracking
  // which lists an item appears in.
  revalidatePath('/', 'layout')
  return {}
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
