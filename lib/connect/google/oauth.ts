/*
 * Google's OAuth authorization-code flow with offline access: `start` sends
 * John to Google, `callback` exchanges the code and stores the connection.
 *
 * Lifted and trimmed from ../Meeter/lib/connect/google/oauth.ts.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { googleErrorDetail } from '../connections'

export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'

/** The cookie that carries the state from `start` to `callback`. */
export const STATE_COOKIE = 'google_oauth_state'

export function googleOAuthAuthorizationUrl(
  baseUrl: string,
  clientId: string,
  {
    redirectUri = `${baseUrl}/api/connect/google/callback`,
  }: {
    redirectUri?: string
  } = {},
): { url: string; state: string } {
  const state = randomBytes(16).toString('hex')

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: `${CALENDAR_SCOPE} openid email`,
    /* Offline, and consent every time: Google only sends a refresh token with
       a consent screen, and without one the connection dies within the hour. */
    access_type: 'offline',
    prompt: 'consent',
    state,
  })

  return {
    url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    state,
  }
}

/** Whether the state Google handed back is the one this browser was sent off with. */
export function stateMatches(returned: string | null, stored: string | undefined): boolean {
  if (!returned || !stored) return false
  const a = Buffer.from(returned)
  const b = Buffer.from(stored)
  return a.length === b.length && timingSafeEqual(a, b)
}

export interface GoogleTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
  id_token?: string
  /* What was actually granted, space-separated. The consent screen lets each
     scope be unticked, so this can be less than was asked for. */
  scope?: string
  token_type?: string
}

export interface GoogleIdTokenPayload {
  email?: string
  email_verified?: boolean
  aud?: string
  iss?: string
}

/** The scopes Google granted, as a list. */
export function grantedScopes(response: Pick<GoogleTokenResponse, 'scope'>): string[] {
  return (response.scope ?? '').split(/\s+/).filter(Boolean)
}

/**
 * Exchange authorization code for tokens.
 */
export async function exchangeGoogleAuthCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<GoogleTokenResponse> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  })

  if (!response.ok) {
    throw new Error(`Google refused the sign-in: ${await googleErrorDetail(response)}`)
  }

  const data = (await response.json()) as Partial<GoogleTokenResponse>
  if (!data.access_token) throw new Error('Google returned no access token.')
  return data as GoogleTokenResponse
}

/**
 * Read a JWT's payload without verifying its signature. Only for a token that
 * came straight from Google's token endpoint over TLS, which is the one case
 * where the channel already vouches for it.
 */
export function parseJwt(token: string): GoogleIdTokenPayload {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Invalid JWT')

  const payload = Buffer.from(parts[1]!, 'base64url').toString('utf8')
  return JSON.parse(payload)
}

/**
 * Decode the id_token to extract the account email.
 */
export function getAccountEmailFromIdToken(idToken: string): string {
  const payload = parseJwt(idToken)
  if (!payload.email) throw new Error('No email in Google id_token')
  return payload.email
}
