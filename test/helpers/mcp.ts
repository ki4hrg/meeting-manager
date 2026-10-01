/*
 * An MCP client wired to the real server over the SDK's in-memory transport, so
 * tests go through initialize, tools/list and tools/call rather than calling
 * handlers directly.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { users } from '../../lib/db/schema'
import { createMcpServer } from '../../lib/mcp/server'
import type { Scope } from '../../lib/oauth/config'
import type { BearerIdentity } from '../../lib/oauth/grants'
import { db } from './db'

export async function makeUser(email = 'john@example.test'): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email, displayName: 'John', passwordHash: 'not-a-real-hash' })
    .returning()
  return user!.id
}

export function identityFor(
  userId: string,
  scopes: Scope[] = ['meetings:read', 'meetings:write'],
): BearerIdentity {
  return {
    userId,
    clientId: 'mm_test_client',
    clientName: 'Claude',
    scopes,
    resource: 'https://meetings.example.test/api/mcp',
  }
}

export type ConnectedClient = { client: Client; close: () => Promise<void> }

export async function connect(identity: BearerIdentity): Promise<ConnectedClient> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createMcpServer(identity, db)
  const client = new Client({ name: 'test', version: '0' })

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

/** The text a tool result carries, which is where refusals live. */
export function textOf(result: CallToolResult): string {
  return result.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

export function dataOf<T = Record<string, unknown>>(result: CallToolResult): T {
  return result.structuredContent as T
}
