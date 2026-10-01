import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { registerClient } from '../lib/oauth/clients'
import { issueTokenPair } from '../lib/oauth/grants'
import { databaseUrl, db, resetBetweenTests } from './helpers/db'
import { connect, dataOf, identityFor, makeUser, textOf } from './helpers/mcp'

resetBetweenTests()

// The Route Handler imports `@/lib/db`, which reads this on first use.
process.env.DATABASE_URL = databaseUrl

describe('tools', () => {
  it('lists and answers whoami for a read connection', async () => {
    const userId = await makeUser()
    const { client, close } = await connect(identityFor(userId))

    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toContain('whoami')

    const result = (await client.callTool({ name: 'whoami', arguments: {} })) as CallToolResult
    expect(result.isError).toBeFalsy()
    expect(dataOf(result)).toMatchObject({ email: 'john@example.test', client: 'Claude' })

    await close()
  })

  it('hides and refuses a tool the connection has no scope for', async () => {
    const userId = await makeUser()
    const { client, close } = await connect(identityFor(userId, ['meetings:write']))

    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).not.toContain('whoami')

    const result = (await client.callTool({ name: 'whoami', arguments: {} })) as CallToolResult
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('meetings:read')

    await close()
  })
})

describe('POST /api/mcp', () => {
  const url = 'https://meetings.example.test/api/mcp'
  const listTools = (headers: Record<string, string> = {}) =>
    new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })

  it('answers 401 with the metadata location when there is no token', async () => {
    const { POST } = await import('../app/api/mcp/route')
    const response = await POST(listTools())

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain(
      'resource_metadata="https://meetings.example.test/.well-known/oauth-protected-resource/api/mcp"',
    )
  })

  it('serves a caller holding a live access token', async () => {
    const userId = await makeUser()
    const oauthClient = await registerClient(db, {
      clientName: 'Inspector',
      redirectUris: ['http://127.0.0.1:53211/callback'],
    })
    const pair = await issueTokenPair(db, {
      clientId: oauthClient.id,
      userId,
      scopes: ['meetings:read'],
      resource: url,
    })

    const { POST } = await import('../app/api/mcp/route')
    const response = await POST(listTools({ authorization: `Bearer ${pair.accessToken}` }))

    expect(response.status).toBe(200)
    const body = (await response.json()) as { result: { tools: Array<{ name: string }> } }
    expect(body.result.tools.map((tool) => tool.name)).toContain('whoami')
  })
})
