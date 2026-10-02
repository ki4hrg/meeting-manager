/*
 * Connections: accounts at outside services, with their tokens encrypted at
 * rest, and the bindings that say which of an account's calendars feeds which
 * context.
 *
 * A small replacement for ../Meeter/lib/connect/connections.ts (888 lines,
 * multi-user). This is one user and two tables.
 */

import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { AppError, NotFoundError, ValidationError, type Executor } from '../core/types'
import { bindings, connections } from '../db/schema'
import { getContext } from '../directory/contexts'
import { decrypt, encrypt, type EncryptedData } from './crypto'

/* Credentials never leave this module: every reader gets the row without them. */
export type Connection = Omit<typeof connections.$inferSelect, 'credentials'>

export type GoogleTokens = {
  accessToken: string
  /* Google sends a refresh token with the first consent only, and never with a
     refresh. Null here means "none came back", not "forget the one we hold". */
  refreshToken: string | null
  expiresAt: number | null
}

/** A connection the service no longer honours. The message says what to do about it. */
export class ConnectionError extends AppError {
  constructor(message: string) {
    super(message, 'connection')
  }
}

const RECONNECT = 'Connect this account again.'

/**
 * Google answered 401: the access token is not one it honours, whatever its
 * expiry said (the grant was revoked, or the token was). Worth one refresh;
 * after that it is a connection to make again.
 */
export class GoogleUnauthorized extends ConnectionError {
  constructor() {
    super(`Google no longer accepts this connection. ${RECONNECT}`)
  }
}

function withoutCredentials(row: typeof connections.$inferSelect): Connection {
  const rest: Partial<typeof row> = { ...row }
  delete rest.credentials
  return rest as Connection
}

// ─── credentials ─────────────────────────────────────────────────────────────

/* CONNECT_KEY, or SESSION_SECRET when it is not set. Changing either makes
   every stored credential unreadable, which reads as "connect again". */
function encryptionKey(): string {
  const key = process.env.CONNECT_KEY || process.env.SESSION_SECRET
  if (!key) throw new Error('CONNECT_KEY or SESSION_SECRET must be set')
  return key
}

/* What goes in `connections.credentials`, whatever the provider keeps there.
   Exported for the providers that are not Google (lib/connect/granola), which
   read their own rows; nothing outside lib/connect should call these. */
export function sealCredentials(value: unknown): string {
  return JSON.stringify(encrypt(JSON.stringify(value), encryptionKey()))
}

export function unsealCredentials<T>(blob: string): T | null {
  try {
    return JSON.parse(decrypt(JSON.parse(blob) as EncryptedData, encryptionKey())) as T
  } catch {
    return null
  }
}

const seal = (tokens: GoogleTokens) => sealCredentials(tokens)
const unseal = (blob: string) => unsealCredentials<GoogleTokens>(blob)

// ─── reading ─────────────────────────────────────────────────────────────────

export async function listConnections(exec: Executor): Promise<Connection[]> {
  const rows = await exec.select().from(connections).orderBy(sql`lower(${connections.account})`)
  return rows.map(withoutCredentials)
}

async function loadRow(exec: Executor, id: string) {
  const [row] = await exec.select().from(connections).where(eq(connections.id, id)).limit(1)
  if (!row) throw new NotFoundError('Connection', id)
  return row
}

export async function getConnection(exec: Executor, id: string): Promise<Connection> {
  return withoutCredentials(await loadRow(exec, id))
}

// ─── status ──────────────────────────────────────────────────────────────────

/** Say on the connection what went wrong, for the settings page to show. */
export async function recordConnectionError(
  exec: Executor,
  id: string,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err)
  await exec
    .update(connections)
    .set({ lastError: message.slice(0, 500), updatedAt: new Date() })
    .where(eq(connections.id, id))
}

/** A call to the service worked: whatever was wrong before no longer is. */
export async function clearConnectionError(exec: Executor, id: string): Promise<void> {
  // Guarded, so the usual case of nothing to clear writes nothing.
  await exec
    .update(connections)
    .set({ lastError: null, updatedAt: new Date() })
    .where(and(eq(connections.id, id), isNotNull(connections.lastError)))
}

// ─── writing ─────────────────────────────────────────────────────────────────

/**
 * Save a Google account. One row per account, so connecting the same account
 * again replaces its tokens rather than adding a second connection.
 */
