/*
 * Todoist over its v1 API: the sync endpoint (one request reads the change
 * feed and writes a batch of commands), the project list, the OAuth token
 * exchange, and the webhook signature.
 *
 * Every function takes the access token or the app's credentials, so nothing
 * here touches the database; `connection.ts` is where tokens are stored,
 * refreshed and a failure is recorded.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { ConnectionError } from '../connections'

/* Overridden only by the browser tests, which run a Todoist of their own. */
export const API_BASE = process.env.TODOIST_API_BASE || 'https://api.todoist.com'
export const AUTHORIZE_URL = 'https://app.todoist.com/oauth/authorize'

/* Read and write tasks, and delete the one made for an accept that was undone. */
export const SCOPE = 'data:read_write,data:delete'

/** Todoist refused the token. Nothing will work until John connects again. */
export class TodoistUnauthorized extends ConnectionError {
  constructor() {
    super('Todoist no longer accepts this connection. Connect again.')
  }
}

/** Todoist said no, and it is not the token. */
export class TodoistApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** 429 and 5xx: the same request later is likely to work. */
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'TodoistApiError'
  }
}

async function failure(response: Response, what: string): Promise<never> {
  if (response.status === 401 || response.status === 403) throw new TodoistUnauthorized()
  const body = await response.text().catch(() => '')
  throw new TodoistApiError(
    `Todoist answered ${response.status} for ${what}${body ? `: ${body.slice(0, 200)}` : ''}`,
    response.status,
    response.status === 429 || response.status >= 500,
  )
}

// ─── the shapes ──────────────────────────────────────────────────────────────

export type TodoistTask = {
  id: string
  project_id: string | null
  content: string
  description?: string
  checked: boolean
  is_deleted: boolean
  completed_at?: string | null
  deadline?: { date: string } | null
  due?: { date: string; is_recurring?: boolean } | null
  updated_at?: string | null
}

/** A comment on a task: Todoist calls them notes. */
export type TodoistNote = {
  id: string
  item_id: string
  content: string
  posted_at: string
  is_deleted: boolean
}

export type TodoistProject = {
  id: string
  name: string
  parent_id: string | null
  inbox_project?: boolean
  is_archived?: boolean
  is_deleted?: boolean
  child_order?: number
}

export type TodoistUser = { id: string; email: string; full_name?: string | null }

export type Command = {
  type: string
  uuid: string
  temp_id?: string
  args: Record<string, unknown>
}

export type SyncResponse = {
  sync_token: string
  full_sync: boolean
  items?: TodoistTask[]
  notes?: TodoistNote[]
  /* "ok", or what went wrong with that one command. */
  sync_status?: Record<string, 'ok' | { error?: string; error_code?: number }>
  temp_id_mapping?: Record<string, string>
}

// ─── reads and writes ────────────────────────────────────────────────────────

/** At most this many commands in one request. */
export const MAX_COMMANDS = 100

/**
 * One call to the sync endpoint: the tasks and their comments changed since
 * `syncToken` ('*' for all of them), and the commands, applied in order.
 */
export async function todoistSync(
  token: string,
  request: { syncToken?: string | null; commands?: Command[] },
): Promise<SyncResponse> {
  const body = new URLSearchParams()
  if (request.syncToken !== undefined) {
    body.set('sync_token', request.syncToken ?? '*')
    body.set('resource_types', JSON.stringify(['items', 'notes']))
  }
  if (request.commands && request.commands.length > 0) {
    body.set('commands', JSON.stringify(request.commands))
  }

  const response = await fetch(`${API_BASE}/api/v1/sync`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body,
  })
  if (!response.ok) await failure(response, '/api/v1/sync')
  return (await response.json()) as SyncResponse
}

/* A runaway guard against a cursor that never ends, not a limit anyone meets. */
const MAX_PAGES = 40

/** Every project the account can see, archived ones left out. */
export async function listProjects(token: string): Promise<TodoistProject[]> {
  const all: TodoistProject[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL('/api/v1/projects', API_BASE)
    url.searchParams.set('limit', '200')
    if (cursor) url.searchParams.set('cursor', cursor)
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    })
    if (!response.ok) await failure(response, '/api/v1/projects')
    const body = (await response.json()) as { results: TodoistProject[]; next_cursor: string | null }
    all.push(...body.results)
    cursor = body.next_cursor
    if (!cursor) break
  }
  return all.filter((project) => !project.is_archived && !project.is_deleted)
}

/** One task, completed ones included. Null when Todoist no longer has it. */
export async function getTask(token: string, taskId: string): Promise<TodoistTask | null> {
  const response = await fetch(`${API_BASE}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  })
  if (response.status === 404) return null
  if (!response.ok) await failure(response, '/api/v1/tasks/:id')
  return (await response.json()) as TodoistTask
}

/** Whose token this is. */
export async function tokenOwner(token: string): Promise<TodoistUser> {
  const response = await fetch(`${API_BASE}/api/v1/user`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  })
  if (!response.ok) await failure(response, '/api/v1/user')
  return (await response.json()) as TodoistUser
}

// ─── OAuth ───────────────────────────────────────────────────────────────────

export type TodoistTokens = {
  accessToken: string
  /* None for an app made before Todoist issued refresh tokens: its access
     token does not expire. */
  refreshToken: string | null
  /** Epoch milliseconds. */
  expiresAt: number | null
}

export function authorizeUrl(clientId: string, state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    scope: SCOPE,
    state,
    response_type: 'code',
    redirect_uri: redirectUri,
  })
  return `${AUTHORIZE_URL}?${params.toString()}`
}

async function tokenRequest(fields: Record<string, string>): Promise<TodoistTokens> {
  const response = await fetch(`${API_BASE}/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(fields),
  })
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    error?: string
  }
  if (!response.ok || !body.access_token) {
    if (response.status >= 500 || response.status === 429) {
      throw new TodoistApiError(`Todoist answered ${response.status} for a token.`, response.status, true)
    }
    throw new ConnectionError(
      `Todoist refused the sign-in${body.error ? ` (${body.error})` : ''}. Connect again.`,
    )
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : null,
  }
}

export function exchangeCode(
  app: { clientId: string; clientSecret: string },
  code: string,
  redirectUri: string,
): Promise<TodoistTokens> {
  return tokenRequest({
    client_id: app.clientId,
    client_secret: app.clientSecret,
    code,
    redirect_uri: redirectUri,
  })
}

/** A new access token, and the refresh token that replaces the one used. */
export function refreshTokens(
  app: { clientId: string; clientSecret: string },
  refreshToken: string,
): Promise<TodoistTokens> {
  return tokenRequest({
    client_id: app.clientId,
    client_secret: app.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
}

// ─── webhooks ────────────────────────────────────────────────────────────────

/** The signature Todoist puts on a delivery: HMAC-SHA256 of the raw body, base64, keyed with the client secret. */
export function signWebhook(body: string, clientSecret: string): string {
  return createHmac('sha256', clientSecret).update(body, 'utf8').digest('base64')
}

export function verifyWebhook(body: string, signature: string | null, clientSecret: string): boolean {
  if (!signature) return false
  const expected = Buffer.from(signWebhook(body, clientSecret))
  const given = Buffer.from(signature.trim())
  return expected.length === given.length && timingSafeEqual(expected, given)
}

/** Where a task opens in Todoist's web app. */
export function taskUrl(taskId: string): string {
  return `https://app.todoist.com/app/task/${encodeURIComponent(taskId)}`
}
