/*
 * Authorization codes, and the PKCE exchange that spends them.
 *
 * The code is the one credential in the flow that travels through a browser
 * redirect, which is why it is short-lived, single-use, and worthless without
 * the verifier. PKCE is mandatory here rather than conditional: an
 * authorize request with no code_challenge is refused, so there is no downgrade
 * path a client can take by omitting it.
 */

import { createHash } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { generateToken, hashToken, tokensMatch } from '../auth/tokens'
import type { Executor } from '@/lib/core/types'
import { oauthAuthorizationCodes } from '../db/schema'
import { AUTHORIZATION_CODE_TTL_SECONDS, type Scope, formatScope, parseScope } from './config'
import { OAuthError } from './errors'

/** RFC 7636 §4.1. Shorter than 43 characters is not a verifier, it is a guess. */
const MIN_VERIFIER_LENGTH = 43
const MAX_VERIFIER_LENGTH = 128

export function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export type IssuedCode = { code: string; expiresAt: Date }

export async function issueAuthorizationCode(
  exec: Executor,
  input: {
    clientId: string
    userId: string
    redirectUri: string
    scopes: readonly Scope[]
    resource: string | null
    codeChallenge: string
    now?: Date
  },
): Promise<IssuedCode> {
  const now = input.now ?? new Date()
  const expiresAt = new Date(now.getTime() + AUTHORIZATION_CODE_TTL_SECONDS * 1000)
  const code = generateToken()

  await exec.insert(oauthAuthorizationCodes).values({
    codeHash: hashToken(code),
    clientId: input.clientId,
    userId: input.userId,
    redirectUri: input.redirectUri,
    scope: formatScope(input.scopes),
    resource: input.resource,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: 'S256',
    createdAt: now,
    expiresAt,
  })

  return { code, expiresAt }
}

export type ConsumedCode = {
  clientId: string
  userId: string
  scopes: Scope[]
  resource: string | null
}

/**
 * Spend a code, or refuse and say which check failed.
 *
 * The replay case is the interesting one. A code presented twice means either a
 * client bug or that someone else got the code out of a redirect and is racing
 * the legitimate exchange — and the two are indistinguishable from here. RFC
 * 6749 §4.1.2 says to treat it as an attack, so the caller revokes everything
 * the code ever produced rather than merely refusing the second call. This
 * function reports the case; `revokeGrant` in tokens.ts carries it out.
 */
export async function consumeAuthorizationCode(
  exec: Executor,
  input: {
    code: string
    clientId: string
    redirectUri: string
    codeVerifier: string
    now?: Date
  },
): Promise<ConsumedCode & { replayed: false }> {
  const now = input.now ?? new Date()
  if (!input.code) throw new OAuthError('invalid_grant', 'code is required')

  const codeHash = hashToken(input.code)
  const [row] = await exec
    .select()
    .from(oauthAuthorizationCodes)
    .where(eq(oauthAuthorizationCodes.codeHash, codeHash))
    .limit(1)

  if (!row) throw new OAuthError('invalid_grant', 'that authorization code is not valid')

  if (row.consumedAt) {
    throw new CodeReplayError(row.clientId, row.userId)
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    throw new OAuthError('invalid_grant', 'that authorization code has expired — authorize again')
  }
  /* Bound to the client it was issued to. Without this check a code leaked from
     one client's redirect could be exchanged by any other registered client. */
  if (row.clientId !== input.clientId) {
    throw new OAuthError('invalid_grant', 'that authorization code was issued to another client')
  }
  /* RFC 6749 §4.1.3: the redirect_uri presented at the token endpoint must be
     the one the code was issued against, which is what stops a code obtained
     via one registered URI being redeemed as though it came from another. */
  if (row.redirectUri !== input.redirectUri) {
    throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request')
  }

  verifyPkce(row.codeChallenge, row.codeChallengeMethod, input.codeVerifier)

  /* Conditional on still being unconsumed, so two exchanges racing on one code
     cannot both succeed. The loser sees zero rows updated and is handled as the
     replay it is. */
  const spent = await exec
    .update(oauthAuthorizationCodes)
    .set({ consumedAt: now })
    .where(
      and(
        eq(oauthAuthorizationCodes.codeHash, codeHash),
        isNull(oauthAuthorizationCodes.consumedAt),
      ),
    )
    .returning({ codeHash: oauthAuthorizationCodes.codeHash })

  if (spent.length === 0) throw new CodeReplayError(row.clientId, row.userId)

  return {
    clientId: row.clientId,
    userId: row.userId,
    scopes: parseScope(row.scope).scopes,
    resource: row.resource,
    replayed: false,
  }
}

/** A code presented a second time. Carries who to revoke, not just that it failed. */
export class CodeReplayError extends OAuthError {
  constructor(
    readonly clientId: string,
    readonly userId: string,
  ) {
    super(
      'invalid_grant',
      'that authorization code has already been used — the grant it belonged to has been revoked',
    )
    this.name = 'CodeReplayError'
  }
}

function verifyPkce(challenge: string, method: string, verifier: string): void {
  if (method !== 'S256') {
    // Nothing else is advertised in the discovery document, and `plain` is a
    // downgrade rather than an alternative.
    throw new OAuthError('invalid_grant', 'only the S256 code challenge method is supported')
  }
  if (
    !verifier ||
    verifier.length < MIN_VERIFIER_LENGTH ||
    verifier.length > MAX_VERIFIER_LENGTH
  ) {
    throw new OAuthError(
      'invalid_grant',
      `code_verifier must be between ${MIN_VERIFIER_LENGTH} and ${MAX_VERIFIER_LENGTH} characters`,
    )
  }
  if (!tokensMatch(s256(verifier), challenge)) {
    throw new OAuthError('invalid_grant', 'code_verifier does not match the code_challenge')
  }
}

/** Validation for the authorize endpoint, before a code exists to issue. */
export function assertUsableChallenge(challenge: string | null, method: string | null): void {
  if (!challenge) {
    throw new OAuthError(
      'invalid_request',
      'code_challenge is required — this server requires PKCE',
    )
  }
  if (method && method !== 'S256') {
    throw new OAuthError('invalid_request', 'code_challenge_method must be S256')
  }
  // A base64url SHA-256 digest is exactly 43 characters. Checking the shape here
  // means a malformed challenge fails at authorize time, where the message is
  // read by a person, rather than at exchange time where it is read by a client
  // that can only report that the grant was invalid.
  if (!/^[A-Za-z0-9\-._~]{43}$/.test(challenge)) {
    throw new OAuthError('invalid_request', 'code_challenge is not a base64url S256 digest')
  }
}
