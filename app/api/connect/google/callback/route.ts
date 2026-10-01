/*
 * GET /api/connect/google/callback — where Google sends John back.
 *
 * Exchanges the code for tokens, stores the connection, and returns to
 * /settings. Every outcome is a redirect there: `?connected=google`, or
 * `?error=` with something he can read.
 */

import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth/guards'
import { clearFeedCache } from '@/lib/calendar/feed'
import { saveGoogleConnection } from '@/lib/connect/connections'
import {
  CALENDAR_SCOPE,
  STATE_COOKIE,
  exchangeGoogleAuthCode,
  getAccountEmailFromIdToken,
  grantedScopes,
  stateMatches,
} from '@/lib/connect/google/oauth'
import { db } from '@/lib/db'
import { absoluteUrl } from '@/lib/oauth/config'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/* The state is single-use: whatever happened, the cookie goes. */
function back(params: Record<string, string>): Response {
  const response = NextResponse.redirect(`${absoluteUrl('/settings')}?${new URLSearchParams(params)}`)
  response.cookies.delete(STATE_COOKIE)
  return response
}

const refused = (message: string) => back({ error: message.slice(0, 200) })

export async function GET(request: Request): Promise<Response> {
  if (!(await getCurrentUser())) return NextResponse.redirect(absoluteUrl('/login'))

  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const error = url.searchParams.get('error')
  const stored = (await cookies()).get(STATE_COOKIE)?.value

  /* Checked before anything else in the request is believed, the error
     included: a callback this browser did not start is not Google answering. */
  if (!stateMatches(url.searchParams.get('state'), stored)) {
    return refused(
      error === 'access_denied'
        ? 'Google access was not granted.'
        : 'That sign-in was not started here, or it expired. Try again.',
    )
  }

  if (error) {
    return refused(
      error === 'access_denied'
        ? 'Google access was not granted.'
        : url.searchParams.get('error_description') || error,
    )
  }
  if (!code) return refused('Google sent no authorization code.')

  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) return refused('Google is not configured.')

  try {
    const tokens = await exchangeGoogleAuthCode(
      code,
      clientId,
      clientSecret,
      absoluteUrl('/api/connect/google/callback'),
    )

    /* The consent screen lets the calendar box be left unticked. A connection
       that cannot read calendars would only fail later, less clearly. */
    const scopes = grantedScopes(tokens)
    if (!scopes.includes(CALENDAR_SCOPE)) {
      return refused('Calendar access was not granted. Connect again and tick the calendar box.')
    }
    if (!tokens.id_token) return refused('Google did not say which account this is.')

    await saveGoogleConnection(db, {
      account: getAccountEmailFromIdToken(tokens.id_token),
      tokens: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      },
      scopes,
    })
    clearFeedCache()

    return back({ connected: 'google' })
  } catch (err) {
    return refused(err instanceof Error ? err.message : 'Google could not be connected.')
  }
}
