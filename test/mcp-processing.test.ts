import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { documents, meetings, notes, processingRuns, proposals, users } from '../lib/db/schema'
import { listItems } from '../lib/items/items'
import { addProposals } from '../lib/processing/proposals'
import { processQueued } from '../lib/processing/run'
import { db, resetBetweenTests } from './helpers/db'
import { actor, makeWorld } from './helpers/fixtures'
import { createMeeting } from '../lib/meetings/meetings'
import { connect, dataOf, identityFor, makeUser, textOf, type ConnectedClient } from './helpers/mcp'

/* The job is never run from a tool call here: the tests stand in for it with
   processQueued, and only check that it was asked for. */
const kick = vi.hoisted(() => vi.fn<(name: string) => Promise<unknown>>(async () => ({})))
vi.mock('../lib/jobs', () => ({ PROCESS_NOTES: 'process-notes', kick }))

resetBetweenTests()

type World = Awaited<ReturnType<typeof makeWorld>>
type Named = { id: string; name: string }
type Party = { type: string | null; id: string | null; name: string; unresolved?: boolean }
type Item = { id: string; kind: string; status: string; text: string; origin_meeting_id: string | null }
type Meeting = {
  id: string
  context_id: string
  title: string
  starts_at: string | null
  starts_at_local: string | null
  ends_at: string | null
  ends_at_local: string | null
  people: Named[]
  projects: Named[]
}
type RunOut = {
  id: string
  note_id: string
  status: string
  model: string | null
  error: string | null
  finished_at: string | null
  finished_at_local: string | null
}
type Proposal = {
  id: string
  status: 'pending' | 'accepted' | 'rejected'
  type: 'item' | 'update' | 'document' | 'stub'
  kind?: string
  text?: string | null
  detail?: string | null
  owners?: Party[]
  with?: Party[]
  project?: Named | null
  due_on?: string | null
  title?: string
  body?: string
  people?: Party[]
  change?: string
  item?: Item | null
  verbatim: boolean
  low_confidence: boolean
  unresolved: string[]
  made: { item: Item | null; document: { id: string; title: string } | null; meeting: { id: string; title: string } | null } | null
  resolved_at: string | null
  resolved_at_local: string | null
}
type Counts = { pending: number; accepted: number; rejected: number }
type Logged = { context: Named; meeting: Meeting; note_id: string; run: RunOut }
type Listing = { meeting: Meeting; run: RunOut | null; counts: Counts; proposals: Proposal[] }
type Resolved = { proposal: Proposal; counts: Counts }
type Recap = {
  meeting: Meeting
  subject: string
  markdown: string
  recipients: { name: string; email: string }[]
  snippet?: { for: { type: string; id: string; name: string }; markdown: string }
}

const NOTES = [
  'Met in the vestry, about the spring.',
  'D: Move the retreat to May #retreat',
  'Q: Who books the hall? @sarah',
  '- T: Rota for Advent',
  'A: Send the budget @tom',
].join('\n')

let world: World
let connection: ConnectedClient

beforeEach(async () => {
  kick.mockClear()
  world = await makeWorld()
  const userId = await makeUser()
  // Not UTC and not the machine's zone, so a rendering that ignored it would show.
  await db.update(users).set({ timeZone: 'America/Chicago' }).where(eq(users.id, userId))
  connection = await connect(identityFor(userId))
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await connection.close()
})

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await connection.client.callTool({ name, arguments: args })) as CallToolResult
}

/* The data of a call that must have worked; a refusal fails with its own text. */
async function ok<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = await call(name, args)
  expect(result.isError, textOf(result)).toBeFalsy()
  return dataOf<T>(result)
}

async function refusal(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await call(name, args)
  expect(result.isError).toBe(true)
  return textOf(result)
}

/* Log the vestry meeting and let the job's work happen, with no model. */
async function logged(notes = NOTES): Promise<Logged> {
  const result = await ok<Logged>('log_meeting', {
    context: 'Parish',
    people: ['sarah', 'tom'],
    starts_at: '2026-09-29T14:00',
    minutes: 30,
    notes,
  })
  expect(await processQueued(db, null)).toEqual({ processed: 1, failed: 0 })
  return result
}

