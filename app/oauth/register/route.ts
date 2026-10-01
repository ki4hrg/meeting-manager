/*
 * RFC 7591 — Dynamic Client Registration.
 *
 * The only unauthenticated write endpoint in the application, which is why the
 * hardening in lib/oauth/clients.ts exists and why the limiter sits in front of
 * it. It stays unauthenticated because it is what makes connecting a matter of
 * pasting one URL: without it, adding the connector means generating a client ID
 * here and pasting it there, which is the only genuinely annoying step in the
 * whole flow.
 *
 * Under app/api/? No — under app/oauth/, and either way nothing about placement
 * authenticates it. That is the point: registration grants nothing. A registered
 * client can do exactly nothing until a logged-in human approves it at
 * /oauth/authorize.
 */

import { registerClient, registrationResponse } from '@/lib/oauth/clients'
import { OAuthError } from '@/lib/oauth/errors'
import { corsHeaders, oauthJson, preflight } from '@/lib/oauth/http'
import { clientAddress, fixedWindow } from '@/lib/oauth/rate-limit'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

/*
 * Ten an hour per address. A person connecting a connector does this once and
 * retries at most a handful of times; ten is generous for that and useless as a
 * way to fill a table. Module scope, so the window survives between requests and
 * resets with the container — see lib/oauth/rate-limit.ts on why that is
 * acceptable here.
 */
const limiter = fixedWindow(10, 60 * 60 * 1000)

export async function POST(request: Request) {
  if (!limiter.take(clientAddress(request))) {
    return oauthJson(
      {
        error: 'invalid_client_metadata',
        error_description: 'too many registration attempts — try again later',
      },
      { status: 429, headers: { 'retry-after': '3600' } },
    )
  }

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return oauthJson(
      { error: 'invalid_client_metadata', error_description: 'the request body must be JSON' },
      { status: 400 },
    )
  }

  const body = (payload ?? {}) as Record<string, unknown>

  try {
    const client = await registerClient(db, {
      clientName: body.client_name,
      redirectUris: body.redirect_uris,
      logoUri: body.logo_uri,
    })
    return oauthJson(registrationResponse(client), { status: 201 })
  } catch (err) {
    if (err instanceof OAuthError) {
      /*
       * Logged because the refusal is invisible from the other end. A client
       * that cannot register shows its user "couldn't connect" and swallows the
       * body, so without this line the only way to find out *what* was refused
       * is to guess at payloads — which is exactly how the first connection
       * attempt against this deployment was debugged.
       *
       * The redirect_uris are the whole point of logging it: they are what gets
       * refused, they are not a secret, and they are the one field a person can
       * compare against the allowlist.
       */
      console.warn('[oauth] registration refused', {
        error: err.code,
        description: err.description,
        clientName: typeof body.client_name === 'string' ? body.client_name : null,
        redirectUris: body.redirect_uris,
      })
      return oauthJson(err.body(), { status: err.status })
    }
    throw err
  }
}

export async function OPTIONS() {
  return preflight()
}

/* A GET here is someone exploring, not a client. Say what the endpoint is for
   rather than returning a bare 405 with no content. */
export async function GET() {
  return oauthJson(
    {
      error: 'invalid_request',
      error_description: 'client registration is a POST — see RFC 7591',
    },
    { status: 405, headers: { ...corsHeaders(), allow: 'POST, OPTIONS' } },
  )
}
