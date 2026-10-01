/*
 * What a signed-in page needs to know before it renders: who is looking, and
 * which context they are working in.
 *
 * The selected context is a cookie. It falls back to the first context, so a
 * stale or missing cookie never leaves the app with nothing selected.
 */

import { randomUUID } from 'node:crypto'
import { cache } from 'react'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { requireUser, type AuthUser } from '../auth/guards'
import { todayIn } from '../core/dates'
import type { ActorContext } from '../core/types'
import { db } from '../db'
import { listContexts, type Context } from '../directory/contexts'
import { ensureSelf, type Person } from '../directory/people'

export const CONTEXT_COOKIE = 'mm_context'

export const contextCookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: 365 * 24 * 60 * 60,
} as const

/* Cached per request: the layout and the page under it both ask. */
export const viewer = cache(
  async (): Promise<{ user: AuthUser; self: Person; today: string }> => {
    const user = await requireUser()
    const self = await ensureSelf(db, user)
    // "Today" is John's day, not the server's.
    return { user, self, today: todayIn(user.timeZone) }
  },
)

export const allContexts = cache(async (): Promise<Context[]> => listContexts(db))

export const currentContext = cache(async (): Promise<Context | null> => {
  const contexts = await allContexts()
  const chosen = (await cookies()).get(CONTEXT_COOKIE)?.value
  return contexts.find((context) => context.id === chosen) ?? contexts[0] ?? null
})

/** For pages that list things: with no context yet, the only place to go is the one that makes one. */
export async function requireContext(): Promise<Context> {
  const context = await currentContext()
  if (!context) redirect('/contexts')
  return context
}

export function webActor(user: AuthUser): ActorContext {
  return { userId: user.id, source: 'web', requestId: randomUUID() }
}
