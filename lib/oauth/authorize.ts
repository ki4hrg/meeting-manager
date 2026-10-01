/*
 * Validating an authorization request, in one place, because two callers have to
 * agree exactly: the page that renders the consent screen and the action that
 * approves it.
 *
 * If they disagreed, the screen would describe one grant and the button would
 * issue another — which is the failure that makes a consent screen decorative
 * rather than load-bearing. The action re-runs everything from the submitted
 * form rather than trusting it, so a tampered hidden field fails validation
 * instead of widening a grant.
 *
 * Failures split in two, and the split matters:
 *
 *   Fatal    — the client or the redirect URI is not one we know. There is
 *              nowhere safe to send the user, so the error is rendered here.
 *              Redirecting an error to an unvalidated URI is how an open
 *              redirect gets built by accident.
 *   Redirect — everything after that. The URI is proven, so the error goes back
 *              to the client the way the specification says (RFC 6749 §4.1.2.1),
 *              carrying `state` so the client can match it to its request.
 */

import type { RegisteredClient } from './clients'
import { findClient, redirectUriRegistered } from './clients'
import { assertUsableChallenge } from './codes'
import { MCP_PATH, type Scope, absoluteUrl, parseScope } from './config'
import type { OAuthErrorCode } from './errors'
import type { Executor } from '@/lib/core/types'

/** Nowhere safe to redirect: render this. */
export class AuthorizeFatal extends Error {
  constructor(
    readonly title: string,
    readonly detail: string,
  ) {
    super(`${title}: ${detail}`)
    this.name = 'AuthorizeFatal'
  }
}

/** The redirect URI is proven, so the client gets told in its own language. */
export class AuthorizeRedirect extends Error {
  constructor(
    readonly redirectUri: string,
    readonly code: OAuthErrorCode,
    readonly description: string,
    readonly state: string | null,
  ) {
    super(`${code}: ${description}`)
    this.name = 'AuthorizeRedirect'
  }

  location(): string {
    const url = new URL(this.redirectUri)
    url.searchParams.set('error', this.code)
    url.searchParams.set('error_description', this.description)
    if (this.state) url.searchParams.set('state', this.state)
    return url.toString()
  }
}

export type RawAuthorizeParams = Record<string, string | undefined>

export type ResolvedTarget = { client: RegisteredClient; redirectUri: string; state: string | null }

/**
 * The checks that must pass before the user is asked to log in, let alone
 * consent — because until the redirect URI is proven there is nowhere to send an
 * error, and because sending someone through a login form to reach a request
 * that was never going to work is a waste of their time.
 */
export async function resolveTarget(
  exec: Executor,
  params: RawAuthorizeParams,
): Promise<ResolvedTarget> {
  const state = params.state ?? null
  const clientId = params.client_id ?? ''

  if (!clientId) {
    throw new AuthorizeFatal(
      'That request is missing a client',
      'No client_id was supplied, so there is no way to tell what is asking for access.',
    )
  }

  const client = await findClient(exec, clientId)
  if (!client) {
    throw new AuthorizeFatal(
      'That connector is not registered here',
      `No client is registered with the id ${clientId}. If the connector was added before this ` +
        'deployment was reset, remove it and add it again.',
    )
  }

  const requested = params.redirect_uri
  if (!requested) {
    /* RFC 6749 §3.1.2.3 permits omitting it when exactly one is registered.
       Accepted because it is unambiguous; anything else is refused rather than
       guessed at. */
    if (client.redirectUris.length === 1) {
      return { client, redirectUri: client.redirectUris[0]!, state }
    }
    throw new AuthorizeFatal(
      'That request is missing a redirect address',
      'No redirect_uri was supplied and this client registered more than one, so there is no ' +
        'way to tell where the answer should go.',
    )
  }

  if (!redirectUriRegistered(client, requested)) {
    /* Exact match against the registered set, and a refusal that does *not*
       redirect. This is the check standing between an authorization code and an
       attacker's address, so it fails visibly and stops. */
    throw new AuthorizeFatal(
      'That redirect address is not registered',
      `${client.clientName} asked for the answer to be sent to ${requested}, which is not one of ` +
        'the addresses it registered. Nothing has been approved.',
    )
  }

  return { client, redirectUri: requested, state }
}

export type AuthorizeRequest = {
  client: RegisteredClient
  redirectUri: string
  state: string | null
  /** What will be granted. */
  scopes: Scope[]
  resource: string | null
  codeChallenge: string
}

/** Validates everything past the redirect URI, and settles the scopes to grant. */
export function validateRequest(
  target: ResolvedTarget,
  params: RawAuthorizeParams,
): AuthorizeRequest {
  const { client, redirectUri, state } = target
  const refuse = (code: OAuthErrorCode, description: string): never => {
    throw new AuthorizeRedirect(redirectUri, code, description, state)
  }

  const responseType = params.response_type ?? ''
  if (responseType !== 'code') {
    refuse(
      'unsupported_response_type',
      `${responseType || 'that response_type'} is not supported — this server issues codes`,
    )
  }

  try {
    assertUsableChallenge(params.code_challenge ?? null, params.code_challenge_method ?? null)
  } catch (err) {
    refuse('invalid_request', err instanceof Error ? err.message.replace(/^\w+: /, '') : 'invalid PKCE parameters')
  }

  /*
   * RFC 8707. A token minted here is bound to this resource, so it cannot be
   * replayed against another MCP server that happens to trust the same issuer.
   * An unrecognized value is refused rather than ignored — ignoring it would
   * mint a token the client believes is narrower than it is.
   */
  const resource = params.resource ?? null
  if (resource && !resourceMatches(resource)) {
    refuse('invalid_target', `${resource} is not a resource this server issues tokens for`)
  }

  const { scopes: requested, unknown } = parseScope(params.scope)
  if (unknown.length > 0) {
    refuse('invalid_scope', `unknown scope: ${unknown.join(', ')}`)
  }

  // No scope asked for is not a request for everything a future scope might add.
  const scopes = requested.length > 0 ? requested : (['meetings:read', 'meetings:write'] as Scope[])

  return {
    client,
    redirectUri,
    state,
    scopes,
    resource,
    codeChallenge: params.code_challenge!,
  }
}

function resourceMatches(resource: string): boolean {
  let url: URL
  try {
    url = new URL(resource)
  } catch {
    return false
  }
  const canonical = new URL(absoluteUrl(MCP_PATH))
  if (url.origin !== canonical.origin) return false
  /* The MCP endpoint itself, or the deployment root — clients differ on which
     they name, and both identify this server unambiguously. */
  const path = url.pathname.replace(/\/+$/, '')
  return path === canonical.pathname || path === ''
}

/** What the consent screen says each scope means, in a person's words. */
export const SCOPE_DESCRIPTIONS: Record<Scope, { label: string; detail: string }> = {
  'meetings:read': {
    label: 'Read meetings and items',
    detail:
      'Read meetings, agendas, people, projects and items.',
  },
  'meetings:write': {
    label: 'Write meetings and items',
    detail:
      'Create and edit meetings, agendas, notes and items.',
  },
}
