/*
 * Dynamic Client Registration (RFC 7591).
 *
 * This is what makes connecting a one-URL operation instead of "generate a
 * client ID here and paste it into claude.ai", and it is also the only
 * unauthenticated write endpoint in the application. Both halves of that
 * sentence are load-bearing, so the hardening lives here rather than in the
 * route: an allowlist checked at registration time, a cap on how many rows can
 * exist, and a prune of clients nobody ever consented to.
 *
 * Registration is not consent. A registered client can do nothing at all until a
 * logged-in human approves it at /oauth/authorize — that is the real control,
 * and everything in this file exists so the table stays clean and the endpoint
 * is a poor target rather than because registration itself grants anything.
 */

import { randomBytes } from 'node:crypto'
import { and, count, eq, isNull, lt, sql } from 'drizzle-orm'
import type { Executor } from '@/lib/core/types'
import { oauthAuthorizationCodes, oauthClients, oauthTokens } from '../db/schema'
import { allowedRedirectUriDescription, redirectUriAllowed } from './config'
import { OAuthError } from './errors'

/**
 * A ceiling on rows, not on traffic — the rate limiter handles traffic. Without
 * one, registration is a free database-growth primitive for anyone who finds the
 * URL. A personal deployment connects a handful of clients; a hundred is far
 * past generous and still bounded.
 */
export const MAX_CLIENTS = 100

/** A client registered but never granted is garbage. */
export const UNCONSENTED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000

export const MAX_REDIRECT_URIS = 5

export type RegisteredClient = {
  id: string
  clientName: string
  logoUri: string | null
  redirectUris: string[]
  createdAt: Date
}

export type ClientRegistration = {
  clientName?: unknown
  redirectUris?: unknown
  logoUri?: unknown
}

function clientId(): string {
  // Public and non-secret — it identifies, it does not authenticate. Prefixed so
  // it is recognizable in a log line without having to guess what it is.
  return `mm_${randomBytes(16).toString('base64url')}`
}

function validate(input: ClientRegistration): {
  clientName: string
  redirectUris: string[]
  logoUri: string | null
} {
  const uris = input.redirectUris
  if (!Array.isArray(uris) || uris.length === 0) {
    throw new OAuthError('invalid_redirect_uri', 'redirect_uris is required and must be an array')
  }
  if (uris.length > MAX_REDIRECT_URIS) {
    throw new OAuthError(
      'invalid_redirect_uri',
      `at most ${MAX_REDIRECT_URIS} redirect_uris may be registered`,
    )
  }

  const redirectUris: string[] = []
  for (const uri of uris) {
    if (typeof uri !== 'string' || !redirectUriAllowed(uri)) {
      throw new OAuthError(
        'invalid_redirect_uri',
        `${typeof uri === 'string' ? uri : 'that redirect_uri'} is not an accepted redirect target. ` +
          `This deployment accepts ${allowedRedirectUriDescription()}.`,
      )
    }
    if (!redirectUris.includes(uri)) redirectUris.push(uri)
  }

  const name = typeof input.clientName === 'string' ? input.clientName.trim() : ''
  if (name.length > 200) {
    throw new OAuthError('invalid_client_metadata', 'client_name is too long')
  }

  const logo = typeof input.logoUri === 'string' ? input.logoUri.trim() : ''
  /* Rendered as an <img> on the consent screen, so the scheme is checked here
     rather than at render: a javascript: or data: URI reaching that markup is
     the one way a registration payload could become script on a page a human is
     about to approve something on. */
  const logoUri = logo && /^https:\/\//i.test(logo) ? logo : null

  return {
    // Shown on the consent screen; an unnamed client still has to read as
    // something rather than as a blank.
    clientName: name || 'Unnamed client',
    redirectUris,
    logoUri,
  }
}

