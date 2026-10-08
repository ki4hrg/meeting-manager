/*
 * The single sign-on protocol, and nothing else.
 *
 * Which account a sign-in belongs to is decided in oidc-account.ts, a plain
 * function over the verified claims. This file discovers the provider, builds
 * the authorization request and turns the callback into claims.
 *
 * openid-client rather than a hand-rolled flow: verifying an ID token means
 * fetching keys, checking the signature, the issuer, the audience and the
 * nonce, and each is a place to be wrong in a way that still appears to work.
 *
 * Discovery is lazy and cached on globalThis (lib/process-state.ts), because
 * the login page, the start route and the callback are three bundler layers.
 * A failed discovery is logged and remembered for a minute: the login page
 * then offers passwords, OIDC_ONLY included, rather than waiting on a dead
 * provider at every visit.
 */

import * as client from 'openid-client'
import { processMap } from '../process-state'
import { oidcConfig, passwordSignInAllowed, type OidcConfig } from './oidc-config'

export const OIDC_CALLBACK_PATH = '/api/auth/oidc/callback'

/** The flow's state, verifier, nonce and return path; scoped to the two routes. */
export const OIDC_FLOW_COOKIE = 'mm_oidc'
export const OIDC_FLOW_PATH = '/api/auth/oidc'
export const OIDC_FLOW_TTL_SECONDS = 10 * 60

const RETRY_AFTER_FAILURE_MS = 60_000

/*
 * What is shared across layers is the provider's metadata, plain JSON, not the
 * Configuration built from it: openid-client is bundled into each layer, and a
 * Configuration made by one copy is refused by another's instanceof check.
 */
type Discovered = { at: number; metadata: client.ServerMetadata | null }

const discovered = processMap<Discovered>('oidc-discovery')

type Enabled = Extract<OidcConfig, { enabled: true }>

/* A plain-http issuer exists only on a developer's machine. */
function insecureAllowed(config: Enabled): boolean {
  return new URL(config.issuer).protocol === 'http:' && process.env.NODE_ENV !== 'production'
}

function configurationFor(config: Enabled, metadata: client.ServerMetadata): client.Configuration {
  const configuration = new client.Configuration(metadata, config.clientId, config.clientSecret)
  if (insecureAllowed(config)) client.allowInsecureRequests(configuration)
  return configuration
}

async function discover(config: Enabled): Promise<client.Configuration | null> {
  const cached = discovered.get(config.issuer)
  if (cached?.metadata) return configurationFor(config, cached.metadata)
  if (cached && Date.now() - cached.at < RETRY_AFTER_FAILURE_MS) return null

  try {
    const configuration = await client.discovery(
      new URL(config.issuer),
      config.clientId,
      config.clientSecret,
      undefined,
      insecureAllowed(config) ? { execute: [client.allowInsecureRequests] } : undefined,
    )
    discovered.set(config.issuer, { at: Date.now(), metadata: configuration.serverMetadata() })
    console.log(`[oidc] single sign-on enabled with ${config.issuer}`)
    return configuration
  } catch (err) {
    discovered.set(config.issuer, { at: Date.now(), metadata: null })
    console.error(
      `[oidc] discovery at ${config.issuer} failed; single sign-on is off and password ` +
        `sign-in stays open until it succeeds. ${err instanceof Error ? err.message : err}`,
    )
    return null
  }
}

export type SignInOptions = {
  /** The SSO button's label, or null when SSO is off or unreachable. */
  sso: { displayName: string } | null
  password: boolean
  /** For messages about SSO, reachable or not. */
  providerName: string
}

/** What the login page offers, and what loginAction accepts. */
export async function signInOptions(): Promise<SignInOptions> {
  const config = oidcConfig()
  if (!config.enabled) return { sso: null, password: true, providerName: 'Single sign-on' }

  const usable = (await discover(config)) !== null
  return {
    sso: usable ? { displayName: config.displayName } : null,
    password: passwordSignInAllowed(config, usable),
    providerName: config.displayName,
  }
}

/** Called once at server start: a half-set config fails the boot, and discovery logs early. */
export async function checkOidcAtBoot(): Promise<void> {
  const config = oidcConfig()
  if (config.enabled) await discover(config)
}

export type OidcFlow = { state: string; verifier: string; nonce: string; next: string }

/** The provider's authorization URL and the values the callback must match. Null when unusable. */
export async function beginOidc(
  redirectUri: string,
  next: string,
): Promise<{ url: string; flow: OidcFlow } | null> {
  const config = oidcConfig()
  if (!config.enabled) return null
  const configuration = await discover(config)
  if (!configuration) return null

  const verifier = client.randomPKCECodeVerifier()
  const state = client.randomState()
  const nonce = client.randomNonce()

  const url = client.buildAuthorizationUrl(configuration, {
    redirect_uri: redirectUri,
    scope: 'openid profile email',
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state,
    nonce,
  })

  return { url: url.href, flow: { state, verifier, nonce, next } }
}

export type VerifiedClaims = {
  issuer: string
  subject: string
  email: string | null
  emailVerified: boolean
}

/**
 * Exchange the callback for verified claims. Throws on anything that fails to
 * verify: state, PKCE, signature, issuer, audience, nonce.
 *
 * `callbackUrl` must be the public URL the provider redirected to, with its
 * query: behind the proxy, the request's own URL names the container.
 */
export async function completeOidc(callbackUrl: URL, flow: OidcFlow): Promise<VerifiedClaims> {
  const config = oidcConfig()
  if (!config.enabled) throw new Error('Single sign-on is not configured.')
  const configuration = await discover(config)
  if (!configuration) throw new Error('The identity provider is unreachable.')

  const tokens = await client.authorizationCodeGrant(configuration, callbackUrl, {
    pkceCodeVerifier: flow.verifier,
    expectedState: flow.state,
    expectedNonce: flow.nonce,
    idTokenExpected: true,
  })

  const claims = tokens.claims()
  if (!claims?.sub) throw new Error('The identity provider sent no subject.')

  return {
    issuer: claims.iss,
    subject: claims.sub,
    email: typeof claims.email === 'string' ? claims.email : null,
    /* Some providers send the string "true". Anything else is unverified,
       which is the safe direction: linking by email is what it gates. */
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
  }
}

/** The flow cookie's value. Not secret beyond this browser; httpOnly keeps scripts off it. */
export function encodeFlow(flow: OidcFlow): string {
  return Buffer.from(JSON.stringify(flow)).toString('base64url')
}

export function decodeFlow(raw: string | undefined): OidcFlow | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    if (typeof value !== 'object' || value === null) return null
    const { state, verifier, nonce, next } = value as Record<string, unknown>
    if (
      typeof state !== 'string' ||
      typeof verifier !== 'string' ||
      typeof nonce !== 'string' ||
      typeof next !== 'string'
    ) {
      return null
    }
    return { state, verifier, nonce, next }
  } catch {
    return null
  }
}
