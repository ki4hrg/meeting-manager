/*
 * Why a single sign-on came back to /login, as `?error=<code>`.
 *
 * A code rather than the message, so the login page shows only sentences
 * written here: a message in the URL would be text anybody could put on this
 * origin's sign-in screen with a link.
 */

import type { OidcRefusal } from './oidc-account'

export type OidcErrorCode = Exclude<OidcRefusal, 'setup'> | 'expired' | 'failed' | 'unavailable'

const MESSAGES: Record<OidcErrorCode, (provider: string) => string> = {
  'no-account': () => 'No account matches that sign-in.',
  'unverified-email': (provider) => `Verify your email with ${provider} first.`,
  'other-identity': () => 'This account is linked to a different sign-in.',
  expired: () => 'Sign-in expired. Try again.',
  failed: () => 'Sign-in failed. Try again.',
  unavailable: (provider) => `${provider} is unavailable.`,
}

/** The sentence for a code, or undefined for anything not written here. */
export function oidcErrorMessage(code: string | undefined, provider: string): string | undefined {
  if (!code || !Object.hasOwn(MESSAGES, code)) return undefined
  return MESSAGES[code as OidcErrorCode](provider)
}