export async function saveGoogleConnection(
  exec: Executor,
  input: { account: string; tokens: GoogleTokens; scopes: string[] },
): Promise<Connection> {
  const account = input.account.trim().toLowerCase()
  if (!account.includes('@')) throw new ValidationError('Invalid Google account email.')

  const [existing] = await exec
    .select()
    .from(connections)
    .where(and(eq(connections.provider, 'google'), sql`lower(${connections.account}) = ${account}`))
    .limit(1)

  const scopes = input.scopes.join(' ')
  if (!existing) {
    const [row] = await exec
      .insert(connections)
      .values({ provider: 'google', account, credentials: seal(input.tokens), scopes })
      .returning()
    return withoutCredentials(row!)
  }

  /* A reconnect that comes back without a refresh token must not cost us the
     one already held. */
  const refreshToken = input.tokens.refreshToken ?? unseal(existing.credentials)?.refreshToken ?? null
  const [row] = await exec
    .update(connections)
    .set({
      credentials: seal({ ...input.tokens, refreshToken }),
      scopes,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(connections.id, existing.id))
    .returning()
  return withoutCredentials(row!)
}

/** Remove a connection. Its bindings go with it. */
export async function deleteConnection(exec: Executor, id: string): Promise<void> {
  await exec.delete(connections).where(eq(connections.id, id))
}

// ─── access tokens ───────────────────────────────────────────────────────────

type TokenDeps = {
  refreshToken?: (refresh: string) => Promise<GoogleTokens>
  /** Refresh even though the token held has not run out. */
  force?: boolean
}

/* Refreshed this long before the expiry Google gave, so a token is never
   handed out with seconds left on it. */
const EXPIRY_MARGIN_MS = 60_000

/**
 * A usable access token for a connection, refreshed first if it has run out.
 * A failure is recorded on the connection and thrown.
 */
export async function accessTokenFor(
  exec: Executor,
  connectionId: string,
  deps?: TokenDeps,
): Promise<string> {
  const row = await loadRow(exec, connectionId)

  try {
    const held = unseal(row.credentials)
    if (!held) throw new ConnectionError(`The stored credentials cannot be read. ${RECONNECT}`)

    const live = held.expiresAt && held.expiresAt > Date.now() + EXPIRY_MARGIN_MS
    if (live && !deps?.force) return held.accessToken

    if (!held.refreshToken) {
      throw new ConnectionError(`Google gave no refresh token. ${RECONNECT}`)
    }

    const refreshed = await (deps?.refreshToken ?? googleRefreshToken)(held.refreshToken)
    await exec
      .update(connections)
      .set({
        /* The refresh token is kept: a refresh response does not repeat it. */
        credentials: seal({
          ...refreshed,
          refreshToken: refreshed.refreshToken ?? held.refreshToken,
        }),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(connections.id, connectionId))
    return refreshed.accessToken
  } catch (err) {
    await recordConnectionError(exec, connectionId, err)
    throw err
  }
}

/**
 * Call Google with a connection's access token. A 401 gets the token refreshed
 * and the call made once more, since a token can stop working before the
 * expiry it came with.
 */
export async function withAccessToken<T>(
  exec: Executor,
  connectionId: string,
  call: (token: string) => Promise<T>,
  deps?: TokenDeps,
): Promise<T> {
  const token = await accessTokenFor(exec, connectionId, deps)
  try {
    return await call(token)
  } catch (err) {
    if (!(err instanceof GoogleUnauthorized)) throw err
    return call(await accessTokenFor(exec, connectionId, { ...deps, force: true }))
  }
}

/** Google's own words for a refusal, when it sent any. */
export async function googleErrorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: string | { message?: string; status?: string }
      error_description?: string
    }
    if (typeof body.error === 'string') return body.error_description ?? body.error
    return body.error?.message ?? body.error?.status ?? String(response.status)
  } catch {
    return String(response.status)
  }
}

/** Trade a refresh token for a new access token. */
export async function googleRefreshToken(refreshToken: string): Promise<GoogleTokens> {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new ConnectionError('Google is not configured.')

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })

  if (!response.ok) {
    const detail = await googleErrorDetail(response)
    /* 400 invalid_grant is how Google says the grant was revoked or has
       lapsed; trying again will not help, connecting again will. */
    if (response.status === 400 || response.status === 401) {
      throw new ConnectionError(`Google refused the connection (${detail}). ${RECONNECT}`)
    }
    throw new Error(`Google token refresh failed: ${detail}`)
  }

  const data = (await response.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }
  if (!data.access_token) throw new Error('Google token refresh returned no access token.')

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  }
}

