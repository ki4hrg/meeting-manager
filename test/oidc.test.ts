import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { resolveOidcUser, type OidcIdentity } from '../lib/auth/oidc-account'
import { oidcConfig, passwordSignInAllowed } from '../lib/auth/oidc-config'
import { oidcErrorMessage } from '../lib/auth/oidc-errors'
import {
  beginOidc,
  completeOidc,
  decodeFlow,
  encodeFlow,
  signInOptions,
} from '../lib/auth/oidc'
import { createFirstUser } from '../lib/auth/users'
import { users } from '../lib/db/schema'
import { db, resetBetweenTests } from './helpers/db'

resetBetweenTests()

const ISSUER = 'https://id.example.test'
const account = { email: 'John@Example.test', displayName: 'John', password: 'correct horse battery' }

const identity = (over: Partial<OidcIdentity> = {}): OidcIdentity => ({
  issuer: ISSUER,
  subject: 'sub-1',
  email: 'john@example.test',
  emailVerified: true,
  ...over,
})

describe('oidcConfig', () => {
  it('is off with nothing set', () => {
    expect(oidcConfig({})).toEqual({ enabled: false })
  })

  it('refuses half a configuration, naming what is missing', () => {
    expect(() => oidcConfig({ OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: 'mm' })).toThrow(
      /OIDC_CLIENT_SECRET/,
    )
  })

  it('reads the rest, with defaults', () => {
    const config = oidcConfig({
      OIDC_ISSUER: `${ISSUER}/`,
      OIDC_CLIENT_ID: 'mm',
      OIDC_CLIENT_SECRET: 's',
    })
    expect(config).toEqual({
      enabled: true,
      issuer: ISSUER,
      clientId: 'mm',
      clientSecret: 's',
      displayName: 'Pocket ID',
      only: false,
      trustEmail: false,
    })
    const flagged = oidcConfig({
      OIDC_ISSUER: ISSUER,
      OIDC_CLIENT_ID: 'mm',
      OIDC_CLIENT_SECRET: 's',
      OIDC_DISPLAY_NAME: 'Home',
      OIDC_ONLY: 'true',
      OIDC_TRUST_EMAIL: '1',
    })
    expect(flagged).toMatchObject({ displayName: 'Home', only: true, trustEmail: true })
  })
})

describe('passwordSignInAllowed', () => {
  const on = oidcConfig({ OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: 'mm', OIDC_CLIENT_SECRET: 's' })
  const only = oidcConfig({
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: 'mm',
    OIDC_CLIENT_SECRET: 's',
    OIDC_ONLY: 'true',
  })

  it('refuses passwords only with OIDC_ONLY and a usable provider', () => {
    expect(passwordSignInAllowed(only, true)).toBe(false)
    expect(passwordSignInAllowed(only, false)).toBe(true)
    expect(passwordSignInAllowed(on, true)).toBe(true)
    expect(passwordSignInAllowed({ enabled: false }, false)).toBe(true)
  })
})

describe('resolveOidcUser', () => {
  it('refuses toward setup when there is no account, and never creates one', async () => {
    expect(await resolveOidcUser(identity(), { trustEmail: true }, db)).toEqual({
      kind: 'refused',
      reason: 'setup',
    })
    expect(await db.select().from(users)).toHaveLength(0)
  })

  it('links by verified email, then matches by subject', async () => {
    const user = await createFirstUser(account, db)

    expect(await resolveOidcUser(identity(), { trustEmail: false }, db)).toEqual({
      kind: 'user',
      userId: user.id,
      linked: true,
    })
    const [row] = await db.select().from(users).where(eq(users.id, user.id))
    expect(row).toMatchObject({ oidcIssuer: ISSUER, oidcSubject: 'sub-1' })

    // The address no longer matters once linked.
    expect(
      await resolveOidcUser(identity({ email: 'renamed@example.test', emailVerified: false }), { trustEmail: false }, db),
    ).toEqual({ kind: 'user', userId: user.id, linked: false })
  })

  it('matches the address in any case', async () => {
    const user = await createFirstUser(account, db)
    const result = await resolveOidcUser(identity({ email: 'JOHN@EXAMPLE.TEST' }), { trustEmail: false }, db)
    expect(result).toEqual({ kind: 'user', userId: user.id, linked: true })
  })

  it('refuses an unverified address unless the provider is trusted', async () => {
    const user = await createFirstUser(account, db)
    const unverified = identity({ emailVerified: false })

    expect(await resolveOidcUser(unverified, { trustEmail: false }, db)).toEqual({
      kind: 'refused',
      reason: 'unverified-email',
    })
    expect(await resolveOidcUser(unverified, { trustEmail: true }, db)).toEqual({
      kind: 'user',
      userId: user.id,
      linked: true,
    })
  })

  it('refuses an address that matches nothing, or no address at all', async () => {
    await createFirstUser(account, db)
    expect(
      await resolveOidcUser(identity({ email: 'someone@example.test' }), { trustEmail: true }, db),
    ).toEqual({ kind: 'refused', reason: 'no-account' })
    expect(await resolveOidcUser(identity({ email: null }), { trustEmail: true }, db)).toEqual({
      kind: 'refused',
      reason: 'no-account',
    })
  })

  it('never re-links an account carrying a different subject', async () => {
    const user = await createFirstUser(account, db)
    await resolveOidcUser(identity(), { trustEmail: false }, db)

    for (const other of [identity({ subject: 'sub-2' }), identity({ issuer: 'https://other.example.test' })]) {
      expect(await resolveOidcUser(other, { trustEmail: true }, db)).toEqual({
        kind: 'refused',
        reason: 'other-identity',
      })
    }
    const [row] = await db.select().from(users).where(eq(users.id, user.id))
    expect(row?.oidcSubject).toBe('sub-1')
  })
})

