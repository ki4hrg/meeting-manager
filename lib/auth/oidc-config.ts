/*
 * Single sign-on settings, read from the environment.
 *
 * Off unless the issuer, client id and secret are all set. Two of the three is
 * an error rather than "off": a deployment that meant to turn SSO on and typo'd
 * one variable would otherwise lose the button with nothing saying why.
 *
 * Pure and given its environment, so the parsing is tested without a process.
 */

export type OidcConfig =
  | { enabled: false }
  | {
      enabled: true
      issuer: string
      clientId: string
      clientSecret: string
      /** The button's label: "Sign in with <displayName>". */
      displayName: string
      /** Hide and refuse password sign-in, but only while SSO is reachable. */
      only: boolean
      /** Accept an email the provider has not marked verified, to link an account. */
      trustEmail: boolean
    }

const REQUIRED = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'] as const

function flag(raw: string | undefined): boolean {
  return ['true', '1', 'yes'].includes(raw?.trim().toLowerCase() ?? '')
}

export function oidcConfig(env: Record<string, string | undefined> = process.env): OidcConfig {
  const values = REQUIRED.map((name) => env[name]?.trim() ?? '')
  const set = values.filter(Boolean).length

  if (set === 0) return { enabled: false }
  if (set < REQUIRED.length) {
    const missing = REQUIRED.filter((_, i) => !values[i])
    throw new Error(
      `Single sign-on is half configured: set ${missing.join(' and ')}, or unset ` +
        `${REQUIRED.join(', ')} to turn it off.`,
    )
  }

  const [issuer, clientId, clientSecret] = values as [string, string, string]
  return {
    enabled: true,
    /* Discovery compares the issuer it is given with the one the provider
       states, exactly. Pocket ID states its origin with no trailing slash. */
    issuer: issuer.replace(/\/+$/, ''),
    clientId,
    clientSecret,
    displayName: env.OIDC_DISPLAY_NAME?.trim() || 'Pocket ID',
    only: flag(env.OIDC_ONLY),
    trustEmail: flag(env.OIDC_TRUST_EMAIL),
  }
}

/**
 * Whether the password form may be shown and used.
 *
 * OIDC_ONLY bites only while SSO can actually sign somebody in. With SSO
 * unconfigured, or its provider unreachable, refusing passwords too would lock
 * the one account out of its own app.
 */
export function passwordSignInAllowed(config: OidcConfig, ssoUsable: boolean): boolean {
  return !(config.enabled && config.only && ssoUsable)
}
