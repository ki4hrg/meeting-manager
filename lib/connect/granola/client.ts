/*
 * Granola over REST: notes, transcripts, folders and the webhook endpoint.
 * Lifted and trimmed from ../Meeter/lib/connect/granola/client.ts.
 *
 * Granola is an API key, not an OAuth grant: no refresh, no expiry. A key
 * works until it is revoked, and then every call answers 401.
 *
 * Every function takes the key, so nothing here touches the database;
 * `connection.ts` is where a key is stored and a failure is recorded.
 */

import { ConnectionError } from '../connections'

/* `public-api`, not `api.granola.ai`: that host answers, but serves none of
   these routes, so a good key checked against it reads as an outage. */
export const API_BASE = 'https://public-api.granola.ai'

/** Granola refused the key. Nothing will work until a new one is pasted. */
export class GranolaUnauthorized extends ConnectionError {
  constructor(status: number) {
    super(
      status === 401
        ? 'Granola no longer accepts this API key. Connect again with a new one.'
        : 'This Granola API key is not allowed to do that. Check its access in Granola.',
    )
  }
}

/** Granola said no, and it is not the key. */
export class GranolaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** 429 and 5xx: the same request later is likely to work. */
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'GranolaApiError'
  }
}

// ─── the request ─────────────────────────────────────────────────────────────

type Query = Record<string, string | number | undefined | null>

export async function granolaRequest<T>(
  key: string,
  path: string,
  options: { method?: string; query?: Query; body?: unknown } = {},
): Promise<T> {
  const url = new URL(path, API_BASE)
  for (const [name, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(name, String(value))
    }
  }

  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      authorization: `Bearer ${key}`,
      accept: 'application/json',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })

  if (response.status === 401 || response.status === 403) {
    throw new GranolaUnauthorized(response.status)
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new GranolaApiError(
      `Granola answered ${response.status} for ${path}${body ? `: ${body.slice(0, 200)}` : ''}`,
      response.status,
      response.status === 429 || response.status >= 500,
    )
  }

  // A DELETE answers 204 with nothing to parse.
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

// ─── the shapes ──────────────────────────────────────────────────────────────

export type GranolaUser = { name?: string | null; email?: string | null }

export type GranolaFolder = {
  id: string
  name: string
  parent_folder_id: string | null
}

/* `calendar_event_id` is Google's own event id, including the
   `_20260827T150000Z` suffix that names one occurrence of a recurring event:
   the same string `meetings.calendar_event_id` holds. */
export type GranolaCalendarEvent = {
  event_title: string | null
  invitees: { email: string }[]
  organiser: string | null
  calendar_event_id: string | null
  scheduled_start_time: string | null
  scheduled_end_time: string | null
}

export type GranolaNoteSummary = {
  id: string
  title: string | null
  owner: GranolaUser
  created_at: string
  updated_at: string
}

export type GranolaNote = GranolaNoteSummary & {
  web_url?: string
  calendar_event?: GranolaCalendarEvent | null
  attendees?: GranolaUser[]
  folder_membership?: GranolaFolder[]
  summary_text?: string | null
  summary_markdown?: string | null
  /* John's own notepad (docs/SPEC.md, "Scratchpad"). Not in the copy of
     Granola's spec this was written against; read if it is there. */
  private_notes_markdown?: string | null
  private_notes_text?: string | null
}

export type GranolaTranscriptLine = {
  speaker: {
    source?: string
    attribution?: 'me' | 'them'
    diarization_label?: string
    name?: string
  } | null
  text: string
  start_time: string
  end_time: string
}

// ─── reads ───────────────────────────────────────────────────────────────────

/* Granola's documented caps. */
const NOTES_PAGE = 30
const TRANSCRIPT_PAGE = 100

/* A runaway guard against a cursor that never ends, not a limit anyone meets. */
const MAX_PAGES = 40

type Page<K extends string, T> = { hasMore: boolean; cursor: string | null } & Record<K, T[]>

async function everyPage<K extends string, T>(
  key: string,
  path: string,
  field: K,
  query: Query,
): Promise<T[]> {
  const rows: T[] = []
  let cursor: string | null = null

  for (let page = 0; page < MAX_PAGES; page++) {
    const result: Page<K, T> = await granolaRequest(key, path, {
      query: { ...query, cursor: cursor ?? undefined },
    })
    rows.push(...(result[field] ?? []))
    if (!result.hasMore || !result.cursor) break
    cursor = result.cursor
  }
  return rows
}

/** Notes as the list gives them: no folders, no calendar event, no content. */
export function listNotes(
  key: string,
  options: { updatedAfter?: Date | null; folderId?: string | null } = {},
): Promise<GranolaNoteSummary[]> {
  return everyPage(key, '/v1/notes', 'notes', {
    updated_after: options.updatedAfter?.toISOString(),
    // A folder's notes include those of its child folders.
    folder_id: options.folderId ?? undefined,
    page_size: NOTES_PAGE,
  })
}

export function getNote(key: string, noteId: string): Promise<GranolaNote> {
  return granolaRequest<GranolaNote>(key, `/v1/notes/${encodeURIComponent(noteId)}`)
}

/**
 * The whole transcript. Asked for in pages, since a long meeting's is too
 * large to come back on the note. A note with no recording has none: 404 is an
 * empty transcript, not a failure.
 */
export async function getTranscript(key: string, noteId: string): Promise<GranolaTranscriptLine[]> {
  try {
    return await everyPage(key, `/v1/notes/${encodeURIComponent(noteId)}/transcript`, 'transcript', {
      page_size: TRANSCRIPT_PAGE,
    })
  } catch (err) {
    if (err instanceof GranolaApiError && err.status === 404) return []
    throw err
  }
}

export function listFolders(key: string): Promise<GranolaFolder[]> {
  return everyPage(key, '/v1/folders', 'folders', { page_size: NOTES_PAGE })
}

/** Whoever owns the first note the key can see: the only identity Granola gives. There is no `/me`. */
export async function keyOwner(key: string): Promise<GranolaUser | null> {
  const result = await granolaRequest<{ notes?: GranolaNoteSummary[] }>(key, '/v1/notes', {
    query: { page_size: 1 },
  })
  return result.notes?.[0]?.owner ?? null
}

// ─── the webhook endpoint ────────────────────────────────────────────────────

export type GranolaWebhookEndpoint = { id: string; url: string; signing_secret: string }

/**
 * Register where Granola delivers. The signing secret is in this response and
 * nowhere else, so the caller must store it or delete the endpoint again.
 */
export function createWebhookEndpoint(key: string, url: string): Promise<GranolaWebhookEndpoint> {
  return granolaRequest(key, '/v1/webhook-endpoints', {
    method: 'POST',
    body: {
      url,
      /* `note.generated` is the note being ready; `note.edited` is a summary
         regenerated or the notepad changed afterwards. */
      events: ['note.generated', 'note.edited'],
      scopes: ['personal', 'public'],
    },
  })
}

export async function deleteWebhookEndpoint(key: string, endpointId: string): Promise<void> {
  await granolaRequest(key, `/v1/webhook-endpoints/${encodeURIComponent(endpointId)}`, {
    method: 'DELETE',
  })
}
