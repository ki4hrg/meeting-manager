/*
 * RFC 8414 — authorization server metadata.
 *
 * Step 3 of the handshake. Everything a client needs to run the flow without
 * anything being configured by hand, which is what makes connecting a matter of
 * pasting one URL.
 *
 * `issuer` must be exactly the origin the client discovered this document at, or
 * the client rejects it as a mismatch. That is PUBLIC_BASE_URL, and it is why a
 * wrong value there breaks the connector with an error that names none of this.
 */

import { MCP_PATH, SCOPES, absoluteUrl, baseUrl } from '@/lib/oauth/config'
import { oauthJson, preflight } from '@/lib/oauth/http'

export const dynamic = 'force-dynamic'

export async function GET() {
  return oauthJson({
    issuer: baseUrl(),
    authorization_endpoint: absoluteUrl('/oauth/authorize'),
    token_endpoint: absoluteUrl('/oauth/token'),
    registration_endpoint: absoluteUrl('/oauth/register'),
    revocation_endpoint: absoluteUrl('/oauth/revoke'),
    scopes_supported: [...SCOPES],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    /* S256 only. Advertising `plain` alongside it would make PKCE optional in
       practice, since a client may pick either. */
    code_challenge_methods_supported: ['S256'],
    /* Public clients. No secret is issued at registration, so none can be
       presented at the token endpoint. */
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    /* RFC 8707. Tokens are bound to this resource so one minted for this server
       cannot be replayed against another server trusting the same issuer. */
    resource_indicators_supported: true,
    resource_documentation: absoluteUrl(MCP_PATH),
  })
}

export async function OPTIONS() {
  return preflight()
}