async function listing(id: string, args: Record<string, unknown> = {}): Promise<Listing> {
  return ok<Listing>('list_proposals', { id, ...args })
}

function byKind(list: Listing, kind: string): Proposal {
  const found = list.proposals.find((proposal) => proposal.kind === kind)
  if (!found) throw new Error(`no ${kind} proposal`)
  return found
}

const parishItems = () => listItems(db, { contextId: world.parish.id })

describe('log_meeting', () => {
  it('makes the meeting, saves the notes and queues a run, and nothing else', async () => {
    const result = await ok<Logged>('log_meeting', {
      context: 'Parish',
      people: ['sarah', 'tom'],
      projects: ['retreat'],
      starts_at: '2026-09-29T14:00',
      minutes: 30,
      notes: NOTES,
    })

    expect(result.context).toEqual({ id: world.parish.id, name: 'Parish' })
    expect(result.meeting).toMatchObject({
      context_id: world.parish.id,
      title: 'Sarah Jones & Tom Baker',
      // Two in the afternoon in Chicago, not in UTC.
      starts_at: '2026-09-29T19:00:00.000Z',
      ends_at: '2026-09-29T19:30:00.000Z',
      projects: [{ id: world.retreat.id, name: 'Retreat' }],
    })
    expect(result.meeting.starts_at_local).toContain('2:00 PM')
    expect(result.meeting.ends_at_local).toContain('2:30 PM')
    expect(result.meeting.people.map((person) => person.name).sort()).toEqual([
      'Sarah Jones',
      'Tom Baker',
    ])
    expect(result.run).toMatchObject({ note_id: result.note_id, status: 'queued', model: null })

    // Nothing has been processed, so nothing is proposed and nothing is an item.
    const before = await listing(result.meeting.id)
    expect(before.run).toMatchObject({ id: result.run.id, status: 'queued' })
    expect(before.proposals).toEqual([])
    expect(await parishItems()).toHaveLength(0)
  })

  it('kicks the job after a run is queued, but never from a test run or with the worker off', async () => {
    const args = { context: 'Parish', people: ['sarah'], notes: 'T: One thing' }

    // As the suite runs: Vitest is in the environment, and the job is left alone.
    const first = await ok<Logged>('log_meeting', args)
    await ok('process_meeting', { id: first.meeting.id })
    expect(kick).not.toHaveBeenCalled()

    vi.stubEnv('VITEST', '')
    vi.stubEnv('WORKER', 'off')
    await ok<Logged>('log_meeting', args)
    expect(kick).not.toHaveBeenCalled()

    vi.stubEnv('WORKER', '')
    const third = await ok<Logged>('log_meeting', args)
    expect(kick).toHaveBeenCalledTimes(1)
    expect(kick).toHaveBeenLastCalledWith('process-notes')
    // The run was committed before the job was asked to look for it.
    expect(await db.select().from(processingRuns).where(eq(processingRuns.id, third.run.id))).toHaveLength(1)

    await ok('process_meeting', { id: third.meeting.id })
    expect(kick).toHaveBeenCalledTimes(2)

    // A refusal queues nothing and kicks nothing.
    await refusal('log_meeting', { context: 'Parish', people: ['nobody'], notes: 'T: x' })
    expect(kick).toHaveBeenCalledTimes(2)
  })

  it('resolves names as the other tools do, and refuses rather than guessing', async () => {
    expect(await refusal('log_meeting', { notes: 'T: x', people: ['sarah'] })).toContain(
      'Say which context this belongs to: Parish, Diocese',
    )
    expect(
      await refusal('log_meeting', { context: 'Parish', notes: 'T: x', people: ['zed'] }),
    ).toContain('No person matches zed')
    expect(
      await refusal('log_meeting', { context: 'Parish', notes: '   ', people: ['sarah'] }),
    ).toContain('Enter some notes')
    expect(await db.select().from(meetings)).toHaveLength(0)

    // A group decides the context, and with nobody picked its members were there.
    const staff = await ok<Logged>('log_meeting', { group: 'staff', notes: 'T: Rota' })
    expect(staff.meeting.context_id).toBe(world.parish.id)
    expect(staff.meeting.title).toBe('Staff')
    expect(staff.meeting.people.map((person) => person.name).sort()).toEqual([
      'Sarah Jones',
      'Tom Baker',
    ])
  })

  it('writes once for one idempotency key', async () => {
    const args = { context: 'Parish', people: ['sarah'], notes: NOTES, idempotency_key: 'log-vestry-1' }
    const first = await ok<Logged>('log_meeting', args)
    const again = await ok<Logged>('log_meeting', args)
    expect(again.meeting.id).toBe(first.meeting.id)
    expect(await db.select().from(meetings)).toHaveLength(1)
  })
})

