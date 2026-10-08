/*
 * Which account a single sign-on belongs to.
 *
 * Kept apart from the protocol (oidc.ts) because this is where the security
 * decisions are, and as a plain function over verified claims it is tested
 * without a provider.
 *
 * This app has one account, made by /setup. SSO signs into it and never makes
 * one: with no account yet, the answer is setup, not SSO.
 *
 * Matching, in order:
 *
 * 1. By the stored (issuer, subject). The subject is the provider's stable id
 *    for the person and survives a change of address.
 * 2. By email, case-insensitively, once, to link. Only when the provider says
 *    the address is verified or OIDC_TRUST_EMAIL vouches for the provider;
 *    otherwise anybody able to claim an address there could take the account.
 *    The match attaches the subject, so the next sign-in takes step 1.
 *
 * An account already carrying a different subject is refused, never re-linked:
 * two identities claiming one account is a provider that reissued subjects or a
 * takeover, and a sign-in is not the place to settle which.
 */

import { and, eq, isNull } from 'drizzle-orm'
import type { Executor } from '../core/types'
import { db } from '../db'
import { users } from '../db/schema'
import { findUserByEmail, needsSetup } from './users'

export type OidcIdentity = {
  issuer: string
  subject: string
  email: string | null
  emailVerified: boolean
}

export type OidcRefusal = 'setup' | 'no-account' | 'unverified-email' | 'other-identity'

export type OidcResolution =
  | { kind: 'user'; userId: string; linked: boolean }
  | { kind: 'refused'; reason: OidcRefusal }

export async function resolveOidcUser(
  identity: OidcIdentity,
  options: { trustEmail: boolean },
  exec: Executor = db,
): Promise<OidcResolution> {
  const [bySubject] = await exec
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.oidcIssuer, identity.issuer),
        eq(users.oidcSubject, identity.subject),
        isNull(users.deletedAt),
      ),
    )
    .limit(1)
  if (bySubject) return { kind: 'user', userId: bySubject.id, linked: false }

  if (await needsSetup(exec)) return { kind: 'refused', reason: 'setup' }

  if (!identity.email) return { kind: 'refused', reason: 'no-account' }
  if (!identity.emailVerified && !options.trustEmail) {
    return { kind: 'refused', reason: 'unverified-email' }
  }

  const user = await findUserByEmail(identity.email, exec)
  if (!user) return { kind: 'refused', reason: 'no-account' }
  if (user.oidcSubject !== null) return { kind: 'refused', reason: 'other-identity' }

  /* Conditional on the column still being empty, so two callbacks racing on
     different subjects cannot both link. */
  const [linked] = await exec
    .update(users)
    .set({ oidcIssuer: identity.issuer, oidcSubject: identity.subject, updatedAt: new Date() })
    .where(and(eq(users.id, user.id), isNull(users.oidcSubject)))
    .returning({ id: users.id })
  if (!linked) return { kind: 'refused', reason: 'other-identity' }

  return { kind: 'user', userId: user.id, linked: true }
}
