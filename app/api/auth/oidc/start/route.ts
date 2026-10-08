/*
 * GET /api/auth/oidc/start — send the browser to the identity provider.
 *
 * Public by design: it is a way to sign in. `?next=` carries the page to
 * return to, the OAuth consent screen above all, through the round trip in the
 * flow cookie; it is sanitized here and again on the way back.
 */

import { NextResponse } from 'next/server'
import { safeNext } from '@/lib/auth/redirects'
import {
  OIDC_CALLBACK_PATH,
  OIDC_FLOW_COOKIE,
  OIDC_FLOW_PATH,
  OIDC_FLOW_TTL_SECONDS,
  beginOidc,
  encodeFlow,
} from '@/lib/auth/oidc'
import { absoluteUrl } from '@/lib/oauth/config'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request): Promise<Response> {
  const next = safeNext(new URL(request.url).searchParams.get('next'))

  const begun = await beginOidc(absoluteUrl(OIDC_CALLBACK_PATH), next)
  if (!begun) {
    const params = new URLSearchParams({ error: 'unavailable' })
    if (next !== '/') params.set('next', next)
    return NextResponse.redirect(`${absoluteUrl('/login')}?${params}`)
  }

  /* Lax, because the way back from the provider is a top-level navigation
     from another site; scoped to the two SSO routes and gone in ten minutes. */
  const response = NextResponse.redirect(begun.url)
  response.cookies.set(OIDC_FLOW_COOKIE, encodeFlow(begun.flow), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: OIDC_FLOW_TTL_SECONDS,
    path: OIDC_FLOW_PATH,
  })
  return response
}