describe('list_proposals', () => {
  it('lists the verbatim lines as pending proposals once the run is done', async () => {
    const { meeting, run } = await logged()
    const list = await listing(meeting.id)

    expect(list.meeting.id).toBe(meeting.id)
    expect(list.run).toMatchObject({ id: run.id, status: 'done', model: null, error: null })
    expect(list.run!.finished_at_local).toMatch(/[AP]M$/)
    expect(list.counts).toEqual({ pending: 4, accepted: 0, rejected: 0 })
    expect(list.proposals.map((proposal) => [proposal.type, proposal.kind, proposal.status])).toEqual([
      ['item', 'decision', 'pending'],
      ['item', 'question', 'pending'],
      ['item', 'topic', 'pending'],
      ['item', 'action', 'pending'],
    ])
    expect(list.proposals.every((proposal) => proposal.verbatim && !proposal.low_confidence)).toBe(true)

    expect(byKind(list, 'decision')).toMatchObject({
      project: { id: world.retreat.id, name: 'Retreat' },
      made: null,
      resolved_at: null,
    })
    expect(byKind(list, 'decision').text).toContain('Move the retreat to May')
    expect(byKind(list, 'question').owners).toEqual([
      { type: 'person', id: world.sarah.id, name: 'Sarah Jones' },
    ])
    expect(byKind(list, 'topic').text).toBe('Rota for Advent')
    expect(byKind(list, 'action').owners).toEqual([
      { type: 'person', id: world.tom.id, name: 'Tom Baker' },
    ])

    // Still nothing real.
    expect(await parishItems()).toHaveLength(0)
  })

  it('filters by status and keeps the counts whole', async () => {
    const { meeting } = await logged()
    const topic = byKind(await listing(meeting.id), 'topic')
    await ok<Resolved>('resolve_proposal', { id: meeting.id, op: 'reject', proposal_id: topic.id })

    const rejected = await listing(meeting.id, { status: 'rejected' })
    expect(rejected.proposals.map((proposal) => proposal.id)).toEqual([topic.id])
    expect(rejected.counts).toEqual({ pending: 3, accepted: 0, rejected: 1 })
    expect((await listing(meeting.id, { status: 'accepted' })).proposals).toEqual([])
  })
})

