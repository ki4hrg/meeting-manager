import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listItems } from '../lib/items/items'
import { createMeeting } from '../lib/meetings/meetings'
import { db, resetBetweenTests } from './helpers/db'
import { actor, makeWorld } from './helpers/fixtures'
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

  it('records the meeting an item came out of, in its context', async () => {
    const meeting = await createMeeting(db, actor, { contextId: world.parish.id, title: 'Staff' })
    const result = await call('capture_item', {
      text: 'Send the minutes',
      kind: 'action',
      owners: ['sarah'],
      from_meeting: meeting.id,
    })
    expect(result.isError).toBeFalsy()
    const { item } = dataOf<{ item: Item }>(result)
    expect(item).toMatchObject({ context_id: world.parish.id, origin_meeting_id: meeting.id })
    expect(await listItems(db, { contextId: world.parish.id, originMeetingId: meeting.id })).toHaveLength(1)
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

    const parked = dataOf<{ item: Item }>(
      await call('update_item', { id: item.id, later_on: '2027-02-01' }),
    ).item
    expect(parked).toMatchObject({ later: true, later_on: '2027-02-01' })
    const back = dataOf<{ item: Item }>(await call('update_item', { id: item.id, later: false })).item
    expect(back).not.toHaveProperty('later')
  })

  it('parks an item until another is done, and get_item shows both ends', async () => {
    const capture = async (text: string) =>
      dataOf<{ item: Item }>(await call('capture_item', { text, kind: 'action', context: 'Parish' })).item
    const survey = await capture('Put together the survey')
    const email = await capture('Send post-event email')

    const parked = dataOf<{ item: Item }>(
      await call('update_item', { id: email.id, later_until_item: survey.id }),
    ).item
    expect(parked).toMatchObject({ later: true, later_on: null, later_until_item_id: survey.id })

    const waiting = dataOf<{ waits_on: Item }>(await call('get_item', { id: email.id }))
    expect(waiting.waits_on).toMatchObject({ id: survey.id, text: 'Put together the survey' })
    const holding = dataOf<{ holds_up: Item[] }>(await call('get_item', { id: survey.id }))
    expect(holding.holds_up.map((one) => one.id)).toEqual([email.id])

    const self = await call('update_item', { id: email.id, later_until_item: email.id })
    expect(self.isError).toBe(true)
    expect(textOf(self)).toContain('itself')

    await call('update_item', { id: survey.id, status: 'done' })
    const back = dataOf<{ item: Item }>(await call('get_item', { id: email.id }))
    expect(back.item).not.toHaveProperty('later')
    expect(back).not.toHaveProperty('waits_on')
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
      project: { status: 'paused', milestones: [{ title: 'Deposit', due_on: '2026-12-01' }] },
    })

    const people = dataOf<{ people: Array<{ name: string }> }>(await call('list_people', { search: 'sar' }))
    expect(people.people.map((p) => p.name)).toEqual(['Sarah Jones'])

    const dup = await call('create_project', { name: 'retreat', context: 'Parish' })
    expect(dup.isError).toBe(true)
    expect(textOf(dup)).toContain('already a project')
  })

  it('keeps several addresses per person, primary first, and names who has one already', async () => {
    const made = dataOf<{ person: { id: string; email: string; emails: string[] } }>(
      await call('create_person', { name: 'Adlene', emails: ['adlene@work.test', 'Adlene@home.test'] }),
    )
    expect(made.person).toMatchObject({ email: 'adlene@work.test', emails: ['adlene@work.test', 'adlene@home.test'] })

    const updated = dataOf<{ person: { email: string; emails: string[] } }>(
      await call('update_person', { person: 'Adlene', emails: ['adlene@home.test', 'adlene@new.test'] }),
    )
    expect(updated.person).toEqual(
      expect.objectContaining({ email: 'adlene@home.test', emails: ['adlene@home.test', 'adlene@new.test'] }),
    )

    const taken = await call('update_person', { person: 'Adlene', emails: ['sarah@example.test'] })
    expect(taken.isError).toBe(true)
    expect(textOf(taken)).toContain('Sarah Jones')
  })

  it('offers only the read tools to a read connection', async () => {
    const read = await connect(identityFor(await makeUser('reader@example.test'), ['meetings:read']))
    const names = (await read.client.listTools()).tools.map((tool) => tool.name)
    expect(names).toContain('list_items')
    expect(names).not.toContain('capture_item')
    await read.close()
  })
})

describe('set_archived', () => {
  it('takes a project off the lists and name lookups, and brings it back', async () => {
    const archived = await call('set_archived', { kind: 'project', id: world.retreat.id, archived: true })
    expect(dataOf(archived)).toMatchObject({ archived: true })
    const listed = dataOf<{ projects: Array<{ name: string }> }>(await call('list_projects', { context: 'Parish' }))
    expect(listed.projects.map((p) => p.name)).toEqual(['Capital campaign'])
    const capture = await call('capture_item', { text: 'Book the hall', project: 'retreat', context: 'Parish' })
    expect(capture.isError).toBe(true)

    await call('set_archived', { kind: 'project', id: world.retreat.id, archived: false })
    expect((await call('capture_item', { text: 'Book the hall', project: 'retreat', context: 'Parish' })).isError).toBeFalsy()
  })

  it('refuses archiving yourself', async () => {
    const result = await call('set_archived', { kind: 'person', id: world.john.id, archived: true })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('yourself')
  })
})

describe('group addresses', () => {
  it('are set on create_group and replaced by update_group', async () => {
    const made = dataOf<{ group: { id: string; emails: string[] } }>(
      await call('create_group', { name: 'Finance', context: 'Parish', emails: ['finance@example.test'] }),
    )
    expect(made.group.emails).toEqual(['finance@example.test'])
    const updated = dataOf<{ group: { name: string; emails: string[] } }>(
      await call('update_group', { group: 'finance', name: 'Finance committee', emails: ['money@example.test'] }),
    )
    expect(updated.group).toMatchObject({ name: 'Finance committee', emails: ['money@example.test'] })
    const taken = await call('update_group', { group: 'finance committee', emails: ['sarah@example.test'] })
    expect(taken.isError).toBe(true)
    expect(textOf(taken)).toContain('belongs to Sarah Jones')
  })
})
