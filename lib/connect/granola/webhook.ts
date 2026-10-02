/*
 * One delivery from Granola, from raw request to filed note. The Route Handler
 * is a thin shell around this, so the rules can be tested against the database
 * without a server.
 *
 * Verified before it is parsed: the signature covers the bytes that arrived,
 * and nothing unauthenticated is worth running a parser over.
 *
 * Matched to an account by verifying it. Each account's secret is tried, and
 * the one that verifies is the identification; nothing in the payload is
 * trusted to say whose it is.
 *
 * Claimed before the work is done (`integration_events`), so a delivery sent
 * twice is answered the second time having done nothing.
 *
 * The payload needs to carry a note id and nothing else. Granola's spec does
 * not describe the body, so the id is looked for in the places it could be and
 * the note is then read from the API. A payload shape guessed wrong costs a
 * wait for the reconcile job, never a wrong note on a meeting.
 */

import type { Executor } from '../../core/types'
import { ConnectionError } from '../connections'
import { GranolaApiError } from './client'
import { signingSecrets } from './connection'
import {
  claimDelivery,
  completeDelivery,
  granolaActor,
  ingestNoteById,
  type IngestOutcome,
} from './ingest'
import { signatureHeaders, verifyDelivery } from './signature'

export type DeliveryResult = {
  status: number
  body: Record<string, unknown>
  /** A run was queued: the caller kicks the processing job. */
  queued: boolean
}

const refuse = (status: number, error: string): DeliveryResult => ({
  status,
  body: { error },
  queued: false,
})

export async function receiveDelivery(
  exec: Executor,
  request: { headers: Headers; body: string },
  now: Date = new Date(),
): Promise<DeliveryResult> {
  const headers = signatureHeaders(request.headers)

  const secrets = await signingSecrets(exec)
  /* 404, not 401: with no secret held there is nothing here to be
     unauthorised against. */
  if (secrets.length === 0) return refuse(404, 'No Granola webhook is set up.')

  let verified: { connectionId: string; deliveryId: string } | null = null
  let refusal = ''
  for (const { connectionId, secret } of secrets) {
    const result = verifyDelivery(headers, request.body, secret, now)
    if (result.ok) {
      verified = { connectionId, deliveryId: result.id }
      break
    }
    refusal = result.detail
  }
  /* Not stored: a row per unverified POST is a table anyone who knows the URL
     could fill. */
  if (!verified) return refuse(401, refusal)

  const payload = parseJson(request.body)
  const type = (payload && readString(payload, ['type', 'event', 'event_type'])) ?? 'unknown'
  const noteId = readNoteId(payload)

  const { event, fresh } = await claimDelivery(exec, {
    externalId: verified.deliveryId,
    type,
    payload: payload ?? { unparsed: request.body.slice(0, 4000) },
  })
  if (!fresh) return { status: 200, body: { ok: true, replay: true }, queued: false }

  if (!noteId) {
    await completeDelivery(exec, event.id, { ignored: 'The delivery named no note.' })
    return { status: 200, body: { ok: true, outcome: 'ignored' }, queued: false }
  }

  let outcome: IngestOutcome
  try {
    outcome = await ingestNoteById(exec, granolaActor('webhook'), verified.connectionId, noteId)
  } catch (err) {
    /* Recorded as failed, which is what lets a redelivery of the same id run
       again. Granola is asked to redeliver only when that could help: its own
       API was busy or down. Anything else waits for the reconcile job. */
    const expected = err instanceof GranolaApiError || err instanceof ConnectionError
    await completeDelivery(exec, event.id, {
      failed: expected ? err.message : 'The note could not be filed.',
    })
    if (!expected) console.error('[granola] delivery failed:', err)
    const retry = err instanceof GranolaApiError && err.retryable
    return { status: retry ? 503 : 200, body: { ok: false, deferred: true }, queued: false }
  }

  await completeDelivery(exec, event.id, outcome)
  return {
    status: 200,
    body: { ok: true, outcome: outcome.kind },
    queued: outcome.kind === 'filed' && outcome.queued,
  }
}

function parseJson(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/* `not_` and 14 alphanumerics is the pattern Granola's spec pins on every note
   id. The last resort is that pattern over the whole payload, which can fail
   to find an id but cannot produce a wrong one: what it finds is then asked of
   Granola. */
const NOTE_ID = /\bnot_[a-zA-Z0-9]{14}\b/

function readNoteId(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null

  const direct = readString(payload, ['note_id', 'noteId', 'id'])
  if (direct && NOTE_ID.test(direct)) return direct

  const data = payload.data ?? payload.note ?? payload.object
  if (data && typeof data === 'object') {
    const nested = readString(data as Record<string, unknown>, ['note_id', 'noteId', 'id'])
    if (nested && NOTE_ID.test(nested)) return nested
  }

  return JSON.stringify(payload).match(NOTE_ID)?.[0] ?? null
}

function readString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}
