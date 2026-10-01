import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { registerClient } from '../lib/oauth/clients'
import { consumeAuthorizationCode, issueAuthorizationCode, s256 } from '../lib/oauth/codes'
import { issueTokenPair, resolveBearer, rotateRefreshToken } from '../lib/oauth/grants'
import { db, resetBetweenTests } from './helpers/db'
import { makeUser } from './helpers/mcp'

resetBetweenTests()

const REDIRECT = 'http://127.0.0.1:53211/callback'
const RESOURCE = 'https://meetings.example.test/api/mcp'

async function authorized() {
  const userId = await makeUser()
  const client = await registerClient(db, { clientName: 'Inspector', redirectUris: [REDIRECT] })
  const verifier = randomBytes(32).toString('base64url')
  const { code } = await issueAuthorizationCode(db, {
    clientId: client.id,
    userId,
    redirectUri: REDIRECT,
    scopes: ['meetings:read', 'meetings:write'],
    resource: RESOURCE,
    codeChallenge: s256(verifier),
  })
  return { userId, client, verifier, code }
}

describe('registration', () => {
  it('accepts a loopback redirect and refuses an arbitrary one', async () => {
    const client = await registerClient(db, { clientName: 'Local', redirectUris: [REDIRECT] })
    expect(client.id).toMatch(/^mm_/)

    await expect(
      registerClient(db, { clientName: 'Evil', redirectUris: ['https://evil.example/cb'] }),
    ).rejects.toThrow()
  })
})

describe('authorization code', () => {
  it('exchanges with the right verifier for a token that resolves', async () => {
    const { userId, client, verifier, code } = await authorized()

    const consumed = await consumeAuthorizationCode(db, {
      code,
      clientId: client.id,
      redirectUri: REDIRECT,
      codeVerifier: verifier,
    })
    const pair = await issueTokenPair(db, {
      clientId: consumed.clientId,
      userId: consumed.userId,
      scopes: consumed.scopes,
      resource: consumed.resource,
    })

    const identity = await resolveBearer(db, pair.accessToken)
    expect(identity).toMatchObject({
      userId,
      clientId: client.id,
      scopes: ['meetings:read', 'meetings:write'],
    })
    // A refresh token is not a bearer token.
    expect(await resolveBearer(db, pair.refreshToken)).toBeNull()
  })

  it('refuses the wrong verifier', async () => {
    const { client, code } = await authorized()
    await expect(
      consumeAuthorizationCode(db, {
        code,
        clientId: client.id,
        redirectUri: REDIRECT,
        codeVerifier: randomBytes(32).toString('base64url'),
      }),
    ).rejects.toThrow()
  })

  it('refuses a second exchange of the same code', async () => {
    const { client, verifier, code } = await authorized()
    const exchange = () =>
      consumeAuthorizationCode(db, {
        code,
        clientId: client.id,
        redirectUri: REDIRECT,
        codeVerifier: verifier,
      })

    await exchange()
    await expect(exchange()).rejects.toThrow(/already been used/)
  })
})

describe('refresh', () => {
  it('rotates, and treats reuse of a rotated token as theft', async () => {
    const { userId, client } = await authorized()
    const first = await issueTokenPair(db, {
      clientId: client.id,
      userId,
      scopes: ['meetings:read'],
      resource: RESOURCE,
    })

    const second = await rotateRefreshToken(db, {
      refreshToken: first.refreshToken,
      clientId: client.id,
    })
    expect(await resolveBearer(db, second.accessToken)).not.toBeNull()

    await expect(
      rotateRefreshToken(db, { refreshToken: first.refreshToken, clientId: client.id }),
    ).rejects.toThrow(/already been used/)

    // The whole grant is gone, including the pair issued by the first rotation.
    expect(await resolveBearer(db, second.accessToken)).toBeNull()
  })
})
