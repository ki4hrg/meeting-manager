/*
 * POST /api/mcp — the MCP endpoint.
 *
 * Under app/api/, so it authenticates itself. Nothing here is guarded by
 * placement, and this is the one route in the app where the
 * refusal has to be a specific shape: a bare 401 stalls OAuth discovery, because
 * the client has no way to find the metadata document and gives up with an error
 * that names nothing. See unauthorized() in lib/mcp/auth.ts.
 *
 * Streamable HTTP with no session state. The SDK's Web-standard transport takes
 * a Request and returns a Response, which is exactly the shape a Route Handler
 * has, so there is no Node-adapter shim in the middle. `sessionIdGenerator:
 * undefined` is what makes it stateless: no Mcp-Session-Id is issued or
 * required, no request depends on reaching the container that served the last
 * one, and a restart mid-conversation is invisible.
 *
 * `enableJsonResponse` because a pure tool server has nothing to stream. Every
 * response here is the answer to one call, and holding an SSE stream open to
 * deliver a single message is a connection kept alive for no reason.
 */

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { db } from '@/lib/db'
import { bearerFrom, unauthorized } from '@/lib/mcp/auth'
import { createMcpServer } from '@/lib/mcp/server'
import { resolveBearer } from '@/lib/oauth/grants'
import { corsHeaders, preflight } from '@/lib/oauth/http'

export const dynamic = 'force-dynamic'

/* Node, not Edge: the domain layer talks to Postgres over a TCP socket. */
export const runtime = 'nodejs'

async function handle(request: Request): Promise<Response> {
  const identity = await resolveBearer(db, bearerFrom(request))
  if (!identity) return unauthorized()

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })

  const server = createMcpServer(identity, db)
  await server.connect(transport)

  try {
    const response = await transport.handleRequest(request)

    /* CORS on the response the transport built, rather than on a wrapper: the
       body is already a stream by the time we see it, and copying it to add
       headers would buffer every reply for no reason. */
    const headers = new Headers(response.headers)
    for (const [key, value] of Object.entries(corsHeaders())) headers.set(key, value)

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  } finally {
    /* One request, one server. In JSON mode handleRequest resolves only once
       every response in the batch is written, so closing here cannot truncate a
       reply — and not closing would leak a transport per call. */
    await server.close()
  }
}

export async function POST(request: Request) {
  return handle(request)
}

/*
 * GET opens the server-to-client notification stream, and DELETE ends a session.
 * Neither exists here: this server never initiates anything — no subscriptions,
 * no progress, no resources that change — and there are no sessions to end.
 *
 * Answered here rather than delegated to the transport, which would happily open
 * an SSE stream and hold it forever waiting for a message that is never coming.
 * One idle connection per client, kept alive to deliver nothing, is a real cost
 * on a homelab behind a proxy with its own idle timeouts.
 *
 * Authenticated first, deliberately. An unauthenticated GET is a discovery probe
 * and deserves the same WWW-Authenticate as everything else; answering 405
 * before checking the token would tell a client the endpoint is broken rather
 * than that it needs to log in.
 */
export async function GET(request: Request) {
  return methodNotAllowed(request)
}

export async function DELETE(request: Request) {
  return methodNotAllowed(request)
}

async function methodNotAllowed(request: Request): Promise<Response> {
  const identity = await resolveBearer(db, bearerFrom(request))
  if (!identity) return unauthorized()

  return Response.json(
    {
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message:
          'This server has no server-initiated stream and no sessions. Send tool calls as POST.',
      },
      id: null,
    },
    { status: 405, headers: { ...corsHeaders(), allow: 'POST, OPTIONS' } },
  )
}

export async function OPTIONS() {
  return preflight()
}