describe('resolve_proposal', () => {
  it('accepts, rejects and undoes, one proposal at a time', async () => {
    const { meeting } = await logged()
    const list = await listing(meeting.id)
    const decision = byKind(list, 'decision')
    const topic = byKind(list, 'topic')
    const id = meeting.id

    const accepted = await ok<Resolved>('resolve_proposal', { id, op: 'accept', proposal_id: decision.id })
    expect(accepted.proposal).toMatchObject({ id: decision.id, status: 'accepted' })
    expect(accepted.proposal.made!.item).toMatchObject({
      kind: 'decision',
      status: 'decided',
      origin_meeting_id: id,
    })
    expect(accepted.proposal.resolved_at_local).toMatch(/[AP]M$/)
    expect(accepted.counts).toEqual({ pending: 3, accepted: 1, rejected: 0 })
    expect((await parishItems()).map((item) => item.id)).toEqual([accepted.proposal.made!.item!.id])

    const rejected = await ok<Resolved>('resolve_proposal', { id, op: 'reject', proposal_id: topic.id })
    expect(rejected.proposal).toMatchObject({ status: 'rejected', made: null })
    expect(rejected.counts).toEqual({ pending: 2, accepted: 1, rejected: 1 })
    expect(await parishItems()).toHaveLength(1)

    // Each is refused in the other's direction until it is undone.
    expect(await refusal('resolve_proposal', { id, op: 'accept', proposal_id: topic.id })).toContain(
      'was rejected',
    )
    expect(await refusal('resolve_proposal', { id, op: 'reject', proposal_id: decision.id })).toContain(
      'was accepted',
    )
    expect(
      await refusal('resolve_proposal', { id, op: 'edit', proposal_id: decision.id, text: 'Changed' }),
    ).toContain('has been accepted')

    // Undoing the rejection puts it back; undoing the acceptance takes the item back.
    const back = await ok<Resolved>('resolve_proposal', { id, op: 'undo', proposal_id: topic.id })
    expect(back.proposal).toMatchObject({ status: 'pending', resolved_at: null })
    const undone = await ok<Resolved>('resolve_proposal', { id, op: 'undo', proposal_id: decision.id })
    expect(undone.proposal).toMatchObject({ status: 'pending', made: null })
    expect(undone.counts).toEqual({ pending: 4, accepted: 0, rejected: 0 })
    expect(await parishItems()).toHaveLength(0)
  })

  it('edits a pending proposal, and edits then accepts in one call', async () => {
    const { meeting } = await logged()
    const list = await listing(meeting.id)
    const question = byKind(list, 'question')
    const action = byKind(list, 'action')
    const id = meeting.id

    const edited = await ok<Resolved>('resolve_proposal', {
      id,
      op: 'edit',
      proposal_id: question.id,
      text: 'Who books the parish hall?',
      owners: ['tom'],
      with: ['staff'],
      project: 'retreat',
      due_on: '2026-10-09',
      detail: 'Before the retreat is announced.',
    })
    expect(edited.proposal).toMatchObject({
      status: 'pending',
      text: 'Who books the parish hall?',
      owners: [{ type: 'person', id: world.tom.id, name: 'Tom Baker' }],
      with: [{ type: 'group', id: world.staff.id, name: 'Staff' }],
      project: { id: world.retreat.id, name: 'Retreat' },
      due_on: '2026-10-09',
      detail: 'Before the retreat is announced.',
      verbatim: true,
    })
    expect(await parishItems()).toHaveLength(0)

    // What is not restated is kept; null clears.
    const cleared = await ok<Resolved>('resolve_proposal', {
      id,
      op: 'edit',
      proposal_id: question.id,
      project: null,
      due_on: null,
    })
    expect(cleared.proposal).toMatchObject({
      text: 'Who books the parish hall?',
      owners: [{ id: world.tom.id }],
      project: null,
      due_on: null,
    })

    const accepted = await ok<Resolved>('resolve_proposal', {
      id,
      op: 'accept',
      proposal_id: action.id,
      text: 'Send the budget to the wardens',
      owners: ['sarah'],
      due_on: '2026-10-02',
    })
    expect(accepted.proposal).toMatchObject({ status: 'accepted', text: 'Send the budget to the wardens' })
    expect(accepted.proposal.made!.item).toMatchObject({
      kind: 'action',
      text: 'Send the budget to the wardens',
      due_on: '2026-10-02',
      owners: [{ type: 'person', id: world.sarah.id, name: 'Sarah Jones' }],
      origin_meeting_id: id,
    })

    // An edit that cannot be accepted changes nothing: the two are one step.
    const decision = byKind(list, 'decision')
    expect(
      await refusal('resolve_proposal', {
        id,
        op: 'accept',
        proposal_id: decision.id,
        text: 'Move it to June',
        due_on: 'next week',
      }),
    ).toContain('not a date')
    expect(byKind(await listing(id), 'decision').text).toBe(decision.text)
  })

  it('refuses a name it cannot place, and a field the op or the proposal does not take', async () => {
    const { meeting } = await logged('A: Ring the diocese @nobody\nT: Rota')
    const id = meeting.id
    const list = await listing(id)
    const action = byKind(list, 'action')
    const topic = byKind(list, 'topic')

    expect(action.unresolved).toEqual(['nobody'])
    expect(action.owners).toEqual([{ type: null, id: null, name: 'nobody', unresolved: true }])
    expect(await refusal('resolve_proposal', { id, op: 'accept', proposal_id: action.id })).toContain(
      'Say who nobody is',
    )

    const edit = (args: Record<string, unknown>) =>
      refusal('resolve_proposal', { id, op: 'edit', proposal_id: topic.id, ...args })
    expect(await edit({ owners: ['zed'] })).toContain('No person or group matches zed')
    expect(await edit({})).toContain('edit needs something to change')
    expect(await edit({ title: 'Rota', body: 'x' })).toContain(
      'An item proposal does not take title, body',
    )
    expect(await edit({ text: null })).toContain('Enter some text')
    expect(
      await refusal('resolve_proposal', { id, op: 'reject', proposal_id: topic.id, text: 'x' }),
    ).toContain('reject does not take text')
    expect(await refusal('resolve_proposal', { id, op: 'accept' })).toContain('accept needs proposal_id')
    expect(
      await refusal('resolve_proposal', { id, op: 'approve_all', proposal_id: topic.id }),
    ).toContain('approve_all does not take proposal_id')
    expect((await listing(id)).counts).toEqual({ pending: 2, accepted: 0, rejected: 0 })

    // Naming the owner settles it, and then it can be accepted in the same call.
    const accepted = await ok<Resolved>('resolve_proposal', {
      id,
      op: 'accept',
      proposal_id: action.id,
      owners: ['bishop'],
    })
    expect(accepted.proposal).toMatchObject({ status: 'accepted', unresolved: [] })
    expect(accepted.proposal.made!.item).toMatchObject({
      owners: [{ type: 'person', id: world.bishop.id, name: 'Bishop Wright' }],
    })
  })

  it('approves all that need no thought and leaves the rest', async () => {
    const { meeting } = await logged(`${NOTES}\nA: Ring the diocese @nobody`)
    const id = meeting.id
    const topic = byKind(await listing(id), 'topic')
    await ok<Resolved>('resolve_proposal', { id, op: 'reject', proposal_id: topic.id })

    const done = await ok<{
      accepted: number
      left: number
      refused: { proposal_id: string; message: string }[]
      proposals: Proposal[]
    }>('resolve_proposal', { id, op: 'approve_all' })

    expect(done).toMatchObject({ accepted: 3, left: 1, refused: [] })
    expect(done.proposals.map((proposal) => proposal.status).sort()).toEqual([
      'accepted',
      'accepted',
      'accepted',
      'pending',
      'rejected',
    ])
    expect(done.proposals.find((proposal) => proposal.status === 'pending')!.unresolved).toEqual([
      'nobody',
    ])
    expect((await parishItems()).map((item) => item.kind).sort()).toEqual([
      'action',
      'decision',
      'question',
    ])
  })

  it('settles the other types: an update, a document and a stub', async () => {
    const { meeting } = await logged('T: Rota')
    const id = meeting.id
    const open = (
      await ok<{ item: Item }>('capture_item', {
        text: 'Order the candles',
        kind: 'action',
        context: 'Parish',
        owners: ['sarah'],
      })
    ).item
    await addProposals(db, { meetingId: id }, [
      { payload: { type: 'update', itemId: open.id, change: 'complete', text: 'Ordered' } },
      { payload: { type: 'document', title: 'Draft letter', body: 'Dear all' } },
      { payload: { type: 'stub', title: 'Follow up', people: [{ name: 'Someone' }] } },
    ])
    const list = await listing(id)
    const of = (type: string) => list.proposals.find((proposal) => proposal.type === type)!

    expect(of('update')).toMatchObject({ change: 'complete', text: 'Ordered', item: { id: open.id } })
    const closed = await ok<Resolved>('resolve_proposal', {
      id,
      op: 'accept',
      proposal_id: of('update').id,
      text: 'Ordered from the usual place',
    })
    expect(closed.proposal.item).toMatchObject({ id: open.id, status: 'done' })
    const reopened = await ok<Resolved>('resolve_proposal', { id, op: 'undo', proposal_id: of('update').id })
    expect(reopened.proposal.item).toMatchObject({ id: open.id, status: 'open' })
    expect(
      await refusal('resolve_proposal', { id, op: 'edit', proposal_id: of('update').id, owners: ['tom'] }),
    ).toContain('An update proposal does not take owners')

    const saved = await ok<Resolved>('resolve_proposal', {
      id,
      op: 'accept',
      proposal_id: of('document').id,
      title: 'Letter to the parish',
      project: 'retreat',
    })
    expect(saved.proposal).toMatchObject({
      title: 'Letter to the parish',
      body: 'Dear all',
      project: { id: world.retreat.id },
    })
    expect(saved.proposal.made!.document).toMatchObject({ title: 'Letter to the parish' })
    expect(await db.select().from(documents)).toHaveLength(1)

    expect(of('stub')).toMatchObject({ title: 'Follow up', unresolved: ['Someone'] })
    expect(
      await refusal('resolve_proposal', { id, op: 'edit', proposal_id: of('stub').id, people: ['staff'] }),
    ).toContain('No person matches staff')
    const stub = await ok<Resolved>('resolve_proposal', {
      id,
      op: 'accept',
      proposal_id: of('stub').id,
      people: ['tom'],
    })
    expect(stub.proposal.people).toEqual([{ type: 'person', id: world.tom.id, name: 'Tom Baker' }])
    expect(stub.proposal.made!.meeting).toMatchObject({ title: 'Follow up' })
    expect(await db.select().from(meetings)).toHaveLength(2)
  })
})

