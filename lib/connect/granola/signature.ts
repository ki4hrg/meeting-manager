/*
 * Standard Webhooks verification, and nothing else. Lifted from Meeter.
 *
 * Its own file with no database import, because `/api/webhooks/granola` is a
 * public endpoint carrying meeting content and this is all that stands between
 * it and anybody who knows the URL. Granola names the scheme (Standard
 * Webhooks, HMAC-SHA256, secret shown once when the endpoint is created):
 *
 *   - `webhook-id`: the sender's id for this delivery, not for the note.
 *   - `webhook-timestamp`: unix seconds.
 *   - `webhook-signature`: space-delimited `v1,<base64>` entries; several while
 *     a secret is being rotated.
 *   - The signed content is `${id}.${timestamp}.${body}`, the body exactly as
 *     it arrived. Parsing and re-serialising it changes the bytes, which is why
 *     the route reads `request.text()` and verifies before it parses.
 *   - The secret is `whsec_` + base64; the prefix is not part of the key.
 *
 * A missing header is a refusal, not a pass. A timestamp more than five
 * minutes from now, either way, is a refusal, or a captured delivery could be
 * replayed forever. The comparison is constant-time over equal lengths. The
 * `svix-` header names are accepted because senders still emit them.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/** The scheme's own tolerance, either side of now. */
export const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000

export type SignatureHeaders = {
  id: string | null
  timestamp: string | null
  signature: string | null
}

export type VerificationResult =
  | { ok: true; id: string; timestamp: Date }
  /* A refusal says which of the four it was. */
  | { ok: false; reason: 'unsigned' | 'malformed' | 'stale' | 'mismatch'; detail: string }

/** Both spellings, so a sender using either is understood. */
export function signatureHeaders(headers: Headers): SignatureHeaders {
  const pick = (name: string) => headers.get(`webhook-${name}`) ?? headers.get(`svix-${name}`)
  return { id: pick('id'), timestamp: pick('timestamp'), signature: pick('signature') }
}

/**
 * Whether this delivery really came from the holder of this secret.
 *
 * `body` must be the raw request text. Anything that has been through
 * `JSON.parse` has lost the byte sequence that was signed.
 */
export function verifyDelivery(
  headers: SignatureHeaders,
  body: string,
  secret: string,
  now: Date = new Date(),
): VerificationResult {
  const { id, timestamp, signature } = headers

  if (!id || !timestamp || !signature) {
    return {
      ok: false,
      reason: 'unsigned',
      detail: 'The delivery carried no webhook-id, webhook-timestamp and webhook-signature.',
    }
  }

  const seconds = Number(timestamp)
  if (!Number.isFinite(seconds)) {
    return { ok: false, reason: 'malformed', detail: 'webhook-timestamp is not a number.' }
  }

  const sentAt = new Date(seconds * 1000)
  const drift = Math.abs(now.getTime() - sentAt.getTime())
  if (drift > TIMESTAMP_TOLERANCE_MS) {
    return {
      ok: false,
      reason: 'stale',
      detail: `webhook-timestamp is ${Math.round(drift / 1000)}s away from now, outside the ${
        TIMESTAMP_TOLERANCE_MS / 1000
      }s window.`,
    }
  }

  const key = secretBytes(secret)
  if (!key) {
    return { ok: false, reason: 'malformed', detail: 'The stored signing secret is not usable.' }
  }

  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest()

  /* Several signatures travel together while a secret is being rotated, so any
     one of them matching is a match. */
  for (const entry of signature.split(' ')) {
    const [version, value] = entry.split(',', 2)
    if (version !== 'v1' || !value) continue
    if (equals(expected, Buffer.from(value, 'base64'))) return { ok: true, id, timestamp: sentAt }
  }

  return {
    ok: false,
    reason: 'mismatch',
    detail: 'No signature on the delivery matched this endpoint’s secret.',
  }
}

/** `whsec_`-prefixed base64, or bare base64 from a sender that omits it. */
function secretBytes(secret: string): Buffer | null {
  const trimmed = secret.trim()
  if (!trimmed) return null
  const raw = trimmed.startsWith('whsec_') ? trimmed.slice('whsec_'.length) : trimmed
  const bytes = Buffer.from(raw, 'base64')
  return bytes.length > 0 ? bytes : null
}

/* Length first: `timingSafeEqual` throws on a mismatch, and a throw is itself
   an observably different path. */
function equals(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** The signature a sender would send. For the tests, which must not implement the scheme a second time. */
export function signDelivery(id: string, timestamp: Date, body: string, secret: string): string {
  const key = secretBytes(secret)
  if (!key) throw new Error('The signing secret is not usable.')
  const seconds = Math.floor(timestamp.getTime() / 1000)
  const mac = createHmac('sha256', key).update(`${id}.${seconds}.${body}`).digest('base64')
  return `v1,${mac}`
}
