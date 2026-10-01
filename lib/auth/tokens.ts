/*
 * Opaque tokens, and the keyed hash they are stored under.
 *
 * Every token in this application — session, OAuth code, OAuth access and
 * refresh, MCP confirmation — is stored as HMAC-SHA256(SESSION_SECRET, token)
 * rather than a bare digest. That is not decoration: it is the only reason
 * the deployment notes can claim that rotating SESSION_SECRET invalidates every
 * session, grant, and pending preview. With a bare SHA-256 the variable would be
 * decorative and the documented rotation would silently do nothing.
 *
 * Connection credentials are NOT keyed on this secret. They use ENCRYPTION_KEY,
 * precisely so that the rotation documented above stays a cheap, ordinary thing
 * to do instead of also destroying every linked Google account.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** 256 bits. base64url so it is cookie-safe. */
export const TOKEN_BYTES = 32

const MIN_SECRET_LENGTH = 32

function secret(): string {
  const value = process.env.SESSION_SECRET
  if (!value || value.length < MIN_SECRET_LENGTH) {
    // Failing loudly at first use beats defaulting to a well-known key, which
    // would make every deployment that forgot the variable silently forgeable.
    throw new Error(
      `SESSION_SECRET must be set and at least ${MIN_SECRET_LENGTH} characters`,
    )
  }
  return value
}

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

export function hashToken(token: string): string {
  return createHmac('sha256', secret()).update(token).digest('base64url')
}

/**
 * Constant-time comparison. Token lookup is by primary key so this is belt and
 * braces, but the one place it matters is comparing a value a caller supplied.
 */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