// ─── calendars ───────────────────────────────────────────────────────────────

export type CalendarInfo = { id: string; name: string; primary: boolean }

type CalendarDeps = TokenDeps & { fetchCalendars?: (token: string) => Promise<CalendarInfo[]> }

/**
 * The calendars an account can see, asked of Google each time. A failure is
 * recorded on the connection and thrown; a success clears what was recorded.
 */
export async function listCalendars(
  exec: Executor,
  connectionId: string,
  deps?: CalendarDeps,
): Promise<CalendarInfo[]> {
  try {
    const calendars = await withAccessToken(
      exec,
      connectionId,
      deps?.fetchCalendars ?? googleListCalendars,
      deps,
    )
    await clearConnectionError(exec, connectionId)
    return calendars
  } catch (err) {
    await recordConnectionError(exec, connectionId, err)
    throw err
  }
}

/** Every page of the account's calendar list: the primary first, then by name. */
export async function googleListCalendars(token: string): Promise<CalendarInfo[]> {
  const calendars: CalendarInfo[] = []
  let pageToken: string | undefined

  do {
    const params = new URLSearchParams({ maxResults: '250' })
    if (pageToken) params.set('pageToken', pageToken)

    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/users/me/calendarList?${params}`,
      { headers: { authorization: `Bearer ${token}` } },
    )
    if (response.status === 401) throw new GoogleUnauthorized()
    if (!response.ok) {
      throw new Error(`Google calendar list failed: ${await googleErrorDetail(response)}`)
    }

    const data = (await response.json()) as {
      nextPageToken?: string
      items?: Array<{
        id?: string
        summary?: string
        summaryOverride?: string
        primary?: boolean
        deleted?: boolean
      }>
    }
    for (const item of data.items ?? []) {
      if (!item.id || item.deleted) continue
      calendars.push({
        id: item.id,
        // The name John gave it, when he renamed someone else's calendar.
        name: item.summaryOverride || item.summary || item.id,
        primary: item.primary ?? false,
      })
    }
    pageToken = data.nextPageToken
  } while (pageToken)

  return calendars.sort(
    (a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name),
  )
}

// ─── bindings ────────────────────────────────────────────────────────────────

export type Binding = typeof bindings.$inferSelect

/**
 * Feed a calendar into a context. A calendar feeds one context, so binding it
 * again moves it.
 */
export async function bindCalendar(
  exec: Executor,
  input: { connectionId: string; calendarId: string; name: string; contextId: string },
): Promise<Binding> {
  const calendarId = input.calendarId.trim()
  if (calendarId === '') throw new ValidationError('Pick a calendar.')
  await loadRow(exec, input.connectionId)
  await getContext(exec, input.contextId)

  const name = input.name.trim() || calendarId
  /* One statement on the unique key, so a calendar is never left with no
     binding half-way through a move, or with two. */
  const [row] = await exec
    .insert(bindings)
    .values({
      connectionId: input.connectionId,
      kind: 'calendar',
      externalId: calendarId,
      name,
      contextId: input.contextId,
    })
    .onConflictDoUpdate({
      target: [bindings.connectionId, bindings.kind, bindings.externalId],
      set: { contextId: input.contextId, name, projectId: null },
    })
    .returning()
  return row!
}

export async function unbindCalendar(exec: Executor, bindingId: string): Promise<void> {
  await exec.delete(bindings).where(and(eq(bindings.id, bindingId), eq(bindings.kind, 'calendar')))
}

/** Calendar bindings: one context's, or all of them. */
export async function listBindings(
  exec: Executor,
  { contextId }: { contextId?: string } = {},
): Promise<Binding[]> {
  return exec
    .select()
    .from(bindings)
    .where(
      and(eq(bindings.kind, 'calendar'), contextId ? eq(bindings.contextId, contextId) : undefined),
    )
    .orderBy(sql`lower(${bindings.name})`)
}

/** Whether this instance has Google credentials at all. */
export function googleConfigured(): boolean {
  return !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET
}