describe('process_meeting', () => {
  it('queues the notes again, and what was handled stays handled', async () => {
    const { meeting, run } = await logged()
    const id = meeting.id
    const list = await listing(id)
    const decision = byKind(list, 'decision')
    const topic = byKind(list, 'topic')
    await ok<Resolved>('resolve_proposal', { id, op: 'accept', proposal_id: decision.id })
    await ok<Resolved>('resolve_proposal', { id, op: 'reject', proposal_id: topic.id })

    const again = await ok<{ meeting: Meeting; queued: number; run: RunOut }>('process_meeting', { id })
    expect(again.meeting.id).toBe(id)
    expect(again.queued).toBe(1)
    expect(again.run).toMatchObject({ id: run.id, status: 'queued', finished_at: null })
    expect((await listing(id)).run).toMatchObject({ status: 'queued' })

    // Asked again while it waits: nothing more to queue.
    expect((await ok<{ queued: number }>('process_meeting', { id })).queued).toBe(0)

    expect(await processQueued(db, null)).toEqual({ processed: 1, failed: 0 })
    const after = await listing(id)
    expect(after.run).toMatchObject({ status: 'done' })
    expect(after.counts).toEqual({ pending: 2, accepted: 1, rejected: 1 })
    expect(after.proposals.map((proposal) => proposal.id).sort()).toEqual(
      list.proposals.map((proposal) => proposal.id).sort(),
    )
    expect(await parishItems()).toHaveLength(1)
  })

  it('refuses a meeting with no notes', async () => {
    const prepped = await ok<{ meeting: Meeting }>('prep_meeting', { context: 'Parish', title: 'Empty' })
    expect(await refusal('process_meeting', { id: prepped.meeting.id })).toContain(
      'That meeting has no notes to process',
    )
    expect(await db.select().from(processingRuns)).toHaveLength(0)
  })
})

