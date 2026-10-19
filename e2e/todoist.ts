/*
 * A Todoist for the browser tests, on a port of its own: the account, its
 * projects, and the sync endpoint with tasks kept in memory. Just enough for
 * the app to connect, list projects, read the change feed and make tasks. It
 * has no comments: the feed answers with none.
 */

import { createServer } from 'node:http'

export const TODOIST_PORT = 3101
export const TODOIST_TOKEN = 'e2e-todoist-token'

/* John's own tasks, there before the app was connected. */
export const EXISTING_TASKS = ['Christmas lunch for the staff', 'Renew the car insurance']

type Task = {
  id: string
  project_id: string
  content: string
  checked: boolean
  is_deleted: boolean
  deadline: { date: string } | null
  due: { date: string } | null
  seq: number
}

export function startTodoist(): Promise<() => void> {
  let seq = 1
  let ids = 100
  const tasks = new Map<string, Task>()
  const add = (content: string, extra: Partial<Task> = {}) => {
    const id = `e2e${++ids}`
    tasks.set(id, { id, project_id: 'inbox', content, checked: false, is_deleted: false, deadline: null, due: null, ...extra, seq: ++seq })
    return id
  }
  for (const content of EXISTING_TASKS) add(content)
  const seen = new Map<string, Record<string, string>>()

  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => (raw += chunk))
    request.on('end', () => {
      const send = (body: unknown, status = 200) => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(body))
      }
      if (request.headers.authorization !== `Bearer ${TODOIST_TOKEN}`) return send({}, 401)
      const path = new URL(request.url ?? '/', 'http://x').pathname

      if (path === '/api/v1/user') return send({ id: '1', email: 'john@example.test' })
      if (path === '/api/v1/projects') {
        return send({
          results: [
            { id: 'inbox', name: 'Inbox', parent_id: null, inbox_project: true },
            { id: 'church', name: 'Church', parent_id: null },
          ],
          next_cursor: null,
        })
      }
      if (path === '/api/v1/sync') {
        const form = new URLSearchParams(raw)
        const sync_status: Record<string, unknown> = {}
        const temp_id_mapping: Record<string, string> = {}
        for (const command of JSON.parse(form.get('commands') ?? '[]') as {
          type: string
          uuid: string
          temp_id?: string
          args: Record<string, unknown>
        }[]) {
          const repeat = seen.get(command.uuid)
          if (repeat) {
            Object.assign(temp_id_mapping, repeat)
            sync_status[command.uuid] = 'ok'
            continue
          }
          const task = tasks.get(String(command.args.id))
          const mapping: Record<string, string> = {}
          if (command.type === 'item_add') {
            mapping[command.temp_id!] = add(String(command.args.content), {
              project_id: (command.args.project_id as string) ?? 'inbox',
              deadline: (command.args.deadline as Task['deadline']) ?? null,
              due: (command.args.due as Task['due']) ?? null,
            })
          } else if (task) {
            if (command.type === 'item_update') Object.assign(task, command.args)
            if (command.type === 'item_close') task.checked = true
            if (command.type === 'item_uncomplete') task.checked = false
            if (command.type === 'item_delete') task.is_deleted = true
            task.seq = ++seq
          }
          Object.assign(temp_id_mapping, mapping)
          seen.set(command.uuid, mapping)
          sync_status[command.uuid] = 'ok'
        }
        const token = form.get('sync_token')
        const body: Record<string, unknown> = { sync_token: `s${seq}`, full_sync: false, sync_status, temp_id_mapping }
        if (token !== null) {
          const full = token === '*'
          const since = full ? 0 : Number(token.slice(1))
          body.full_sync = full
          body.items = [...tasks.values()].filter((task) =>
            full ? !task.checked && !task.is_deleted : task.seq > since,
          )
          body.notes = []
        }
        return send(body)
      }
      send({}, 404)
    })
  })

  return new Promise((resolve) => server.listen(TODOIST_PORT, () => resolve(() => server.close())))
}
