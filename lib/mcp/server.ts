/*
 * The MCP server, built per request from the token that authenticated it.
 *
 * There is no MCP session state: every call carries its own credentials, so the
 * tool surface a connection sees is a function of the token in front of it.
 *
 * The low-level Server rather than McpServer, so that tools/list can be
 * filtered by scope and a call to a tool the connection may not use is answered
 * with a refusal that names the scope, not a protocol error.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { AppError, type Executor } from '../core/types'
import { syncTodoistSoon } from '../jobs'
import type { BearerIdentity } from '../oauth/grants'
import { actorFor } from './auth'
import { granted, refusalFor } from './scopes'
import { ToolRefusal, type ToolContext, type ToolDefinition } from './tools/types'
import { directoryTools } from './tools/directory'
import { itemTools } from './tools/items'
import { meetingTools } from './tools/meetings'
import { processingTools } from './tools/processing'
import { whoamiTool } from './tools/whoami'

export const SERVER_NAME = 'meeting-manager'
export const SERVER_VERSION = '0.1.0'

/** Every tool that exists, at every scope. Filtered per connection. */
export const allTools: ToolDefinition[] = [
  whoamiTool,
  ...itemTools,
  ...directoryTools,
  ...meetingTools,
  ...processingTools,
]

export function toolsFor(identity: BearerIdentity): ToolDefinition[] {
  return allTools.filter((tool) => granted(identity, tool.scope))
}

export function createMcpServer(identity: BearerIdentity, exec: Executor): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'Meeting Manager captures topics, questions, actions and decisions, builds agendas ' +
        'from them, and tracks what meetings leave behind, across separate working contexts. ' +
        'A context is a hard boundary: nothing crosses between them. People, groups, projects, ' +
        'series and contexts can be named instead of looked up by id; an ambiguous name is ' +
        'refused with its candidates. A meeting is named by its id. Times are given in ISO and ' +
        'as they read on the account clock.',
    },
  )

  const context: ToolContext = { exec, actor: actorFor(identity), identity }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    // Filtered by scope for ergonomics; the call handler is the enforcement.
    tools: toolsFor(identity).map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: jsonSchemaFor(tool),
      annotations: { title: tool.title, ...tool.annotations },
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = allTools.find((candidate) => candidate.name === request.params.name)

    if (!tool) {
      return errorResult(
        `There is no tool called ${request.params.name}.`,
        'Call tools/list to see what this connection can do.',
      )
    }

    // Computed from the live token on every call: a tool list can be stale.
    if (!granted(identity, tool.scope)) return errorResult(refusalFor(tool.scope))

    const parsed = tool.input.safeParse(request.params.arguments ?? {})
    if (!parsed.success) {
      /* Returned as content rather than thrown as a protocol error: a model
         can correct "context_id must be a uuid". */
      return errorResult(
        `Those arguments are not valid for ${tool.name}.`,
        z.prettifyError(parsed.error),
      )
    }

    try {
      const result = await tool.handler(parsed.data, context)
      if (!tool.annotations?.readOnlyHint) syncTodoistSoon()
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result as Record<string, unknown>,
      }
    } catch (err) {
      if (err instanceof ToolRefusal) return errorResult(err.message, err.hint)

      // The domain layer refusing for a reason it can state.
      if (err instanceof AppError) return errorResult(err.message)

      console.error('[mcp] tool failed', { tool: tool.name, err })
      return errorResult(
        `${tool.name} failed unexpectedly. Nothing was changed.`,
        'Try again, or report this if it keeps happening.',
      )
    }
  })

  return server
}

function errorResult(message: string, hint?: string): CallToolResult {
  return {
    content: [{ type: 'text' as const, text: hint ? `${message}\n\n${hint}` : message }],
    isError: true,
  }
}

/* The JSON Schema is generated from the same zod object that parses the
   arguments, so the advertised shape cannot drift from what is accepted. */
const schemaCache = new WeakMap<ToolDefinition, Record<string, unknown>>()

function jsonSchemaFor(tool: ToolDefinition): Record<string, unknown> {
  const cached = schemaCache.get(tool)
  if (cached) return cached

  const schema = z.toJSONSchema(tool.input, { io: 'input' }) as Record<string, unknown>
  delete schema.$schema
  schemaCache.set(tool, schema)
  return schema
}
