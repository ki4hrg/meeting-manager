/*
 * The ledger of deliveries from outside services (`integration_events`): each
 * is claimed by the service's own delivery id before any work is done, so a
 * delivery sent twice is recognised the second time.
 */

import { and, eq } from 'drizzle-orm'
import type { Executor } from '../core/types'
import { integrationEvents } from '../db/schema'

export type IntegrationEvent = typeof integrationEvents.$inferSelect

/**
 * Claim a delivery by its id, or learn that it was claimed before.
 *
 * The insert is the claim: a select followed by an insert leaves a gap exactly
 * wide enough for the duplicate this table exists to stop. `fresh` is false
 * for a repeat, with one exception: a delivery whose first attempt failed is
 * handed out again, once, to whoever asks first.
 */
export async function claimDelivery(
  exec: Executor,
  provider: string,
  input: { externalId: string; type: string; payload: unknown },
): Promise<{ event: IntegrationEvent; fresh: boolean }> {
  const [inserted] = await exec
    .insert(integrationEvents)
    .values({
      provider,
      externalId: input.externalId,
      type: input.type,
      payload: (input.payload ?? {}) as object,
    })
    .onConflictDoNothing({ target: [integrationEvents.provider, integrationEvents.externalId] })
    .returning()
  if (inserted) return { event: inserted, fresh: true }

  const [retried] = await exec
    .update(integrationEvents)
    .set({ status: 'received', detail: null, processedAt: null })
    .where(
      and(
        eq(integrationEvents.provider, provider),
        eq(integrationEvents.externalId, input.externalId),
        eq(integrationEvents.status, 'failed'),
      ),
    )
    .returning()
  if (retried) return { event: retried, fresh: true }

  const [existing] = await exec
    .select()
    .from(integrationEvents)
    .where(
      and(eq(integrationEvents.provider, provider), eq(integrationEvents.externalId, input.externalId)),
    )
    .limit(1)
  return { event: existing!, fresh: false }
}

/** Say how a claimed delivery ended. */
export async function settleDelivery(
  exec: Executor,
  eventId: string,
  status: 'processed' | 'ignored' | 'failed',
  detail: string,
): Promise<void> {
  await exec
    .update(integrationEvents)
    .set({ status, detail: detail.slice(0, 500), processedAt: new Date() })
    .where(eq(integrationEvents.id, eventId))
}
