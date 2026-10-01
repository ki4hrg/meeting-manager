/*
 * Access and refresh tokens, and the grant they belong to.
 *
 * Named grants.ts rather than tokens.ts because lib/auth/tokens.ts already owns
 * the primitive — generate an opaque value, store HMAC(SESSION_SECRET, value) —
 * and this file is about what a token *means* rather than what it is. Everything
 * here is stored hashed for the same reason sessions are: a database dump is not
 * a set of working credentials, and rotating SESSION_SECRET actually invalidates
 * every grant rather than doing so on paper.
 *
 * Access tokens are one hour because they carry delete authority.
 * Refresh tokens are ninety days and rotate on every use, which is the part that
 * makes a stolen refresh token detectable: the thief and the legitimate client
 * cannot both use the same one, and whoever arrives second presents a token that
 * has already been spent.
 */

import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm'
import { generateToken, hashToken } from '../auth/tokens'
import type { Executor } from '@/lib/core/types'
import { oauthClients, oauthTokens, users } from '../db/schema'
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  type Scope,
  formatScope,
  parseScope,
} from './config'
import { OAuthError } from './errors'

export type TokenPair = {
  accessToken: string
  refreshToken: string
  expiresIn: number
  scopes: Scope[]
}

export async function issueTokenPair(
  exec: Executor,
  input: {
    clientId: string
    userId: string
    scopes: readonly Scope[]
    resource: string | null
    /** The refresh token this pair replaces, for the rotation chain. */
    parentId?: string | null
    now?: Date
  },
): Promise<TokenPair> {
  const now = input.now ?? new Date()
  const scope = formatScope(input.scopes)
  const accessToken = generateToken()
  const refreshToken = generateToken()

  await exec
    .insert(oauthTokens)
    .values([
      {
        tokenHash: hashToken(accessToken),
        kind: 'access',
        clientId: input.clientId,
        userId: input.userId,
        scope,
        resource: input.resource,
        issuedAt: now,
        expiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000),
      },
      {
        tokenHash: hashToken(refreshToken),
        kind: 'refresh',
        clientId: input.clientId,
        userId: input.userId,
        scope,
        resource: input.resource,
        parentId: input.parentId ?? null,
        issuedAt: now,
        expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000),
      },
    ])

  return {
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    scopes: [...input.scopes],
  }
}

// ─── verification ────────────────────────────────────────────────────────────

export type BearerIdentity = {
  userId: string
  clientId: string
  clientName: string
  /** Granted scopes. */
  scopes: Scope[]
  resource: string | null
}

/**
 * Resolve a bearer token to who is calling and what they may ask for.
 *
 * Returns null rather than throwing. The caller's answer to "no identity" is a
 * 401 with a WWW-Authenticate header pointing at the metadata document, and that
 * response is the resource server's to build, not this function's.
 */
export async function resolveBearer(
  exec: Executor,
  token: string | undefined,
  now = new Date(),
): Promise<BearerIdentity | null> {
  if (!token) return null

  const [row] = await exec
    .select({
      id: oauthTokens.id,
      scope: oauthTokens.scope,
      resource: oauthTokens.resource,
      clientId: oauthTokens.clientId,
      clientName: oauthClients.clientName,
      userId: users.id,
    })
    .from(oauthTokens)
    .innerJoin(users, eq(users.id, oauthTokens.userId))
    .innerJoin(oauthClients, eq(oauthClients.id, oauthTokens.clientId))
    .where(
      and(
        eq(oauthTokens.tokenHash, hashToken(token)),
        eq(oauthTokens.kind, 'access'),
        isNull(oauthTokens.revokedAt),
        gt(oauthTokens.expiresAt, now),
        // A soft-deleted user's tokens stop working at once, exactly as their
        // sessions do. A join that forgot this would leave a deactivated
        // account with a live connector for up to an hour.
        isNull(users.deletedAt),
      ),
    )
    .limit(1)

  if (!row) return null

  const scopes = parseScope(row.scope).scopes

  await exec.update(oauthTokens).set({ lastUsedAt: now }).where(eq(oauthTokens.id, row.id))
  await exec.update(oauthClients).set({ lastUsedAt: now }).where(eq(oauthClients.id, row.clientId))

  return {
    userId: row.userId,
    clientId: row.clientId,
    clientName: row.clientName,
    scopes,
    resource: row.resource,
  }
}

