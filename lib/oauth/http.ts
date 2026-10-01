/*
 * CORS and response shapes for the OAuth endpoints.
 *
 * The discovery documents, the registration endpoint, and the token and revoke
 * endpoints are all fetched cross-origin by a browser-based client, so each has
 * to answer an OPTIONS preflight. Missing preflight handling belongs to the same
 * family of failure as a missing WWW-Authenticate header: the connector
 * does not add, and the error says nothing about why.
 *
 * `*` for the origin is correct here rather than lax. These endpoints are either
 * public documents or take a credential in the request body — none of them are
 * authorized by a cookie, so there is no ambient authority for a cross-origin
 * caller to borrow, which is the thing a narrow allowlist would be protecting.
 * The authorize endpoint is deliberately absent: it *is* cookie-authorized, it
 * is a top-level browser navigation rather than a fetch, and giving it CORS
 * headers would be handing out exactly that ambient authority.
 */

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  /* `mcp-session-id` is listed even though this server issues none: a client
     that sends one on a stateless server gets it ignored, and a preflight that
     omits the header from the allowlist fails the request before the server ever
     sees it. `last-event-id` is the SSE resumption header, for the same reason. */
  'access-control-allow-headers':
    'authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id',
  'access-control-expose-headers': 'mcp-session-id, www-authenticate',
  'access-control-max-age': '86400',
}

export function corsHeaders(): Record<string, string> {
  return { ...CORS_HEADERS }
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: corsHeaders() })
}

export function oauthJson(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, {
    ...init,
    headers: {
      ...corsHeaders(),
      /* A token response must not be cached by anything, ever (RFC 6749 §5.1).
         The discovery documents are equally happy served fresh — they are two
         small objects on a homelab, and a stale one after a PUBLIC_BASE_URL
         change is a connector that fails with an issuer mismatch. */
      'cache-control': 'no-store',
      pragma: 'no-cache',
      ...(init.headers as Record<string, string> | undefined),
    },
  })
}
