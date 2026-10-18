/*
 * The Todoist account as a row in `connections`, and the Todoist projects that
 * contexts and projects send their tasks to.
 *
 * Connected through the instance's own registered Todoist app (OAuth, the
 * `TODOIST_CLIENT_*` variables), which is also what makes Todoist deliver
 * webhooks for the account. One account: it is John's task list.
 *
 * Tokens from a newly registered app last an hour and come with a refresh
 * token that changes on every use, so a refresh is done under a lock on the
 * connection row: two refreshing at once would leave one holding a refresh
 * token Todoist has already replaced.
 *
 * Where an item's task goes (docs/SPEC.md, item 11): its project's own
 * binding, else the nearest bound ancestor's, else its context's, else the
 * Inbox. Set when the task is made and never moved.
 */

import { and, eq, isNull, sql } from 'drizzle-orm'
import { NotFoundError, ValidationError, inTransaction, type Executor } from '../../core/types'
import { bindings, connections, projects } from '../../db/schema'
import { getContext } from '../../directory/contexts'
import {
  ConnectionError,
  assertScopeIn,
  clearConnectionError,
  recordConnectionError,
  sealCredentials,
  scopeColumns,
  unsealCredentials,
  type Binding,
  type Connection,
} from '../connections'
import {
  TodoistApiError,
  TodoistUnauthorized,
  refreshTokens,
  tokenOwner,
  type TodoistTokens,
} from './client'

export const TODOIST = 'todoist'
export const PROJECT_KIND = 'todoist_project'

export const CALLBACK_PATH = '/api/connect/todoist/callback'
export const WEBHOOK_PATH = '/api/webhooks/todoist'

/** The cookie that carries the OAuth state from `start` to `callback`. */
export const STATE_COOKIE = 'todoist_oauth_state'

/** The registered app, when this instance has one. */
export function todoistApp(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.TODOIST_CLIENT_ID?.trim()
  const clientSecret = process.env.TODOIST_CLIENT_SECRET?.trim()
  return clientId && clientSecret ? { clientId, clientSecret } : null
}

export function todoistConfigured(): boolean {
  return todoistApp() !== null
}

/** Refused at boot: half an app is a Connect button that cannot work. */
export function checkTodoistAtBoot(): void {
  const set = [process.env.TODOIST_CLIENT_ID, process.env.TODOIST_CLIENT_SECRET].filter((value) =>
    value?.trim(),
  ).length
  if (set === 1) throw new Error('Set both TODOIST_CLIENT_ID and TODOIST_CLIENT_SECRET, or neither.')
}

type Row = typeof connections.$inferSelect

function withoutCredentials(row: Row): Connection {
  const rest: Partial<Row> = { ...row }
  delete rest.credentials
  return rest as Connection
}

/** The connected account, if there is one. */
export async function todoistConnection(exec: Executor): Promise<Connection | null> {
  const [row] = await exec
    .select()
    .from(connections)
    .where(eq(connections.provider, TODOIST))
    .orderBy(connections.createdAt)
    .limit(1)
  return row ? withoutCredentials(row) : null
}

// ─── tokens ──────────────────────────────────────────────────────────────────

/* Refreshed this long before the expiry Todoist gave. */
const EXPIRY_MARGIN_MS = 60_000

/** A usable access token, refreshed first when it has run out (or `force`). */
export async function todoistToken(
  exec: Executor,
  connectionId: string,
  { force = false }: { force?: boolean } = {},
): Promise<string> {
  return inTransaction(exec, async (tx) => {
    const [row] = await tx
      .select()
      .from(connections)
      .where(and(eq(connections.id, connectionId), eq(connections.provider, TODOIST)))
      .for('update')
      .limit(1)
    if (!row) throw new NotFoundError('Connection', connectionId)

    const held = unsealCredentials<TodoistTokens>(row.credentials)
    if (!held) throw new ConnectionError('The stored Todoist credentials cannot be read. Connect again.')

    const live = held.expiresAt === null || held.expiresAt > Date.now() + EXPIRY_MARGIN_MS
    if (live && !force) return held.accessToken
    if (!held.refreshToken) {
      if (force) throw new TodoistUnauthorized()
      return held.accessToken
    }

    const app = todoistApp()
    if (!app) throw new ConnectionError('Todoist is not configured on this instance.')
    const fresh = await refreshTokens(app, held.refreshToken)
    await tx
      .update(connections)
      .set({
        credentials: sealCredentials({ ...fresh, refreshToken: fresh.refreshToken ?? held.refreshToken }),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, connectionId))
    return fresh.accessToken
  })
}

/**
 * Call Todoist as the account. A 401 gets the token refreshed and the call
 * made once more. A failure is recorded on the connection for Settings and
 * thrown; a success clears what was recorded.
 */
export async function withTodoist<T>(
  exec: Executor,
  connectionId: string,
  call: (token: string) => Promise<T>,
): Promise<T> {
  try {
    let result: T
    try {
      result = await call(await todoistToken(exec, connectionId))
    } catch (err) {
      if (!(err instanceof TodoistUnauthorized)) throw err
      result = await call(await todoistToken(exec, connectionId, { force: true }))
    }
    await clearConnectionError(exec, connectionId)
    return result
  } catch (err) {
    if (err instanceof ConnectionError || err instanceof TodoistApiError) {
      await recordConnectionError(exec, connectionId, err)
    }
    throw err
  }
}