// ─── rotation ────────────────────────────────────────────────────────────────

/**
 * Exchange a refresh token for a new pair, and treat reuse as theft.
 *
 * The presented token is revoked as part of the exchange, so presenting it again
 * lands in the reuse branch. OAuth 2.1 §4.3.1 says the authorization server
 * SHOULD revoke the whole authorization when that happens, and it is the right
 * call: by then either the client is broken or someone else has a copy, and
 * neither is a state to keep issuing credentials in.
 */
export async function rotateRefreshToken(
  exec: Executor,
  input: { refreshToken: string; clientId: string; scopes?: readonly Scope[]; now?: Date },
): Promise<TokenPair> {
  const now = input.now ?? new Date()

  const [row] = await exec
    .select({
      id: oauthTokens.id,
      userId: oauthTokens.userId,
      clientId: oauthTokens.clientId,
      scope: oauthTokens.scope,
      resource: oauthTokens.resource,
      revokedAt: oauthTokens.revokedAt,
      expiresAt: oauthTokens.expiresAt,
      deletedAt: users.deletedAt,
    })
    .from(oauthTokens)
    .innerJoin(users, eq(users.id, oauthTokens.userId))
    .where(and(eq(oauthTokens.tokenHash, hashToken(input.refreshToken)), eq(oauthTokens.kind, 'refresh')))
    .limit(1)

  if (!row) throw new OAuthError('invalid_grant', 'that refresh token is not valid')

  if (row.clientId !== input.clientId) {
    throw new OAuthError('invalid_grant', 'that refresh token was issued to another client')
  }

  if (row.revokedAt) {
    await revokeGrant(exec, { userId: row.userId, clientId: row.clientId, now })
    throw new OAuthError(
      'invalid_grant',
      'that refresh token has already been used. The grant has been revoked — reconnect to continue.',
    )
  }

  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) {
    throw new OAuthError('invalid_grant', 'that refresh token has expired — reconnect')
  }
  if (row.deletedAt) throw new OAuthError('invalid_grant', 'that account no longer exists')

  /*
   * Scope can narrow on refresh but never widen (RFC 6749 §6).
   */
  const previous = parseScope(row.scope).scopes
  const requested = input.scopes ? [...input.scopes] : previous
  const scopes = requested.filter((s) => previous.includes(s))

  if (scopes.length === 0) {
    throw new OAuthError(
      'invalid_scope',
      'none of the requested scopes are still available on this grant',
    )
  }

  await exec.update(oauthTokens).set({ revokedAt: now }).where(eq(oauthTokens.id, row.id))

  return issueTokenPair(exec, {
    clientId: row.clientId,
    userId: row.userId,
    scopes,
    resource: row.resource,
    parentId: row.id,
    now,
  })
}

// ─── revocation ──────────────────────────────────────────────────────────────

/**
 * RFC 7009. Revoking an access token revokes only it; revoking a refresh token
 * revokes the grant it belongs to.
 *
 * The asymmetry is the specification's — §2.1 says a refresh token revocation
 * SHOULD invalidate the access tokens issued alongside it — and it also matches
 * intent. "Disconnect this connector" is what pressing revoke means, and leaving
 * an access token live for another hour after it would be a surprise.
 */
export async function revokeToken(
  exec: Executor,
  token: string,
  now = new Date(),
): Promise<boolean> {
  const [row] = await exec
    .select({
      id: oauthTokens.id,
      kind: oauthTokens.kind,
      userId: oauthTokens.userId,
      clientId: oauthTokens.clientId,
    })
    .from(oauthTokens)
    .where(eq(oauthTokens.tokenHash, hashToken(token)))
    .limit(1)

  if (!row) return false

  if (row.kind === 'refresh') {
    await revokeGrant(exec, { userId: row.userId, clientId: row.clientId, now })
  } else {
    await exec
      .update(oauthTokens)
      .set({ revokedAt: now })
      .where(and(eq(oauthTokens.id, row.id), isNull(oauthTokens.revokedAt)))
  }
  return true
}

