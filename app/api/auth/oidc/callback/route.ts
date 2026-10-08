/*
 * GET /api/auth/oidc/callback — where the identity provider sends the browser
 * back. Register exactly this URL, on PUBLIC_BASE_URL, with the provider.
 *
 * Every outcome is a redirect: into the app (or the page `next` named), to
 * /setup when there is no account yet, or to /login with an error code.
 */

import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { resolveOidcUser } from '@/lib/auth/oidc-account'
import { oidcConfig } from '@/lib/auth/oidc-config'
import type { OidcErrorCode } from '@/lib/auth/oidc-errors'
import {
  OIDC_CALLBACK_PATH,
  OIDC_FLOW_COOKIE,
  OIDC_FLOW_PATH,
  completeOidc,
  decodeFlow,
  type VerifiedClaims,
} from '@/lib/auth/oidc'
import { DEFAULT_AFTER_LOGIN, safeNext } from '@/lib/auth/redirects'
import { SESSION_COOKIE, cookieOptions, createSession } from '@/lib/auth/sessions'
import { absoluteUrl } from '@/lib/oauth/config'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/* The flow cookie is single-use: whatever happened, it goes. */
function redirectTo(location: string): NextResponse {
  const response = NextResponse.redirect(location)
  response.cookies.set(OIDC_FLOW_COOKIE, '', { path: OIDC_FLOW_PATH, maxAge: 0 })
  return response
}

function backToLogin(error: OidcErrorCode, next: string): NextResponse {
  const params = new URLSearchParams({ error })
  if (next !== DEFAULT_AFTER_LOGIN) params.set('next', next)
  return redirectTo(`${absoluteUrl('/login')}?${params}`)
}

export async function GET(request: Request): Promise<Response> {
  const flow = decodeFlow((await cookies()).get(OIDC_FLOW_COOKIE)?.value)
  /* No flow means this browser did not start the sign-in, or took too long. */
  if (!flow) return backToLogin('expired', DEFAULT_AFTER_LOGIN)

  // Sanitized again: the cookie came back through the browser.
  const next = safeNext(flow.next)

  /* Rebuilt on the public origin: behind the proxy the request's own URL
     names the container, and the token request has to send back the redirect
     URI the provider was given. */
  const incoming = new URL(request.url)
  const callbackUrl = new URL(absoluteUrl(OIDC_CALLBACK_PATH))
  callbackUrl.search = incoming.search

  if (incoming.searchParams.get('error')) return backToLogin('failed', next)

  let claims: VerifiedClaims
  try {
    claims = await completeOidc(callbackUrl, flow)
  } catch (err) {
    console.error(`[oidc] callback refused: ${err instanceof Error ? err.message : err}`)
    return backToLogin('failed', next)
  }

  const config = oidcConfig()
  const resolution = await resolveOidcUser(claims, {
    trustEmail: config.enabled && config.trustEmail,
  })

  if (resolution.kind === 'refused') {
    console.warn(`[oidc] sign-in refused (${resolution.reason}) for subject ${claims.subject}`)
    if (resolution.reason === 'setup') return redirectTo(absoluteUrl('/setup'))
    return backToLogin(resolution.reason, next)
  }

  const session = await createSession(resolution.userId, {
    userAgent: request.headers.get('user-agent'),
    // Behind the proxy that terminates TLS, the socket address is the proxy's.
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
  })

  const response = redirectTo(absoluteUrl(next))
  response.cookies.set(SESSION_COOKIE, session.token, { ...cookieOptions, expires: session.expiresAt })
  return response
}