describe('oidcErrorMessage', () => {
  it('writes only the sentences it knows', () => {
    expect(oidcErrorMessage('unverified-email', 'Pocket ID')).toBe('Verify your email with Pocket ID first.')
    expect(oidcErrorMessage('Call this number', 'Pocket ID')).toBeUndefined()
    expect(oidcErrorMessage('toString', 'Pocket ID')).toBeUndefined()
    expect(oidcErrorMessage(undefined, 'Pocket ID')).toBeUndefined()
  })
})

describe('flow cookie', () => {
  it('round-trips, and refuses anything malformed', () => {
    const flow = { state: 's', verifier: 'v', nonce: 'n', next: '/oauth/authorize?x=1' }
    expect(decodeFlow(encodeFlow(flow))).toEqual(flow)
    expect(decodeFlow(undefined)).toBeNull()
    expect(decodeFlow('not-json')).toBeNull()
    expect(decodeFlow(Buffer.from('{"state":1}').toString('base64url'))).toBeNull()
  })
})

/*
 * A provider on loopback: discovery, keys and a token endpoint that signs an ID
 * token with whatever nonce the authorization request carried. Plain http,
 * which oidc.ts allows outside production only.
 */
describe('against a provider', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }
  const codes = new Map<string, { nonce: string; challenge: string }>()
  let server: Server
  let issuer: string
  const saved = { ...process.env }

  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', issuer)
      const json = (body: unknown) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(body))
      }
      if (url.pathname === '/.well-known/openid-configuration') {
        return json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
        })
      }
      if (url.pathname === '/jwks') return json({ keys: [jwk] })
      if (url.pathname === '/token') {
        let body = ''
        req.on('data', (chunk) => (body += chunk))
        req.on('end', () => {
          const form = new URLSearchParams(body)
          const grant = codes.get(form.get('code') ?? '')
          const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url')
          if (!grant || grant.challenge !== challenge) {
            res.statusCode = 400
            return json({ error: 'invalid_grant' })
          }
          const now = Math.floor(Date.now() / 1000)
          const head = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' })
          const claims = b64({
            iss: issuer,
            aud: 'mm',
            sub: 'pocket-sub',
            iat: now,
            exp: now + 300,
            nonce: grant.nonce,
            email: 'John@Example.test',
            email_verified: false,
          })
          const signature = sign('RSA-SHA256', Buffer.from(`${head}.${claims}`), privateKey).toString('base64url')
          json({ access_token: 'at', token_type: 'Bearer', id_token: `${head}.${claims}.${signature}` })
        })
        return
      }
      res.statusCode = 404
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(() => {
    process.env = { ...saved }
  })

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  it('offers SSO and, with OIDC_ONLY, refuses passwords', async () => {
    Object.assign(process.env, {
      OIDC_ISSUER: issuer,
      OIDC_CLIENT_ID: 'mm',
      OIDC_CLIENT_SECRET: 'secret',
      OIDC_ONLY: 'true',
    })
    expect(await signInOptions()).toEqual({
      sso: { displayName: 'Pocket ID' },
      password: false,
      providerName: 'Pocket ID',
    })
  })

  it('keeps passwords open under OIDC_ONLY when discovery fails', async () => {
    Object.assign(process.env, {
      OIDC_ISSUER: `${issuer}/missing-${randomUUID()}`,
      OIDC_CLIENT_ID: 'mm',
      OIDC_CLIENT_SECRET: 'secret',
      OIDC_ONLY: 'true',
    })
    expect(await signInOptions()).toMatchObject({ sso: null, password: true })
    expect(await beginOidc('https://meetings.example.test/api/auth/oidc/callback', '/')).toBeNull()
  })

  it('runs the code flow with PKCE, state and nonce, and refuses a mismatched state', async () => {
    Object.assign(process.env, { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: 'mm', OIDC_CLIENT_SECRET: 'secret' })
    const redirectUri = 'https://meetings.example.test/api/auth/oidc/callback'

    const begun = await beginOidc(redirectUri, '/oauth/authorize?client_id=c')
    expect(begun).not.toBeNull()
    const url = new URL(begun!.url)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toBe('openid profile email')
    expect(url.searchParams.get('state')).toBe(begun!.flow.state)
    expect(url.searchParams.get('nonce')).toBe(begun!.flow.nonce)
    expect(begun!.flow.next).toBe('/oauth/authorize?client_id=c')

    codes.set('code-1', {
      nonce: url.searchParams.get('nonce')!,
      challenge: url.searchParams.get('code_challenge')!,
    })

    const forged = new URL(`${redirectUri}?code=code-1&state=someone-else`)
    await expect(completeOidc(forged, begun!.flow)).rejects.toThrow()

    const callback = new URL(`${redirectUri}?code=code-1&state=${begun!.flow.state}`)
    expect(await completeOidc(callback, begun!.flow)).toEqual({
      issuer,
      subject: 'pocket-sub',
      email: 'John@Example.test',
      emailVerified: false,
    })
  })
})