/** Everything one client holds for one user. What the Settings revoke button does. */
export async function revokeGrant(
  exec: Executor,
  input: { userId: string; clientId: string; now?: Date },
): Promise<number> {
  const revoked = await exec
    .update(oauthTokens)
    .set({ revokedAt: input.now ?? new Date() })
    .where(
      and(
        eq(oauthTokens.userId, input.userId),
        eq(oauthTokens.clientId, input.clientId),
        isNull(oauthTokens.revokedAt),
      ),
    )
    .returning({ id: oauthTokens.id })

  return revoked.length
}

// ─── the Settings screen's read ──────────────────────────────────────────────

export type Grant = {
  clientId: string
  clientName: string
  logoUri: string | null
  scopes: Scope[]
  issuedAt: Date
  lastUsedAt: Date | null
}

/**
 * Live grants for one user, one row per client.
 *
 * An OAuth grant you cannot see is one you cannot reason about, so
 * this is grouped the way a person thinks about it — "claude.ai has read and
 * write since Tuesday" — rather than as the token rows underneath, which after a
 * week of hourly refreshes are numerous and say nothing.
 */
export async function listGrants(exec: Executor, userId: string, now = new Date()): Promise<Grant[]> {
  const rows = await exec
    .select({
      clientId: oauthTokens.clientId,
      clientName: oauthClients.clientName,
      logoUri: oauthClients.logoUri,
      scope: oauthTokens.scope,
      issuedAt: sql<Date>`min(${oauthTokens.issuedAt})`,
      lastUsedAt: sql<Date | null>`max(${oauthTokens.lastUsedAt})`,
    })
    .from(oauthTokens)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthTokens.clientId))
    .where(
      and(
        eq(oauthTokens.userId, userId),
        isNull(oauthTokens.revokedAt),
        gt(oauthTokens.expiresAt, now),
      ),
    )
    .groupBy(oauthTokens.clientId, oauthClients.clientName, oauthClients.logoUri, oauthTokens.scope)
    .orderBy(desc(sql`min(${oauthTokens.issuedAt})`))

  /*
   * A grant that narrowed its scope on refresh has rows under both scope
   * strings, so the SQL grouping is per (client, scope) and the merge back to
   * one row per client happens here. Scopes union rather than replace: the
   * screen is answering "what can this connector do", and a live token under
   * either string is a yes.
   */
  const byClient = new Map<string, Grant>()
  for (const row of rows) {
    const issuedAt = new Date(row.issuedAt)
    const lastUsedAt = row.lastUsedAt ? new Date(row.lastUsedAt) : null
    const existing = byClient.get(row.clientId)

    if (!existing) {
      byClient.set(row.clientId, {
        clientId: row.clientId,
        clientName: row.clientName,
        logoUri: row.logoUri,
        scopes: parseScope(row.scope).scopes,
        issuedAt,
        lastUsedAt,
      })
      continue
    }

    for (const scope of parseScope(row.scope).scopes) {
      if (!existing.scopes.includes(scope)) existing.scopes.push(scope)
    }
    if (issuedAt < existing.issuedAt) existing.issuedAt = issuedAt
    if (lastUsedAt && (!existing.lastUsedAt || lastUsedAt > existing.lastUsedAt)) {
      existing.lastUsedAt = lastUsedAt
    }
  }

  return [...byClient.values()]
}

/** Housekeeping: expired rows are already inert, this keeps the table small. */
export async function purgeExpiredTokens(exec: Executor, now = new Date()): Promise<number> {
  /* The query builder, not a sql`` fragment: a Date interpolated into raw SQL
     reaches the driver as a bare parameter it will not encode for timestamptz,
     and the query fails at bind time. The same trap as purgeExpiredConfirmations. */
  const deleted = await exec
    .delete(oauthTokens)
    .where(lt(oauthTokens.expiresAt, now))
    .returning({ id: oauthTokens.id })
  return deleted.length
}
