/* The Google clients against a stubbed `fetch`: what is asked for, and what is
   made of the answers Google actually gives. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ConnectionError,
  GoogleUnauthorized,
  googleListCalendars,
  googleRefreshToken,
} from '../lib/connect/connections'
import { fetchGoogleCalendarEvents } from '../lib/connect/google/calendar'
import {
  CALENDAR_SCOPE,
  exchangeGoogleAuthCode,
  googleOAuthAuthorizationUrl,
  grantedScopes,
  parseJwt,
  stateMatches,
} from '../lib/connect/google/oauth'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/* Answers each request from a queue and keeps the URLs that were asked for. */
function stubFetch(...answers: Response[]) {
  const asked: URL[] = []
  vi.stubGlobal('fetch', async (input: string | URL) => {
    asked.push(new URL(String(input)))
    const answer = answers.shift()
    if (!answer) throw new Error('unexpected request')
    return answer
  })
  return asked
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.GOOGLE_CLIENT_ID
  delete process.env.GOOGLE_CLIENT_SECRET
})

const range = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-31T00:00:00Z') }

describe('events.list', () => {
  it('follows nextPageToken to the last page', async () => {
    const asked = stubFetch(
      json({ items: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'page-2' }),
      json({ items: [{ id: 'c' }], nextPageToken: 'page-3' }),
      json({ items: [{ id: 'd' }] }),
    )

    const events = await fetchGoogleCalendarEvents('token', 'team@group.calendar.google.com', range)

    expect(events.map((event) => event.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(asked.map((url) => url.searchParams.get('pageToken'))).toEqual([null, 'page-2', 'page-3'])
    expect(asked[0]!.pathname).toBe('/calendar/v3/calendars/team%40group.calendar.google.com/events')
    expect(asked[0]!.searchParams.get('singleEvents')).toBe('true')
    expect(asked[2]!.searchParams.get('timeMin')).toBe('2026-10-01T00:00:00.000Z')
  })

  it('reports a 401 as a token to refresh, not as a failure of the calendar', async () => {
    stubFetch(json({ error: { code: 401, message: 'Invalid Credentials' } }, 401))
    await expect(fetchGoogleCalendarEvents('token', 'cal', range)).rejects.toBeInstanceOf(GoogleUnauthorized)
    stubFetch(json({ error: { code: 401, message: 'Invalid Credentials' } }, 401))
    await expect(googleListCalendars('token')).rejects.toBeInstanceOf(GoogleUnauthorized)
  })

  it("fails with Google's reason", async () => {
    stubFetch(json({ error: { code: 404, message: 'Not Found' } }, 404))
    await expect(fetchGoogleCalendarEvents('token', 'gone', range)).rejects.toThrow('Not Found')
  })
})

describe('calendarList.list', () => {
  it('pages, skips deleted entries and puts the primary first', async () => {
    const asked = stubFetch(
      json({
        items: [
          { id: 'z@group', summary: 'Zebra' },
          { id: 'old@group', summary: 'Old', deleted: true },
          { summary: 'No id' },
        ],
        nextPageToken: 'next',
      }),
      json({
        items: [
          { id: 'john@example.com', summary: 'john@example.com', primary: true },
          { id: 'a@group', summary: 'Their name', summaryOverride: 'Staff' },
        ],
      }),
    )

    expect(await googleListCalendars('token')).toEqual([
      { id: 'john@example.com', name: 'john@example.com', primary: true },
      { id: 'a@group', name: 'Staff', primary: false },
      { id: 'z@group', name: 'Zebra', primary: false },
    ])
    expect(asked[1]!.searchParams.get('pageToken')).toBe('next')
  })
})

describe('token refresh', () => {
  it('reads a refresh response, which carries no refresh token', async () => {
    process.env.GOOGLE_CLIENT_ID = 'id'
    process.env.GOOGLE_CLIENT_SECRET = 'secret'
    stubFetch(json({ access_token: 'fresh', expires_in: 3599 }))

    const tokens = await googleRefreshToken('refresh')
    expect(tokens.accessToken).toBe('fresh')
    expect(tokens.refreshToken).toBeNull()
    expect(tokens.expiresAt).toBeGreaterThan(Date.now() + 3000_000)
  })

  it('says to connect again when the grant is gone', async () => {
    process.env.GOOGLE_CLIENT_ID = 'id'
    process.env.GOOGLE_CLIENT_SECRET = 'secret'
    stubFetch(json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400))

    const refusal = await googleRefreshToken('refresh').catch((err) => err)
    expect(refusal).toBeInstanceOf(ConnectionError)
    expect(refusal.message).toContain('expired or revoked')
    expect(refusal.message).toContain('Connect this account again')
  })
})

describe('oauth', () => {
  it('asks for offline calendar access and sends the callback', () => {
    const { url, state } = googleOAuthAuthorizationUrl('https://meetings.example.test', 'client-id')
    const params = new URL(url).searchParams

    expect(new URL(url).origin).toBe('https://accounts.google.com')
    expect(params.get('redirect_uri')).toBe('https://meetings.example.test/api/connect/google/callback')
    expect(params.get('scope')).toContain(CALENDAR_SCOPE)
    expect(params.get('access_type')).toBe('offline')
    expect(params.get('state')).toBe(state)
    expect(state).toMatch(/^[0-9a-f]{32}$/)
  })

  it('matches a state only against the one it stored', () => {
    expect(stateMatches('abc', 'abc')).toBe(true)
    expect(stateMatches('abc', 'abd')).toBe(false)
    expect(stateMatches('abc', 'abcd')).toBe(false)
    expect(stateMatches('abc', undefined)).toBe(false)
    expect(stateMatches(null, 'abc')).toBe(false)
    expect(stateMatches('', '')).toBe(false)
  })

  it('reads the scopes that were granted, not the ones asked for', () => {
    expect(grantedScopes({ scope: `openid ${CALENDAR_SCOPE}` })).toContain(CALENDAR_SCOPE)
    expect(grantedScopes({ scope: 'openid https://www.googleapis.com/auth/userinfo.email' })).not.toContain(
      CALENDAR_SCOPE,
    )
    expect(grantedScopes({})).toEqual([])
  })

  it('reads a base64url id_token payload', () => {
    // '~~~' encodes to 'fn5-' in base64url ('fn5+' in base64).
    const payload = Buffer.from(JSON.stringify({ email: 'john@example.com', note: '~~~' })).toString('base64url')
    expect(parseJwt(`header.${payload}.signature`).email).toBe('john@example.com')
  })

  it("fails a code exchange with Google's reason", async () => {
    stubFetch(json({ error: 'invalid_grant', error_description: 'Bad Request' }, 400))
    await expect(exchangeGoogleAuthCode('code', 'id', 'secret', 'https://x/cb')).rejects.toThrow('Bad Request')
  })
})
