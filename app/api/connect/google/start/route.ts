/*
 * GET /api/connect/google/start — send John to Google to connect an account.
 *
 * Reached by a link on /settings, so every refusal is a redirect to a page
 * rather than a JSON body nobody would read.
 */

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth/guards'
import { googleConfigured } from '@/lib/connect/connections'
import { STATE_COOKIE, googleOAuthAuthorizationUrl } from '@/lib/connect/google/oauth'
import { absoluteUrl } from '@/lib/oauth/config'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(): Promise<Response> {
  if (!(await getCurrentUser())) return NextResponse.redirect(absoluteUrl('/login'))

  const clientId = process.env.GOOGLE_CLIENT_ID
  if (!clientId || !googleConfigured()) {
    const params = new URLSearchParams({ error: 'Google is not configured.' })
    return NextResponse.redirect(`${absoluteUrl('/settings')}?${params}`)
  }

  const { url, state } = googleOAuthAuthorizationUrl('', clientId, {
    redirectUri: absoluteUrl('/api/connect/google/callback'),
  })

  /* The state rides in a cookie only this browser holds; the callback refuses
     a state that does not match it. Lax, because the way back from Google is a
     top-level navigation from another site. */
  const response = NextResponse.redirect(url)
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 10 * 60,
    path: '/',
  })
  return response
}