describe('the Inbox', () => {
  /* A note as an unbound Granola delivery leaves it: on no meeting, with when it was. */
  async function held(title: string) {
    const [note] = await db
      .insert(notes)
      .values({
        meetingId: null,
        source: 'granola',
        externalId: `not_${title.padEnd(14, '0').slice(0, 14)}`,
        title,
        body: 'D: Keep the hall',
        contentHash: title,
        filing: { startsAt: '2026-09-29T19:00:00.000Z', endsAt: null, calendarEventId: null },
        attendees: [{ email: 'sarah@example.test', name: 'Sarah' }],
      })
      .returning()
    return note!
  }

  it('lists what waits, files one into a context and dismisses another', async () => {
    const one = await held('Hallway')
    const two = await held('Parking lot')

    const waiting = await ok<{ notes: { id: string; title: string; starts_at_local: string }[] }>(
      'list_unfiled_notes',
      {},
    )
    expect(waiting.notes.map((note) => note.title).sort()).toEqual(['Hallway', 'Parking lot'])
    expect(waiting.notes[0]!.starts_at_local).toBe('Tue, Sep 29, 2:00 PM')

    expect(await refusal('file_note', { id: one.id })).toMatch(/context/i)
    const filed = await ok<{ meeting: Meeting; via: string }>('file_note', { id: one.id, context: 'Parish' })
    expect(filed.via).toBe('new')
    expect(filed.meeting).toMatchObject({ context_id: world.parish.id, title: 'Hallway' })
    expect(filed.meeting.people.map((person) => person.id)).toEqual([world.sarah.id])
    expect(await db.select().from(processingRuns)).toHaveLength(1)

    expect(await ok('file_note', { id: two.id, dismiss: true })).toEqual({ dismissed: true })
    expect((await ok<{ notes: unknown[] }>('list_unfiled_notes', {})).notes).toEqual([])
    expect(await refusal('file_note', { id: one.id, context: 'Diocese' })).toMatch(/already filed/)
  })

  it('files a note on the meeting given, in that meeting\'s context', async () => {
    const one = await held('Hallway')
    const staff = await createMeeting(db, actor, { contextId: world.diocese.id, title: 'Staff' })
    expect(await refusal('file_note', { id: one.id, meeting: staff.id, dismiss: true })).toMatch(/no context/)
    expect(await refusal('file_note', { id: one.id, meeting: staff.id, context: 'Parish' })).toMatch(
      /another context/,
    )
    const filed = await ok<{ meeting: Meeting; via: string }>('file_note', { id: one.id, meeting: staff.id })
    expect(filed.via).toBe('chosen')
    expect(filed.meeting).toMatchObject({ id: staff.id, context_id: world.diocese.id })
  })
})

