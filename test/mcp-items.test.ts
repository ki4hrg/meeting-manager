import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listItems } from '../lib/items/items'
import { db, resetBetweenTests } from './helpers/db'
import { makeWorld } from './helpers/fixtures'
import { connect, dataOf, identityFor, makeUser, textOf, type ConnectedClient } from './helpers/mcp'

resetBetweenTests()

type World = Awaited<ReturnType<typeof makeWorld>>
type Item = { id: string; kind: string; status: string; text: string; [key: string]: unknown }

let world: World
let connection: ConnectedClient

beforeEach(async () => {
  world = await makeWorld()
  connection = await connect(identityFor(await makeUser()))
})
afterEach(() => connection.close())

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await connection.client.callTool({ name, arguments: args })) as CallToolResult
}

describe('capture_item', () => {
  it('infers the context from the project and resolves names', async () => {
    const result = await call('capture_item', {
      text: 'What is the lunch menu?',
      kind: 'question',
      project: 'retreat',
      owners: ['sarah', 'tom'],
      with: ['me'],
      due_on: '2026-11-01',
    })
    expect(result.isError).toBeFalsy()

    const { item } = dataOf<{ item: Item }>(result)
    expect(item).toMatchObject({
      context_id: world.parish.id,
      kind: 'question',
      status: 'open',
      project: { id: world.retreat.id, name: 'Retreat' },
      due_on: '2026-11-01',
      owners: [{ name: 'Sarah Jones' }, { name: 'Tom Baker' }],
      with: [{ name: 'John', is_me: true }],
    })
  })

  it('asks for the context when nothing implies one', async () => {
    const result = await call('capture_item', { text: 'Look at the roof' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('Parish, Diocese')
  })

  it('writes once when retried with the same key', async () => {
    const args = { text: 'Look at the roof', context: 'Parish', idempotency_key: 'retry-key-0001' }
    const first = dataOf<{ item: Item }>(await call('capture_item', args))
    const second = dataOf<{ item: Item }>(await call('capture_item', args))

    expect(second.item.id).toBe(first.item.id)
    expect(await listItems(db, { contextId: world.parish.id })).toHaveLength(1)

    const changed = await call('capture_item', { ...args, text: 'Something else' })
    expect(changed.isError).toBe(true)
  })

  it('writes nothing when a name does not resolve', async () => {
    const result = await call('capture_item', {
      text: 'x',
      context: 'Parish',
      owners: ['nobody'],
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('No person or group matches nobody')
    expect(await listItems(db, { contextId: world.parish.id })).toHaveLength(0)
  })
})

describe('the thread through the tools', () => {
  it('answers, records a decision, reports back and lists by party', async () => {
    const captured = dataOf<{ item: Item }>(
      await call('capture_item', { text: 'Can we use the hall?', context: 'Parish', with: ['bishop'] }),
    ).item

    const converted = dataOf<{ item: Item }>(
      await call('convert_item', { id: captured.id, to: 'question' }),
    ).item
    expect(converted).toMatchObject({ id: captured.id, kind: 'question' })

    const done = await call('update_item', { id: captured.id, status: 'done' })
    expect(done.isError).toBe(true)
    expect(textOf(done)).toContain('answer')

    const answered = dataOf<{ item: Item; report: Item }>(
      await call('update_item', { id: captured.id, answer: 'Yes, in May', report_to: 'staff' }),
    )
    expect(answered.item).toMatchObject({ status: 'done', resolution: 'Yes, in May' })
    expect(answered.report).toMatchObject({ kind: 'topic', with: [{ name: 'Staff' }] })

    const needsText = await call('convert_item', { id: captured.id, to: 'decision' })
    expect(needsText.isError).toBe(true)

    const decided = dataOf<{ item: Item; from: Item }>(
      await call('convert_item', { id: captured.id, to: 'decision', text: 'The retreat is in the hall' }),
    )
    expect(decided.item).toMatchObject({ kind: 'decision', status: 'decided', parent_item_id: captured.id })
    expect(decided.from.kind).toBe('question')

    const thread = dataOf<{ thread: Array<Item & { depth: number }>; history: unknown[] }>(
      await call('get_item', { id: decided.item.id }),
    )
    expect(thread.thread.map((entry) => [entry.kind, entry.depth])).toEqual([
      ['question', 0],
      ['topic', 1],
      ['decision', 1],
    ])
    expect(thread.history.length).toBeGreaterThan(4)

    const forStaff = dataOf<{ items: Item[] }>(
      await call('list_items', { context: 'Parish', party: 'staff', role: 'with' }),
    )
    expect(forStaff.items.map((item) => item.id)).toEqual([answered.report.id])

    const closed = dataOf<{ items: Item[] }>(
      await call('list_items', { context: 'Parish', state: 'closed' }),
    )
    expect(closed.items.map((item) => item.kind).sort()).toEqual(['decision', 'question'])
  })

  it('replaces one role and leaves the other', async () => {
    const { item } = dataOf<{ item: Item }>(
      await call('capture_item', {
        text: 'Send the budget',
        kind: 'action',
        context: 'Parish',
        owners: ['me'],
        with: ['sarah'],
      }),
    )
    const updated = dataOf<{ item: Item }>(
      await call('update_item', { id: item.id, with: ['tom'], project: 'campaign', note: 'Due soon' }),
    ).item
    expect(updated).toMatchObject({
      owners: [{ name: 'John' }],
      with: [{ name: 'Tom Baker' }],
      project: { name: 'Capital campaign' },
    })
  })
})

describe('directory tools', () => {
  it('creates and lists across the directory', async () => {
    const group = dataOf<{ group: { members: Array<{ name: string }> } }>(
      await call('create_group', { name: 'Finance', context: 'Parish', members: ['sarah', 'bishop'] }),
    )
    expect(group.group.members.map((m) => m.name)).toEqual(['Bishop Wright', 'Sarah Jones'])

    const project = await call('update_project', {
      project: 'retreat',
      status: 'paused',
      add_milestone: { title: 'Deposit', due_on: '2026-12-01' },
    })
    expect(dataOf(project)).toMatchObject({
      project: { status: 'paused', milestones: [{ title: 'Deposit', due_on: '2026-12-01', done: false }] },
    })

    const people = dataOf<{ people: Array<{ name: string }> }>(await call('list_people', { search: 'sar' }))
    expect(people.people.map((p) => p.name)).toEqual(['Sarah Jones'])

    const dup = await call('create_project', { name: 'retreat', context: 'Parish' })
    expect(dup.isError).toBe(true)
    expect(textOf(dup)).toContain('already a project')
  })

  it('offers only the read tools to a read connection', async () => {
    const read = await connect(identityFor(await makeUser('reader@example.test'), ['meetings:read']))
    const names = (await read.client.listTools()).tools.map((tool) => tool.name)
    expect(names).toContain('list_items')
    expect(names).not.toContain('capture_item')
    await read.close()
  })
})