export async function registerClient(
  exec: Executor,
  input: ClientRegistration,
  now = new Date(),
): Promise<RegisteredClient> {
  const metadata = validate(input)

  /* Prune before counting, so garbage cannot permanently wedge the cap. A
     deployment that hit the ceiling a month ago on registrations nobody ever
     approved should come back on its own rather than needing a DBA. */
  await pruneUnconsentedClients(exec, now)

  if ((await countClients(exec)) >= MAX_CLIENTS) {
    throw new OAuthError(
      'invalid_client_metadata',
      'this deployment is holding as many registered clients as it will. ' +
        'Revoke unused connectors in Settings and register again.',
      429,
    )
  }

  const [row] = await exec
    .insert(oauthClients)
    .values({
      id: clientId(),
      clientName: metadata.clientName,
      logoUri: metadata.logoUri,
      redirectUris: metadata.redirectUris,
      registrationSource: 'dcr',
      createdAt: now,
    })
    .returning()

  return {
    id: row!.id,
    clientName: row!.clientName,
    logoUri: row!.logoUri,
    redirectUris: row!.redirectUris,
    createdAt: row!.createdAt,
  }
}

export async function findClient(exec: Executor, id: string): Promise<RegisteredClient | null> {
  if (!id) return null
  const [row] = await exec.select().from(oauthClients).where(eq(oauthClients.id, id)).limit(1)
  if (!row) return null
  return {
    id: row.id,
    clientName: row.clientName,
    logoUri: row.logoUri,
    redirectUris: row.redirectUris,
    createdAt: row.createdAt,
  }
}

/**
 * Exact string match against the registered set. No prefix matching, no
 * wildcards, no normalization — this is the check that stops an authorization
 * code being redirected somewhere it should not go, and every relaxation of it
 * that has ever been shipped anywhere has turned into an open redirect.
 */
export function redirectUriRegistered(client: RegisteredClient, uri: string): boolean {
  return client.redirectUris.includes(uri)
}

export async function touchClient(exec: Executor, id: string, now = new Date()): Promise<void> {
  await exec.update(oauthClients).set({ lastUsedAt: now }).where(eq(oauthClients.id, id))
}

/**
 * Drop clients that registered, were never consented to, and have gone stale.
 *
 * "Consented to" means something downstream exists — a code was issued or a
 * token was minted. Both are cascade-deleted with the client, so checking them
 * is checking whether the row was ever more than an entry in a table.
 */
export async function pruneUnconsentedClients(exec: Executor, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - UNCONSENTED_CLIENT_TTL_MS)

  const deleted = await exec
    .delete(oauthClients)
    .where(
      and(
        lt(oauthClients.createdAt, cutoff),
        isNull(oauthClients.lastUsedAt),
        sql`not exists (select 1 from ${oauthTokens} where ${oauthTokens.clientId} = ${oauthClients.id})`,
        sql`not exists (select 1 from ${oauthAuthorizationCodes} where ${oauthAuthorizationCodes.clientId} = ${oauthClients.id})`,
        // Hand-registered clients are somebody's deliberate act; only DCR rows
        // are garbage-collectable.
        eq(oauthClients.registrationSource, 'dcr'),
      ),
    )
    .returning({ id: oauthClients.id })

  return deleted.length
}

/** Total rows, for the cap and for the Settings screen. */
export async function countClients(exec: Executor): Promise<number> {
  const [row] = await exec.select({ total: count() }).from(oauthClients)
  return Number(row?.total ?? 0)
}

/** Registration response, RFC 7591 §3.2.1. Public client: PKCE, no secret. */
export function registrationResponse(client: RegisteredClient) {
  return {
    client_id: client.id,
    client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    /* No client secret is issued, and none is accepted. A public client that
       proves possession of the code verifier is the OAuth 2.1 shape for this;
       a secret embedded in a connector configuration proves nothing anyway. */
    token_endpoint_auth_method: 'none',
    ...(client.logoUri ? { logo_uri: client.logoUri } : {}),
  }
}
