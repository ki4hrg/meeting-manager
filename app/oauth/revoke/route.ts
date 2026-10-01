/*
 * RFC 7009 — token revocation.
 *
 * This is the client's way to disconnect. The Settings screen is the other one,
 * and they meet at revokeGrant: pressing "revoke" here and removing the
 * connector in claude.ai should leave the same state behind.
 *
 * The response is 200 whether or not the token existed, and that is the
 * specification rather than sloppiness (§2.2): a revocation endpoint that
 * distinguishes "revoked" from "no such token" is an oracle for testing whether
 * a guessed token is real, and the caller has nothing useful to do with the
 * difference in either case.
 */

import { OAuthError } from '@/lib/oauth/errors'
import { revokeToken } from '@/lib/oauth/grants'
import { corsHeaders, oauthJson, preflight } from '@/lib/oauth/http'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  let form: URLSearchParams
  try {
    form = new URLSearchParams(await request.text())
  } catch {
    return oauthJson(new OAuthError('invalid_request', 'the request body could not be read').body(), {
      status: 400,
    })
  }

  const token = form.get('token')
  if (!token) {
    return oauthJson(new OAuthError('invalid_request', 'token is required').body(), { status: 400 })
  }

  /* token_type_hint is advisory and deliberately ignored: the hash lookup finds
     the row whatever kind it is, and a wrong hint must not cause a real token to
     survive revocation (§2.1). */
  await revokeToken(db, token)

  return new Response(null, { status: 200, headers: corsHeaders() })
}

export async function OPTIONS() {
  return preflight()
}

export async function GET() {
  return oauthJson(
    { error: 'invalid_request', error_description: 'the revocation endpoint is a POST' },
    { status: 405, headers: { ...corsHeaders(), allow: 'POST, OPTIONS' } },
  )
}
