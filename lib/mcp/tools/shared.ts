/* What the domain tools share: the write wrapper, name resolution and the wire shapes. */

import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { inTransaction, type Executor, type Tx } from '@/lib/core/types'
import { todayIn } from '../../core/dates'
import { users } from '../../db/schema'
import { resolveParty } from '../../directory/resolve'
import type { ItemView, PartyInput, PartyRole } from '../../items/items'
import { withIdempotency } from '../idempotency'
import { ToolRefusal, type ToolContext } from './types'

export const idempotencyKey = z
  .string()
  .min(8)
  .max(200)
  .optional()
  .describe(
    'A fresh unique string per logical write. Reuse it only to retry the same call after a ' +
      'timeout: the retry returns the first result instead of writing twice.',
  )

/**
 * Run a write in one transaction. With a key it goes through the receipt
 * table, so a retry is safe; without one it is a plain transaction.
 */
export async function write<T>(
  context: ToolContext,
  tool: string,
  input: { idempotency_key?: string },
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  const { idempotency_key: key, ...args } = input
  if (!key) return inTransaction(context.exec, work)
  return withIdempotency(
    context.exec,
    { clientId: context.actor.clientId, idempotencyKey: key, tool },
    args,
    work,
  )
}

/** The account's time zone (null is the instance's own) and the day it is there. */
export type Clock = { timeZone: string | null; today: string; now: Date }

export async function clockFor(exec: Executor, context: Pick<ToolContext, 'identity'>): Promise<Clock> {
  const [user] = await exec
    .select({ timeZone: users.timeZone })
    .from(users)
    .where(eq(users.id, context.identity.userId))
    .limit(1)
  if (!user) throw new ToolRefusal('That account no longer exists.')
  const now = new Date()
  return { timeZone: user.timeZone, today: todayIn(user.timeZone, now), now }
}

/** Names or ids, each a person anywhere or a group in the context. */
export async function partiesFrom(
  tx: Tx,
  contextId: string,
  refs: { owners?: string[]; with?: string[] },
): Promise<PartyInput[]> {
  const parties: PartyInput[] = []
  const add = async (ref: string, role: PartyRole) => {
    const party = await resolveParty(tx, contextId, ref)
    parties.push(
      party.type === 'person' ? { personId: party.id, role } : { groupId: party.id, role },
    )
  }
  for (const ref of refs.owners ?? []) await add(ref, 'owner')
  for (const ref of refs.with ?? []) await add(ref, 'with')
  return parties
}

export function itemOut(item: ItemView) {
  const party = (role: PartyRole) =>
    item.parties
      .filter((p) => p.role === role)
      .map((p) => ({ type: p.type, id: p.id, name: p.name, ...(p.isSelf ? { is_me: true } : {}) }))

  return {
    id: item.id,
    context_id: item.contextId,
    kind: item.kind,
    status: item.status,
    text: item.text,
    detail: item.detail,
    resolution: item.resolution,
    project: item.project,
    due_on: item.dueOn,
    owners: party('owner'),
    with: party('with'),
    parent_item_id: item.parentItemId,
    superseded_by_item_id: item.supersededByItemId,
    target_meeting_id: item.targetMeetingId,
    target_series_id: item.targetSeriesId,
    target_project_id: item.targetProjectId,
    origin_meeting_id: item.originMeetingId,
    ...(item.ongoing ? { ongoing: true } : {}),
    ...(item.parkedAt
      ? { later: true, later_on: item.laterOn, ...(item.laterUntilItemId ? { later_until_item_id: item.laterUntilItemId } : {}) }
      : {}),
    created_at: item.createdAt.toISOString(),
    closed_at: item.closedAt?.toISOString() ?? null,
  }
}
