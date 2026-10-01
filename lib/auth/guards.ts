/*
 * The guards.
 *
 * `app/(app)/` is authenticated by placement: its layout calls requireUser(),
 * so a new page under it is safe by default. `app/api/` is not; every handler
 * there authenticates explicitly.
 *
 * Page guards redirect; API guards return a response, because a redirect is
 * the wrong answer to a fetch.
 */

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { SESSION_COOKIE, resolveSession, type AuthUser } from './sessions'
import { needsSetup } from './users'

export type { AuthUser }

/** The current user, or null. Never redirects. */
export async function getCurrentUser(): Promise<AuthUser | null> {
  const jar = await cookies()
  return resolveSession(jar.get(SESSION_COOKIE)?.value)
}

/** For pages and layouts. An instance with no account goes to /setup, not a login nobody can satisfy. */
export async function requireUser(): Promise<AuthUser> {
  const user = await getCurrentUser()
  if (user) return user

  if (await needsSetup()) redirect('/setup')
  redirect('/login')
}

export type ApiAuth = { user: AuthUser } | { response: Response }

/** For Route Handlers under app/api/. Returns a 401 rather than redirecting. */
export async function requireApiUser(): Promise<ApiAuth> {
  const user = await getCurrentUser()
  if (user) return { user }
  return { response: Response.json({ error: 'authentication required' }, { status: 401 }) }
}