describe('render_recap', () => {
  it('renders what was accepted, and nothing that was not', async () => {
    const { meeting } = await logged()
    const id = meeting.id
    const list = await listing(id)
    await ok<Resolved>('resolve_proposal', { id, op: 'accept', proposal_id: byKind(list, 'decision').id })
    await ok<Resolved>('resolve_proposal', { id, op: 'accept', proposal_id: byKind(list, 'question').id })
    await ok<Resolved>('resolve_proposal', { id, op: 'reject', proposal_id: byKind(list, 'topic').id })

    const recap = await ok<Recap>('render_recap', { id })
    expect(recap.meeting.id).toBe(id)
    expect(recap.markdown).toContain('# Sarah Jones & Tom Baker')
    // On the account clock.
    expect(recap.markdown).toContain('2:00 PM')
    expect(recap.markdown).toContain('## Decisions')
    expect(recap.markdown).toContain(byKind(list, 'decision').text)
    expect(recap.markdown).toContain('## Follow-ups')
    expect(recap.markdown).toContain('Who books the hall?')
    // Rejected, and still pending: neither has reached the record.
    expect(recap.markdown).not.toContain('Rota for Advent')
    expect(recap.markdown).not.toContain('Send the budget')
    expect(recap.subject).toContain('Recap: Sarah Jones & Tom Baker')
    expect(recap.recipients).toEqual([{ name: 'Sarah Jones', email: 'sarah@example.test' }])
    expect(recap.snippet).toBeUndefined()

    const forSarah = await ok<Recap>('render_recap', { id, for: 'sarah' })
    expect(forSarah.snippet!.for).toEqual({ type: 'person', id: world.sarah.id, name: 'Sarah Jones' })
    expect(forSarah.snippet!.markdown).toContain('Who books the hall?')
    // Tom owes nothing that has been accepted.
    expect((await ok<Recap>('render_recap', { id, for: 'tom' })).snippet!.markdown).toBe('')

    expect(await refusal('render_recap', { id, for: 'council' })).toContain(
      'No person or group matches council',
    )
  })
})

