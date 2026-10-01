/*
 * Turning a bearer token into a caller.
 *
 * Two things happen here and they are not the same thing. Authentication is the
 * token: it resolves to a user, a client, and a scope set, or it does not.
 * Authorization is the scope set, and it is checked again at every tool call
 * (see scopes.ts) because a tool list is client-side and can be stale.
 *
 * The 401 is the other half of this file, and it is the easiest thing here to
 * get wrong. A bare 401 stalls discovery: the client has no way to
 * find the metadata document and gives up with an error that names nothing.
 * `WWW-Authenticate` with `resource_metadata` is what turns "refused" into "go
 * and log in, here is where".
 */

import { randomUUID } from 'node:crypto'
import type { ActorContext } from '@/lib/core/types'
import type { BearerIdentity } from '../oauth/grants'
import { MCP_PATH, absoluteUrl } from '../oauth/config'
import { corsHeaders } from '../oauth/http'

export function bearerFrom(request: Request): string | undefined {
  const header = request.headers.get('authorization')
  if (!header) return undefined

  /* Case-insensitively, because the scheme is a token in the HTTP grammar and
     clients do send "bearer". Split on the first space only — a base64url token
     never contains one, but a header with trailing junk should fail to resolve
     rather than be silently trimmed into something that works. */
  const [scheme, ...rest] = header.split(' ')
  if (!scheme || scheme.toLowerCase() !== 'bearer') return undefined
  const value = rest.join(' ').trim()
  return value || undefined
}

/**
 * The 401 that starts the OAuth handshake.
 *
 * RFC 9728 §5.1 puts the metadata URL in the challenge. `error` and
 * `error_description` are for the person reading a log; `resource_metadata` is
 * the part a client acts on.
 */
export function unauthorized(
  description = 'authorization is required to reach Meeting Manager',
): Response {
  const metadata = `${absoluteUrl('/.well-known/oauth-protected-resource')}${MCP_PATH}`

  return Response.json(
    {
      /* JSON-RPC shaped as well as HTTP shaped: a client that reads the body
         before the status gets something it can parse rather than HTML. -32001
         is the conventional "unauthorized" in the server-defined range. */
      jsonrpc: '2.0',
      error: { code: -32001, message: description },
      id: null,
    },
    {
      status: 401,
      headers: {
        ...corsHeaders(),
        'www-authenticate':
          `Bearer resource_metadata="${metadata}", ` +
          `error="invalid_token", error_description="${description}"`,
        'cache-control': 'no-store',
      },
    },
  )
}

/** One requestId per HTTP request, so a tool call that writes several rows reads as one event. */
export function actorFor(identity: BearerIdentity): ActorContext {
  return {
    userId: identity.userId,
    source: 'mcp',
    clientId: identity.clientId,
    requestId: randomUUID(),
  }
}
