/*
 * A Todoist that keeps its tasks in memory, and a sender that signs like
 * Todoist's webhook.
 *
 * `fetch` is stubbed and everything else is real: Postgres, the domain layer,
 * the merge. Any request to another host throws, so a test cannot reach the
 * network by accident.
 *
 * The sync endpoint behaves as Todoist's does where the sync relies on it:
 * every change bumps a sequence, `sync_token` is the sequence it was read at,
 * a full read lists open tasks only, an incremental one lists every task
 * changed since (completed and deleted ones included), and a command's uuid is
 * remembered so sending it again changes nothing. Comments (Todoist's notes)
 * come the same way: every live one on a full read, every changed one since.
 */

import { vi } from 'vitest'
import { API_BASE, signWebhook, type TodoistNote, type TodoistProject, type TodoistTask } from '../../lib/connect/todoist/client'
import { connectTodoist } from '../../lib/connect/todoist/sync'
import { db } from './db'

export const ACCESS_TOKEN = 'todoist_access_token'
export const CLIENT_ID = 'todoist_client_id'
export const CLIENT_SECRET = 'todoist_client_secret'

type Stored = TodoistTask & { seq: number }
type StoredNote = TodoistNote & { seq: number }

export type FakeTodoist = {
  tasks: Map<string, Stored>
  notes: Map<string, StoredNote>
  projects: TodoistProject[]
  /** The token Todoist accepts. Change it to revoke the one in use. */
  token: string
  /** Command types to refuse, with the error to give. */
  refuse: Map<string, string>
  /** Every command received, in order, repeats included. */
  commands: { type: string; uuid: string; args: Record<string, unknown> }[]
  /** The task of every comment list asked for, in order. */
  commentReads: string[]
  /** Answer the next request with this status instead. */
  failNext: number[]
  /** John, in Todoist: change a task as the app would. */
  edit: (id: string, patch: Partial<TodoistTask>) => void
  /** John adds a task in Todoist. */
  add: (content: string, patch?: Partial<TodoistTask>) => string
  /** John comments on a task in Todoist. Returns the comment's id. */
  comment: (taskId: string, content: string, postedAt?: string) => string
  /** John edits a comment. */
  editComment: (id: string, content: string) => void
  /** John deletes a comment. */
  deleteComment: (id: string) => void
  /** Each task's current state, by its content. */
  byContent: (content: string) => Stored | undefined
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export function fakeTodoist(): FakeTodoist {
  vi.stubEnv('TODOIST_CLIENT_ID', CLIENT_ID)
  vi.stubEnv('TODOIST_CLIENT_SECRET', CLIENT_SECRET)

  let seq = 1
  let ids = 1000
  const done = new Map<string, Record<string, string>>()
  const fake: FakeTodoist = {
    tasks: new Map(),
    notes: new Map(),
    projects: [
      { id: 'inbox', name: 'Inbox', parent_id: null, inbox_project: true },
      { id: 'work', name: 'Work', parent_id: null },
      { id: 'parish', name: 'Parish', parent_id: 'work' },
    ],
    token: ACCESS_TOKEN,
    refuse: new Map(),
    commands: [],
    commentReads: [],
    failNext: [],
    edit: (id, patch) => {
      const task = fake.tasks.get(id)
      if (!task) throw new Error(`no task ${id}`)
      Object.assign(task, patch, { seq: ++seq })
    },
    add: (content, patch = {}) => {
      const id = `t${++ids}`
      fake.tasks.set(id, {
        id,
        project_id: 'inbox',
        content,
        checked: false,
        is_deleted: false,
        deadline: null,
        due: null,
        ...patch,
        seq: ++seq,
      })
      return id
    },
    comment: (taskId, content, postedAt = new Date().toISOString()) => {
      const id = `n${++ids}`
      fake.notes.set(id, { id, item_id: taskId, content, posted_at: postedAt, is_deleted: false, seq: ++seq })
      return id
    },
    editComment: (id, content) => {
      const note = fake.notes.get(id)
      if (!note) throw new Error(`no comment ${id}`)
      Object.assign(note, { content, seq: ++seq })
    },
    deleteComment: (id) => {
      const note = fake.notes.get(id)
      if (!note) throw new Error(`no comment ${id}`)
      Object.assign(note, { is_deleted: true, seq: ++seq })
    },
    byContent: (content) => [...fake.tasks.values()].find((task) => task.content === content),
  }

  const apply = (command: { type: string; uuid: string; temp_id?: string; args: Record<string, unknown> }) => {
    const refusal = fake.refuse.get(command.type)
    if (refusal) return { error: refusal }
    const id = String(command.args.id ?? '')
    const task = fake.tasks.get(id)
    switch (command.type) {
      case 'item_add': {
        const newId = fake.add(String(command.args.content), {
          project_id: (command.args.project_id as string) ?? 'inbox',
          description: command.args.description as string,
          deadline: (command.args.deadline as { date: string }) ?? null,
          due: (command.args.due as { date: string }) ?? null,
        })
        return { mapping: [command.temp_id!, newId] as const }
      }
      case 'item_update':
        if (!task) return { error: 'Item not found' }
        if ('content' in command.args) task.content = String(command.args.content)
        if ('deadline' in command.args) task.deadline = command.args.deadline as { date: string } | null
        task.seq = ++seq
        return {}
      case 'item_close':
        if (!task) return { error: 'Item not found' }
        task.checked = true
        task.completed_at = new Date().toISOString()
        task.seq = ++seq
        return {}
      case 'item_uncomplete':
        if (!task) return { error: 'Item not found' }
        task.checked = false
        task.completed_at = null
        task.seq = ++seq
        return {}
      case 'item_delete':
        if (!task) return { error: 'Item not found' }
        task.is_deleted = true
        task.seq = ++seq
        return {}
      default:
        return { error: `Unknown command ${command.type}` }
    }
  }

  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    if (url.origin !== API_BASE) throw new Error(`unexpected request to ${url.origin}`)
    const method = init?.method ?? 'GET'

    if (method === 'POST' && url.pathname === '/oauth/access_token') {
      const form = new URLSearchParams(String(init?.body))
      if (form.get('client_secret') !== CLIENT_SECRET) return json({ error: 'incorrect_application_credentials' }, 400)
      if (form.get('code') === 'bad') return json({ error: 'bad_authorization_code' }, 400)
      return json({ access_token: fake.token, token_type: 'Bearer', refresh_token: 'refresh-1', expires_in: 3600 })
    }

    const headers = new Headers(init?.headers)
    if (headers.get('authorization') !== `Bearer ${fake.token}`) return json({}, 401)
    const failure = fake.failNext.shift()
    if (failure) return json({ error: 'failed' }, failure)

    if (method === 'GET' && url.pathname === '/api/v1/user') {
      return json({ id: '1', email: 'John@Example.test', full_name: 'John' })
    }
    if (method === 'GET' && url.pathname === '/api/v1/projects') {
      return json({ results: fake.projects, next_cursor: null })
    }
    if (method === 'GET' && url.pathname === '/api/v1/comments') {
      const taskId = url.searchParams.get('task_id') ?? ''
      fake.commentReads.push(taskId)
      if (!fake.tasks.has(taskId)) return json({}, 404)
      const results = [...fake.notes.values()]
        .filter((note) => note.item_id === taskId && !note.is_deleted)
        .map((note) => ({ ...note, seq: undefined }))
      return json({ results, next_cursor: null })
    }
    const one = /^\/api\/v1\/tasks\/([^/]+)$/.exec(url.pathname)
    if (method === 'GET' && one) {
      const task = fake.tasks.get(decodeURIComponent(one[1]!))
      return task && !task.is_deleted ? json(task) : json({}, 404)
    }

    if (method === 'POST' && url.pathname === '/api/v1/sync') {
      const form = new URLSearchParams(String(init?.body))
      const sync_status: Record<string, unknown> = {}
      const temp_id_mapping: Record<string, string> = {}
      const commands = JSON.parse(form.get('commands') ?? '[]') as Parameters<typeof apply>[0][]
      for (const command of commands) {
        fake.commands.push(command)
        const seen = done.get(command.uuid)
        if (seen) {
          sync_status[command.uuid] = 'ok'
          Object.assign(temp_id_mapping, seen)
          continue
        }
        const result = apply(command)
        if ('error' in result) {
          sync_status[command.uuid] = { error: result.error, error_code: 20 }
          continue
        }
        sync_status[command.uuid] = 'ok'
        const mapping = 'mapping' in result && result.mapping ? { [result.mapping[0]]: result.mapping[1] } : {}
        Object.assign(temp_id_mapping, mapping)
        done.set(command.uuid, mapping)
      }

      const token = form.get('sync_token')
      const body: Record<string, unknown> = { sync_status, temp_id_mapping, sync_token: `s${seq}`, full_sync: false }
      if (token !== null) {
        const all = [...fake.tasks.values()]
        const full = token === '*'
        const since = full ? 0 : Number(token.slice(1))
        body.full_sync = full
        body.items = (full ? all.filter((task) => !task.checked && !task.is_deleted) : all.filter((task) => task.seq > since))
          .map((task) => ({ ...task, seq: undefined }))
        const notes = [...fake.notes.values()]
        body.notes = (full ? notes.filter((note) => !note.is_deleted) : notes.filter((note) => note.seq > since))
          .map((note) => ({ ...note, seq: undefined }))
      }
      return json(body)
    }

    return json({}, 404)
  })

  return fake
}

/** Connect as if the sign-in had just come back. */
export async function connect() {
  return connectTodoist(db, { accessToken: ACCESS_TOKEN, refreshToken: null, expiresAt: null })
}

/** A delivery as Todoist would send it. */
export function delivery(payload: unknown, options: { id?: string; secret?: string } = {}) {
  const body = JSON.stringify(payload)
  return {
    body,
    headers: new Headers({
      'x-todoist-hmac-sha256': signWebhook(body, options.secret ?? CLIENT_SECRET),
      'x-todoist-delivery-id': options.id ?? `d-${Math.random().toString(36).slice(2)}`,
    }),
  }
}