describe('context isolation', () => {
  it('refuses a meeting asked for in another context, and changes nothing', async () => {
    const { meeting } = await logged()
    const id = meeting.id
    const decision = byKind(await listing(id), 'decision')
    const runsBefore = await db.select().from(processingRuns)

    for (const [tool, args] of [
      ['list_proposals', {}],
      ['process_meeting', {}],
      ['render_recap', {}],
      ['resolve_proposal', { op: 'accept', proposal_id: decision.id }],
      ['resolve_proposal', { op: 'approve_all' }],
    ] as const) {
      expect(await refusal(tool, { id, context: 'Diocese', ...args }), tool).toContain(
        'That meeting belongs to another context',
      )
      expect(await refusal(tool, { id, context: world.diocese.id, ...args }), tool).toContain(
        'That meeting belongs to another context',
      )
      expect(await refusal(tool, { id, context: 'Nowhere', ...args }), tool).toContain(
        'No single context matches Nowhere',
      )
    }
    expect(await db.select().from(processingRuns)).toEqual(runsBefore)
    expect(await parishItems()).toHaveLength(0)

    // In its own context, named or not, it answers.
    expect((await listing(id, { context: 'Parish' })).counts.pending).toBe(4)
    expect((await listing(id)).counts.pending).toBe(4)
  })

  it('reaches a proposal only through its own meeting', async () => {
    const parish = await logged()
    const there = await ok<Logged>('log_meeting', {
      context: 'Diocese',
      people: ['bishop'],
      notes: 'D: Hold the synod in June #synod',
    })
    expect(await processQueued(db, null)).toEqual({ processed: 1, failed: 0 })
    const theirs = byKind(await listing(there.meeting.id), 'decision')
    expect(theirs.project).toEqual({ id: world.synod.id, name: 'Synod' })

    // The Diocese's proposal, asked for through the Parish's meeting.
    for (const op of ['accept', 'reject', 'undo', 'edit']) {
      expect(
        await refusal('resolve_proposal', {
          id: parish.meeting.id,
          op,
          proposal_id: theirs.id,
          ...(op === 'edit' ? { text: 'Changed' } : {}),
        }),
        op,
      ).toContain(`No proposal of this meeting has the id ${theirs.id}`)
    }
    const [row] = await db.select().from(proposals).where(eq(proposals.id, theirs.id))
    expect(row).toMatchObject({ status: 'pending' })
    expect(row!.payload).toMatchObject({ text: theirs.text })

    // The Parish's listing shows only its own.
    const mine = await listing(parish.meeting.id)
    expect(mine.proposals.map((proposal) => proposal.id)).not.toContain(theirs.id)

    // Names in an edit are read in the meeting's context, so the other one's do not resolve.
    const decision = byKind(mine, 'decision')
    const edit = (args: Record<string, unknown>) =>
      refusal('resolve_proposal', { id: parish.meeting.id, op: 'edit', proposal_id: decision.id, ...args })
    expect(await edit({ project: 'synod' })).toContain('No project matches synod')
    expect(await edit({ project: world.synod.id })).toContain('No project in this context has the id')
    expect(await edit({ owners: ['council'] })).toContain('No person or group matches council')
    expect(await edit({ with: [world.council.id] })).toContain(
      'No person or group in this context has the id',
    )
    expect(byKind(await listing(parish.meeting.id), 'decision')).toMatchObject({
      project: { id: world.retreat.id },
      status: 'pending',
    })

    // Logging takes its group and projects from the named context only.
    expect(
      await refusal('log_meeting', { context: 'Diocese', group: 'staff', notes: 'T: x' }),
    ).toContain('No group matches staff')
    expect(
      await refusal('log_meeting', { context: 'Diocese', projects: ['retreat'], people: ['tom'], notes: 'T: x' }),
    ).toContain('No project matches retreat')
    expect(await db.select().from(meetings)).toHaveLength(2)

    // And the recap of one says nothing of the other.
    await ok<Resolved>('resolve_proposal', { id: there.meeting.id, op: 'accept', proposal_id: theirs.id })
    await ok('resolve_proposal', { id: parish.meeting.id, op: 'approve_all' })
    const recap = await ok<Recap>('render_recap', { id: parish.meeting.id })
    expect(recap.markdown).toContain('Move the retreat to May')
    expect(recap.markdown).not.toContain('synod')
  })

  it('needs the write scope to change anything', async () => {
    const { meeting } = await logged()
    const reader = await connect(identityFor(await makeUser('reader@example.test'), ['meetings:read']))
    try {
      const names = (await reader.client.listTools()).tools.map((tool) => tool.name)
      expect(names).toEqual(expect.arrayContaining(['list_proposals', 'render_recap']))
      expect(names).not.toContain('log_meeting')
      expect(names).not.toContain('process_meeting')
      expect(names).not.toContain('resolve_proposal')

      const result = (await reader.client.callTool({
        name: 'resolve_proposal',
        arguments: { id: meeting.id, op: 'approve_all' },
      })) as CallToolResult
      expect(result.isError).toBe(true)
      expect(textOf(result)).toContain('meetings:write')
      expect(await parishItems()).toHaveLength(0)
    } finally {
      await reader.close()
    }
  })
})
