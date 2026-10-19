/*
 * One delivery from Todoist's webhook, from raw request to a kicked sync. The
 * Route Handler is a thin shell around this.
 *
 * Todoist says its deliveries can arrive late, out of order, or not at all,
 * and are to be used as notifications rather than data. So a delivery only
 * says "look now": the sync reads the change feed as it always does, and the
 * payload is kept for looking at, never merged.
 *
 * Verified before it is parsed: the signature (HMAC-SHA256 of the raw body,
 * keyed with the app's client secret) covers the bytes as they arrived.
 * Claimed by its delivery id, so a redelivery is answered having done nothing.
 */

import { createHash } from 'node:crypto'
import type { Executor } from '../../core/types'
import { claimDelivery, settleDelivery } from '../deliveries'
import { verifyWebhook } from './client'
import { TODOIST, todoistApp, todoistConnection } from './connection'

export type TodoistDeliveryResult = {
  status: number
  body: Record<string, unknown>
  /** A task or its comments changed: the caller kicks the sync. */
  sync: boolean
}

const answer = (status: number, body: Record<string, unknown>, sync = false): TodoistDeliveryResult => ({
  status,
  body,
  sync,
})

export async function receiveTodoistDelivery(
  exec: Executor,
  request: { headers: Headers; body: string },
): Promise<TodoistDeliveryResult> {
  const app = todoistApp()
  if (!app) return answer(404, { error: 'Todoist is not set up.' })

  /* Not stored: a row per unverified POST is a table anyone who knows the URL
     could fill. */
  if (!verifyWebhook(request.body, request.headers.get('x-todoist-hmac-sha256'), app.clientSecret)) {
    return answer(401, { error: 'The signature does not match.' })
  }

  let payload: Record<string, unknown> | null = null
  try {
    const parsed: unknown = JSON.parse(request.body)
    if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>
  } catch {
    // Kept unparsed below.
  }
  const type = typeof payload?.event_name === 'string' ? payload.event_name : 'unknown'

  /* Todoist redelivers a failed delivery under the same id. */
  const deliveryId =
    request.headers.get('x-todoist-delivery-id')?.trim() ||
    createHash('sha256').update(request.body).digest('hex')

  const { event, fresh } = await claimDelivery(exec, TODOIST, {
    externalId: deliveryId,
    type,
    payload: payload ?? { unparsed: request.body.slice(0, 4000) },
  })
  if (!fresh) return answer(200, { ok: true, replay: true })

  if (!(await todoistConnection(exec))) {
    await settleDelivery(exec, event.id, 'ignored', 'Todoist is not connected.')
    return answer(200, { ok: true, outcome: 'ignored' })
  }
  /* A task, or a comment on one. */
  if (!type.startsWith('item:') && !type.startsWith('note:')) {
    await settleDelivery(exec, event.id, 'ignored', 'Not a task.')
    return answer(200, { ok: true, outcome: 'ignored' })
  }

  await settleDelivery(exec, event.id, 'processed', 'Sync asked for.')
  return answer(200, { ok: true }, true)
}
