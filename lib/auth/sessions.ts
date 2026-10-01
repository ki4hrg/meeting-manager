/*
 * Server-side sessions.
 *
 * Opaque 256-bit token, keyed-hashed at rest, delivered as an httpOnly cookie.
 * Server-side rather than a stateless JWT so that sessions are revocable.
 */

import { and, eq, gt, isNull } from 'drizzle-orm'
import type { Executor } from '../core/types'
import { db } from '../db'
import { sessions, users } from '../db/schema'
import { generateToken, hashToken } from './tokens'

export const SESSION_COOKIE = 'mm_session'

/** Absolute, not sliding. A stolen cookie expires on a schedule regardless. */
export const SESSION_TTL_DAYS = 30

export type AuthUser = {
  id: string
  email: string
  displayName: string
  timeZone: string | null
}

export type NewSession = { token: string; expiresAt: Date }

export async function createSession(
  userId: string,
  meta: { userAgent?: string | null; ip?: string | null } = {},
  exec: Executor = db,
): Promise<NewSession> {
  const token = generateToken()
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000)

  await exec.insert(sessions).values({
    id: hashToken(token),
    userId,
    expiresAt,
    userAgent: meta.userAgent ?? null,
    ip: meta.ip ?? null,
  })

  // The plaintext token is returned once and never stored.
  return { token, expiresAt }
}

/** Resolve a cookie value to a user, or null. */
export async function resolveSession(
  token: string | undefined,
  exec: Executor = db,
): Promise<AuthUser | null> {
  if (!token) return null

  const id = hashToken(token)
  const [row] = await exec
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      timeZone: users.timeZone,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date()), isNull(users.deletedAt)))
    .limit(1)

  if (!row) return null

  await exec.update(sessions).set({ lastUsedAt: new Date() }).where(eq(sessions.id, id))

  return row
}

export async function revokeSession(token: string, exec: Executor = db): Promise<void> {
  await exec.delete(sessions).where(eq(sessions.id, hashToken(token)))
}

export const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  // Relaxed only for local development, where no proxy terminates TLS.
  secure: process.env.NODE_ENV === 'production',
  path: '/',
}
