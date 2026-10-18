/*
 * GET /api/connect/todoist/start — send John to Todoist to connect his account.
 *
 * Reached by a link on /settings, so every refusal is a redirect there.
 * Completing this with his own account is also what turns the app's webhook
 * on for him.
 */

import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth/guards'
import { authorizeUrl } from '@/lib/connect/todoist/client'
import { CALLBACK_PATH, STATE_COOKIE, todoistApp } from '@/lib/connect/todoist/connection'
import { absoluteUrl } from '@/lib/oauth/config'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(): Promise<Response> {
  if (!(await getCurrentUser())) return NextResponse.redirect(absoluteUrl('/login'))

  const app = todoistApp()
  if (!app) {
    const params = new URLSearchParams({ error: 'Todoist is not configured.' })
    return NextResponse.redirect(`${absoluteUrl('/settings')}?${params}`)
  }

  const state = randomBytes(16).toString('hex')
  /* The state rides in a cookie only this browser holds; the callback refuses
     a state that does not match it. Lax, because the way back from Todoist is
     a top-level navigation from another site. */
  const response = NextResponse.redirect(authorizeUrl(app.clientId, state, absoluteUrl(CALLBACK_PATH)))
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 10 * 60,
    path: '/',
  })
  return response
}
