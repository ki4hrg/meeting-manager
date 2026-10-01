/*
 * OAuth errors are a wire format, not a message.
 *
 * RFC 6749 §5.2 and RFC 7591 §3.2.2 both specify a JSON body with an `error`
 * code from a fixed list plus an optional human-readable description. Clients
 * branch on the code; people read the description. Throwing a plain Error would
 * produce a 500 with neither, which presents at the other end as a connector
 * that fails to add for no stated reason.
 */

export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'unsupported_response_type'
  | 'invalid_scope'
  | 'invalid_target'
  | 'access_denied'
  | 'server_error'
  | 'invalid_redirect_uri'
  | 'invalid_client_metadata'

export class OAuthError extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    readonly description: string,
    readonly status = 400,
  ) {
    super(`${code}: ${description}`)
    this.name = 'OAuthError'
  }

  body(): { error: OAuthErrorCode; error_description: string } {
    return { error: this.code, error_description: this.description }
  }
}
