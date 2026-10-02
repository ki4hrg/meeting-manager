/*
 * A Granola that answers from a script, and a sender that signs like Granola.
 *
 * `fetch` is stubbed and everything else is real: Postgres, the domain layer,
 * the signature check. Any request to a host that is not Granola's throws, so
 * a test cannot reach the network by accident.
 *
 * Deliveries are signed with `signDelivery`, the same code path the verifier
 * uses, so the tests do not carry a second implementation of the scheme.
 */

import { vi } from 'vitest'
import {
  API_BASE,
  type GranolaFolder,
  type GranolaNote,
  type GranolaTranscriptLine,
} from '../../lib/connect/granola/client'
import { bindFolder, connectGranola } from '../../lib/connect/granola/connection'
import { signDelivery } from '../../lib/connect/granola/signature'
import { db } from './db'

export const TEST_KEY = 'grn_test_key'
export const TEST_SECRET = `whsec_${Buffer.from('a-signing-secret-32-bytes-long!!').toString('base64')}`

export type Script = {
  /** The only key Granola accepts. Change it to revoke the one in use. */
  key: string
  notes: Record<string, GranolaNote>
  transcripts: Record<string, GranolaTranscriptLine[]>
  folders: GranolaFolder[]
  /** Answers to give instead, in order, before falling back to the script. */
  failWith: { status: number; body?: unknown }[]
  /** What creating a webhook endpoint answers; null refuses it. */
  signingSecret: string | null
}

export type FakeGranola = {
  script: Script
  /** Every request made, as `METHOD /path?query`. */
  calls: string[]
  /** How many requests matched. */
  count: (pattern: RegExp) => number
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Install the fake for the rest of the test. The script is read at call time: mutate it freely. */
export function fakeGranola(initial: Partial<Script> = {}): FakeGranola {
  const script: Script = {
    key: TEST_KEY,
    notes: {},
    transcripts: {},
    folders: [],
    failWith: [],
    signingSecret: TEST_SECRET,
    ...initial,
  }
  const calls: string[] = []

  /* A folder's notes include its child folders', as Granola's filter does. */
  const within = (folderId: string, wanted: string): boolean => {
    let current: string | null = folderId
    for (let depth = 0; current && depth < 20; depth++) {
      if (current === wanted) return true
      current = script.folders.find((folder) => folder.id === current)?.parent_folder_id ?? null
    }
    return false
  }

  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    if (url.origin !== API_BASE) throw new Error(`unexpected request to ${url.origin}`)

    const method = init?.method ?? 'GET'
    calls.push(`${method} ${url.pathname}${url.search}`)

    const headers = new Headers(init?.headers)
    if (headers.get('authorization') !== `Bearer ${script.key}`) return json({}, 401)

    const failure = script.failWith.shift()
    if (failure) return json(failure.body ?? {}, failure.status)

    const path = url.pathname
    const page = Number(url.searchParams.get('page_size') ?? '10')
    const offset = Number(url.searchParams.get('cursor') ?? '0')
    const paged = <T>(field: string, rows: T[]) => {
      const slice = rows.slice(offset, offset + page)
      const more = offset + page < rows.length
      return json({ [field]: slice, hasMore: more, cursor: more ? String(offset + page) : null })
    }

    if (method === 'GET' && path === '/v1/notes') {
      const after = url.searchParams.get('updated_after')
      const folderId = url.searchParams.get('folder_id')
      const listed = Object.values(script.notes)
        .filter((note) => !after || new Date(note.updated_at) > new Date(after))
        .filter(
          (note) =>
            !folderId ||
            (note.folder_membership ?? []).some((folder) => within(folder.id, folderId)),
        )
        .map(({ id, title, owner, created_at, updated_at }) => ({
          id,
          object: 'note',
          title,
          owner,
          created_at,
          updated_at,
        }))
      return paged('notes', listed)
    }

    const transcript = /^\/v1\/notes\/([^/]+)\/transcript$/.exec(path)
    if (method === 'GET' && transcript) {
      const lines = script.transcripts[decodeURIComponent(transcript[1]!)]
      return lines ? paged('transcript', lines) : json({}, 404)
    }

    const note = /^\/v1\/notes\/([^/]+)$/.exec(path)
    if (method === 'GET' && note) {
      const found = script.notes[decodeURIComponent(note[1]!)]
      return found ? json(found) : json({}, 404)
    }

    if (method === 'GET' && path === '/v1/folders') return paged('folders', script.folders)

    if (method === 'POST' && path === '/v1/webhook-endpoints') {
      if (!script.signingSecret) return json({ error: 'not allowed' }, 400)
      const body = JSON.parse(String(init?.body)) as { url: string }
      return json({ id: 'whe_2mKr8fQxLp7Ta3', url: body.url, signing_secret: script.signingSecret })
    }
    if (method === 'DELETE' && path.startsWith('/v1/webhook-endpoints/')) {
      return new Response(null, { status: 204 })
    }

    return json({}, 404)
  })

  return { script, calls, count: (pattern) => calls.filter((call) => pattern.test(call)).length }
}

let serial = 0

/** A note id of the shape Granola's are: `not_` and 14 alphanumerics. */
export function noteId(): string {
  serial += 1
  return `not_${String(serial).padStart(14, '0')}`
}

export function folder(id: string, name: string, parent: string | null = null): GranolaFolder {
  return { id, name, parent_folder_id: parent }
}

/** A note as `GET /v1/notes/{id}` gives it: no calendar event, generated an hour ago. */
export function note(overrides: Partial<GranolaNote> & { id: string }): GranolaNote {
  return {
    title: 'Untitled',
    owner: { name: 'John', email: 'john@example.test' },
    created_at: '2026-10-01T15:00:00Z',
    updated_at: '2026-10-01T15:40:00Z',
    calendar_event: null,
    attendees: [{ name: 'John', email: 'john@example.test' }],
    folder_membership: [],
    summary_markdown: 'We talked.',
    ...overrides,
  }
}

/** Connect an account against the fake, with these folders bound. */
export async function connect(bound: { folderId: string; contextId: string; name?: string }[] = []) {
  const account = await connectGranola(db, TEST_KEY)
  for (const one of bound) {
    await bindFolder(db, {
      connectionId: account.id,
      folderId: one.folderId,
      name: one.name ?? one.folderId,
      contextId: one.contextId,
    })
  }
  return account
}

let deliveries = 0

/** A delivery as Granola would send it: the body, and the three signed headers. */
export function delivery(
  payload: unknown,
  options: { id?: string; secret?: string; at?: Date; raw?: string } = {},
): { headers: Headers; body: string; id: string } {
  const id = options.id ?? `msg_${(deliveries += 1)}`
  const at = options.at ?? new Date()
  const body = options.raw ?? JSON.stringify(payload)
  return {
    id,
    body,
    headers: new Headers({
      'webhook-id': id,
      'webhook-timestamp': String(Math.floor(at.getTime() / 1000)),
      'webhook-signature': signDelivery(id, at, body, options.secret ?? TEST_SECRET),
    }),
  }
}