// ─── connecting ──────────────────────────────────────────────────────────────

/**
 * Store the tokens a completed sign-in gave. Connecting the same account again
 * replaces its tokens and keeps its links; another account is refused while
 * one is connected, since every link points into the first one's tasks.
 */
export async function saveTodoistConnection(
  exec: Executor,
  tokens: TodoistTokens,
): Promise<{ connection: Connection; created: boolean }> {
  const owner = await tokenOwner(tokens.accessToken)
  const account = owner.email.trim().toLowerCase()
  const existing = await todoistConnection(exec)
  if (existing && existing.account.toLowerCase() !== account) {
    throw new ValidationError(`Todoist is connected as ${existing.account}. Disconnect it first.`)
  }

  const values = { account, credentials: sealCredentials(tokens), scopes: 'data:read_write,data:delete', lastError: null }
  const [row] = existing
    ? await exec
        .update(connections)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(connections.id, existing.id))
        .returning()
    : await exec
        .insert(connections)
        .values({ provider: TODOIST, ...values })
        .returning()
  return { connection: withoutCredentials(row!), created: !existing }
}

/**
 * Remove the account, and with it every link, binding and cached task. The
 * tasks stay in Todoist as they are; connecting again starts the matching
 * over.
 */
export async function disconnectTodoist(exec: Executor, connectionId: string): Promise<void> {
  await exec
    .delete(connections)
    .where(and(eq(connections.id, connectionId), eq(connections.provider, TODOIST)))
}

// ─── projects ────────────────────────────────────────────────────────────────

/**
 * Send a context's tasks, or one project's, to a Todoist project. A Todoist
 * project takes one place, so binding it again moves it. Tasks already made
 * stay where they are.
 */
export async function bindTodoistProject(
  exec: Executor,
  input: {
    connectionId: string
    todoistProjectId: string
    name: string
    contextId: string
    projectId?: string | null
  },
): Promise<Binding> {
  const externalId = input.todoistProjectId.trim()
  if (externalId === '') throw new ValidationError('Pick a Todoist project.')
  await getContext(exec, input.contextId)
  const scope = input.projectId ? ({ kind: 'project', id: input.projectId } as const) : null
  await assertScopeIn(exec, input.contextId, scope)

  /* A context, or a project, sends to one Todoist project: binding a second
     takes over from the first. */
  await exec
    .delete(bindings)
    .where(
      and(
        eq(bindings.connectionId, input.connectionId),
        eq(bindings.kind, PROJECT_KIND),
        eq(bindings.contextId, input.contextId),
        input.projectId ? eq(bindings.projectId, input.projectId) : isNull(bindings.projectId),
        sql`${bindings.externalId} <> ${externalId}`,
      ),
    )

  const name = input.name.trim() || externalId
  const [row] = await exec
    .insert(bindings)
    .values({
      connectionId: input.connectionId,
      kind: PROJECT_KIND,
      externalId,
      name,
      contextId: input.contextId,
      ...scopeColumns(scope),
    })
    .onConflictDoUpdate({
      target: [bindings.connectionId, bindings.kind, bindings.externalId],
      set: { contextId: input.contextId, name, ...scopeColumns(scope) },
    })
    .returning()
  return row!
}

export async function unbindTodoistProject(
  exec: Executor,
  input: { connectionId: string; todoistProjectId: string },
): Promise<void> {
  await exec
    .delete(bindings)
    .where(
      and(
        eq(bindings.connectionId, input.connectionId),
        eq(bindings.kind, PROJECT_KIND),
        eq(bindings.externalId, input.todoistProjectId),
      ),
    )
}

export async function listTodoistBindings(exec: Executor, connectionId: string): Promise<Binding[]> {
  return exec
    .select()
    .from(bindings)
    .where(and(eq(bindings.connectionId, connectionId), eq(bindings.kind, PROJECT_KIND)))
    .orderBy(sql`lower(${bindings.name})`)
}

/* Deeper than anyone nests projects; a guard against a loop, not a limit. */
const MAX_DEPTH = 20

/**
 * The Todoist project an item's task goes to: its project's binding, the
 * nearest bound ancestor's, its context's, or null for the Inbox.
 */
export async function todoistProjectFor(
  exec: Executor,
  connectionId: string,
  item: { contextId: string; projectId: string | null },
): Promise<string | null> {
  const bound = await listTodoistBindings(exec, connectionId)
  const byProject = new Map(bound.filter((one) => one.projectId).map((one) => [one.projectId!, one]))

  let current = item.projectId
  for (let depth = 0; current && depth < MAX_DEPTH; depth++) {
    const binding = byProject.get(current)
    if (binding) return binding.externalId
    const [row] = await exec
      .select({ parentId: projects.parentId })
      .from(projects)
      .where(eq(projects.id, current))
      .limit(1)
    current = row?.parentId ?? null
  }

  const context = bound.find(
    (one) => one.contextId === item.contextId && !one.projectId && !one.seriesId && !one.groupId,
  )
  return context?.externalId ?? null
}
