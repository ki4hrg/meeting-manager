/*
 * Processing runs: a note goes in, proposals come out, and nothing else is
 * written. The verbatim lines are read by code and keep their wording; the
 * extractor (a fake here, never a model) adds the rest and is not trusted;
 * a note delivered or processed again proposes only what is new.
 */

import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { addLine } from '../lib/agenda/lines'
import { placeItem } from '../lib/agenda/candidates'
import { NotFoundError, ValidationError } from '../lib/core/types'
import { processingRuns, proposals, users, type ProposalPayload } from '../lib/db/schema'
import { listDocuments } from '../lib/documents/documents'
import { completeItem, createItem, listItems } from '../lib/items/items'
import { createMeeting, listMeetings } from '../lib/meetings/meetings'
import { saveNote } from '../lib/notes/notes'
import {
  acceptProposal,
  editProposal,
  listProposals,
  rejectProposal,
  type ProposalView,
} from '../lib/processing/proposals'
import {
  buildExtractionInput,
  latestRun,
  processQueued,
  processRun,
  queueRun,
  reprocessMeeting,
  type RunExtractor,
} from '../lib/processing/run'
import type { ExtractionInput, ExtractionOutput } from '../lib/processing/types'
import { db, resetBetweenTests } from './helpers/db'
import { actor, makeWorld } from './helpers/fixtures'

resetBetweenTests()

type ItemPayload = Extract<ProposalPayload, { type: 'item' }>

async function setup() {
  const w = await makeWorld()
  const meeting = await createMeeting(db, actor, {
    contextId: w.parish.id,
    title: 'Staff',
    startsAt: new Date('2026-10-01T15:00:00Z'),
    personIds: [w.sarah.id, w.tom.id],
    projectIds: [w.retreat.id],
  })
  return { w, meeting }
}

/* A pasted note and the run queued for it. */
async function paste(meetingId: string, body: string) {
  const { note } = await saveNote(db, actor, { meetingId, source: 'pasted', body })
  const run = await queueRun(db, note.id)
  return { note, run: run! }
}

/* A fake extractor: records what it was given, returns what the test says. */
function fake(answer: (input: ExtractionInput) => Partial<ExtractionOutput> = () => ({})) {
  const seen: ExtractionInput[] = []
  const extractor: RunExtractor = {
    model: 'fake-model-1',
    extractor: async (input) => {
      seen.push(input)
      return { summary: null, lines: [], drafts: [], verbatimDetails: [], ...answer(input) }
    },
  }
  return { extractor, seen }
}

const action = (text: string, over: Partial<ItemPayload> = {}) => ({
  payload: { type: 'item', kind: 'action', text, parties: [], ...over } as ProposalPayload,
  lowConfidence: false,
  agendaLineId: null,
})

const texts = (list: ProposalView[]) =>
  list.map((p) => (p.payload.type === 'item' ? p.payload.text : p.payload.type))

async function runsOf(noteId: string) {
  return db.select().from(processingRuns).where(eq(processingRuns.noteId, noteId))
}

describe('verbatim lines', () => {
  it('takes a D: line from a pasted note to a decision that originates in the meeting', async () => {
    const { w, meeting } = await setup()
    const { note, run } = await paste(
      meeting.id,
      'We talked about the calendar.\nD: Keep the Thursday slot, for now.\nMore chat.',
    )
    expect(run).toMatchObject({ noteId: note.id, status: 'queued', attempts: 0, model: null })
    expect(await listProposals(db, meeting.id)).toEqual([])

    const done = await processRun(db, run.id)
    expect(done).toMatchObject({ id: run.id, status: 'done', model: null, error: null, attempts: 1 })
    expect(done.startedAt).toBeInstanceOf(Date)
    expect(done.finishedAt).toBeInstanceOf(Date)

    const list = await listProposals(db, meeting.id)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      status: 'pending',
      verbatim: true,
      lowConfidence: false,
      noteId: note.id,
      runId: run.id,
      payload: { type: 'item', kind: 'decision', text: 'Keep the Thursday slot, for now.' },
    })
    // Nothing is real before it is accepted.
    expect(await listItems(db, { contextId: w.parish.id })).toEqual([])

    const accepted = await acceptProposal(db, actor, list[0]!.id)
    expect(accepted.made?.item).toMatchObject({
      kind: 'decision',
      text: 'Keep the Thursday slot, for now.',
      originMeetingId: meeting.id,
      contextId: w.parish.id,
    })
    expect(await listItems(db, { contextId: w.parish.id, originMeetingId: meeting.id })).toHaveLength(1)
  })

  it('reads Q: A: T: lines with their @mentions and #projects the way quick-add does', async () => {
    const { w, meeting } = await setup()
    const { run } = await paste(
      meeting.id,
      [
        'Prose that is nobody’s item.',
        '- Q: what is the lunch menu @sarah #retreat',
        'A: ask @tom about the keys',
        '* T: parking @staff',
        'A: call the diocese @me @sarah',
        'A: chase the invoice @priya',
      ].join('\n'),
    )
    await processRun(db, run.id, null)

    const list = await listProposals(db, meeting.id)
    expect(list.every((p) => p.verbatim && p.status === 'pending')).toBe(true)
    expect(list.map((p) => [(p.payload as ItemPayload).kind, (p.payload as ItemPayload).text])).toEqual([
      ['question', 'what is the lunch menu'],
      ['action', 'ask Tom Baker about the keys'],
      ['topic', 'parking'],
      ['action', 'call the diocese'],
      ['action', 'chase the invoice'],
    ])

    const [question, keys, parking, call, chase] = list
    expect(question!.parties).toEqual([
      { role: 'owner', name: 'Sarah Jones', type: 'person', id: w.sarah.id, unresolved: false },
    ])
    expect(question!.project).toEqual({ id: w.retreat.id, name: 'Retreat' })
    expect(keys!.parties).toMatchObject([{ role: 'owner', id: w.tom.id }])
    expect(parking!.parties).toEqual([
      { role: 'with', name: 'Staff', type: 'group', id: w.staff.id, unresolved: false },
    ])
    // John names himself: he owes it, to Sarah.
    expect(call!.parties).toMatchObject([
      { role: 'owner', id: w.john.id },
      { role: 'with', id: w.sarah.id },
    ])
    // A name nobody has is kept, and asked for at review.
    expect(chase!.unresolved).toEqual(['priya'])
    await expect(acceptProposal(db, actor, chase!.id)).rejects.toThrow(ValidationError)

    const made = (await acceptProposal(db, actor, question!.id)).made!.item!
    expect(made).toMatchObject({
      kind: 'question',
      text: 'what is the lunch menu',
      originMeetingId: meeting.id,
      project: { id: w.retreat.id },
    })
    expect(made.parties).toMatchObject([{ id: w.sarah.id, role: 'owner' }])
  })

  it('resolves a group or a project only within the meeting’s context', async () => {
    const { meeting } = await setup()
    const { run } = await paste(meeting.id, 'T: the budget @council #synod')
    await processRun(db, run.id)

    const [only] = await listProposals(db, meeting.id)
    const payload = only!.payload as ItemPayload
    expect(payload.projectId ?? null).toBeNull()
    expect(payload.parties).toEqual([{ role: 'with', name: 'council' }])
    expect(only!.project).toBeNull()
    expect(only!.unresolved).toEqual(['council'])
  })

  it('completes with nothing proposed when the note has no verbatim lines and there is no model', async () => {
    const { meeting } = await setup()
    const { run } = await paste(meeting.id, 'Just a chat. Nothing decided: really.')
    const done = await processRun(db, run.id, null)
    expect(done).toMatchObject({ status: 'done', model: null, output: null, error: null })
    expect(await listProposals(db, meeting.id)).toEqual([])
  })
})

describe('with an extractor', () => {
  it('stores its drafts as proposals, bound to the meeting and its context', async () => {
    const { w, meeting } = await setup()
    const lineId = await addLine(db, actor, meeting.id, { text: 'Budget' })
    const open = await createItem(db, actor, {
      contextId: w.parish.id,
      kind: 'action',
      text: 'Book the hall',
      parties: [{ personId: w.tom.id, role: 'owner' }],
    })
    const closed = await createItem(db, actor, {
      contextId: w.parish.id,
      kind: 'action',
      text: 'Print the flyers',
      parties: [{ personId: w.tom.id, role: 'owner' }],
    })
    await completeItem(db, actor, closed.id, { resolution: null })
    const elsewhere = await createItem(db, actor, {
      contextId: w.diocese.id,
      kind: 'action',
      text: 'Write to the bishop',
      parties: [{ personId: w.sarah.id, role: 'owner' }],
    })
    await createItem(db, actor, {
      contextId: w.parish.id,
      kind: 'action',
      text: 'Order chairs',
      originMeetingId: meeting.id,
    })

    const { extractor, seen } = fake(() => ({
      summary: '  We met.  ',
      lines: [
        { lineId, summary: ' Agreed the budget. ' },
        { lineId: randomUUID(), summary: 'Not a line of this meeting.' },
      ],
      drafts: [
        {
          ...action('Email the caterer', { parties: [{ role: 'owner', name: 'sarah' }] }),
          lowConfidence: true,
          agendaLineId: lineId,
        },
        // The verbatim line again, in the model's own words and kind.
        action('keep the thursday slot'),
        // Already captured in the meeting by quick-add.
        action('Order chairs!'),
        // A project and a group from another context.
        action('Send the minutes', {
          projectId: w.synod.id,
          parties: [{ role: 'with', name: 'Council', groupId: w.council.id }],
        }),
        { payload: { type: 'update', itemId: open.id, change: 'complete', text: 'Booked' }, lowConfidence: false, agendaLineId: null },
        { payload: { type: 'update', itemId: closed.id, change: 'complete' }, lowConfidence: false, agendaLineId: null },
        { payload: { type: 'update', itemId: elsewhere.id, change: 'complete' }, lowConfidence: false, agendaLineId: null },
        { payload: { type: 'document', title: 'Retreat plan', body: 'Day one…', projectId: w.retreat.id }, lowConfidence: false, agendaLineId: null },
        { payload: { type: 'stub', title: 'Follow up', people: [{ name: 'Tom' }] }, lowConfidence: false, agendaLineId: null },
        null,
        { payload: { type: 'nonsense' } },
        { lowConfidence: true },
      ] as ExtractionOutput['drafts'],
      verbatimDetails: [
        { index: 0, detail: ' Thursday suits everyone. ' },
        { index: 7, detail: 'There is no such line.' },
      ],
    }))

    const { run } = await paste(meeting.id, 'D: Keep the Thursday slot')
    const done = await processRun(db, run.id, extractor)

    expect(seen).toHaveLength(1)
    expect(done).toMatchObject({ status: 'done', model: 'fake-model-1', error: null })
    expect(done.output).toEqual({
      summary: 'We met.',
      lines: [{ lineId, summary: 'Agreed the budget.' }],
    })

    const list = await listProposals(db, meeting.id)
    expect(texts(list)).toEqual([
      'Keep the Thursday slot',
      'Email the caterer',
      'Send the minutes',
      'update',
      'document',
      'stub',
    ])
    const [verbatim, caterer, minutes, update, document, stub] = list

    // The wording stays John's; the model only supplies the detail.
    expect(verbatim).toMatchObject({
      verbatim: true,
      payload: { kind: 'decision', text: 'Keep the Thursday slot', detail: 'Thursday suits everyone.' },
    })
    expect(caterer).toMatchObject({
      verbatim: false,
      lowConfidence: true,
      agendaLine: { id: lineId, text: 'Budget' },
      runId: run.id,
    })
    expect(caterer!.parties).toMatchObject([{ role: 'owner', id: w.sarah.id, unresolved: false }])

    // What pointed at another context lost its id, and nothing of that context came with it.
    const sent = minutes!.payload as ItemPayload
    expect(sent.projectId ?? null).toBeNull()
    expect(sent.parties).toEqual([{ role: 'with', name: 'Council' }])
    expect(minutes!.unresolved).toEqual(['Council'])
    expect(JSON.stringify(list)).not.toContain(w.synod.id)
    expect(JSON.stringify(list)).not.toContain(w.council.id)
    expect(JSON.stringify(list)).not.toContain(elsewhere.id)

    expect(update!.payload).toEqual({ type: 'update', itemId: open.id, change: 'complete', text: 'Booked' })
    expect(document!.project).toEqual({ id: w.retreat.id, name: 'Retreat' })
    expect(stub!.parties).toMatchObject([{ id: w.tom.id, unresolved: false }])

    // Still nothing but proposals.
    expect((await listItems(db, { contextId: w.parish.id })).map((item) => item.text).sort()).toEqual([
      'Book the hall',
      'Order chairs',
      'Print the flyers',
    ])
    expect(await listDocuments(db, { contextId: w.parish.id })).toEqual([])
    expect(await listMeetings(db, { contextId: w.parish.id })).toHaveLength(1)
  })

  it('leaves a detail John wrote, and a verbatim line he has already settled, alone', async () => {
    const { meeting } = await setup()
    const first = await paste(meeting.id, 'D: Keep the Thursday slot\nQ: who brings lunch')
    await processRun(db, first.run.id)
    const [decision, question] = await listProposals(db, meeting.id)
    await editProposal(db, actor, decision!.id, {
      ...(decision!.payload as ItemPayload),
      detail: 'My own account.',
    })
    await rejectProposal(db, actor, question!.id)

    const { extractor } = fake(() => ({
      verbatimDetails: [
        { index: 0, detail: 'The model’s account.' },
        { index: 1, detail: 'About lunch.' },
      ],
    }))
    const [again] = await reprocessMeeting(db, actor, meeting.id)
    expect((await processRun(db, again!.id, extractor)).status).toBe('done')

    const list = await listProposals(db, meeting.id)
    expect(list.map((p) => [p.status, (p.payload as ItemPayload).detail ?? null])).toEqual([
      ['pending', 'My own account.'],
      ['rejected', null],
    ])
  })

  it('survives output that is not the shape it promised', async () => {
    const { meeting } = await setup()
    const { run } = await paste(meeting.id, 'D: one thing')
    const done = await processRun(db, run.id, {
      model: 'fake-model-1',
      extractor: async () =>
        ({ summary: 7, lines: 'no', drafts: { not: 'a list' }, verbatimDetails: [null, 'x'] }) as never,
    })
    expect(done).toMatchObject({ status: 'done', output: { summary: null, lines: [] } })
    expect(texts(await listProposals(db, meeting.id))).toEqual(['one thing'])
  })
})

describe('buildExtractionInput', () => {
  it('gives the extractor the meeting and nothing from another context', async () => {
    const { w, meeting } = await setup()
    await db.insert(users).values({
      email: 'john@example.test',
      displayName: 'John',
      passwordHash: 'x',
      timeZone: 'America/Chicago',
    })
    // Late evening in Chicago is already tomorrow in UTC.
    const evening = await createMeeting(db, actor, {
      contextId: w.parish.id,
      title: 'Evening',
      startsAt: new Date('2026-10-02T03:30:00Z'),
      personIds: [w.sarah.id],
    })

    const make = (contextId: string, text: string, over: Partial<Parameters<typeof createItem>[2]> = {}) =>
      createItem(db, actor, { contextId, kind: 'action', text, ...over })

    // The parish: what the meeting could be about.
    const withSarah = await make(w.parish.id, 'Sarah owes this', {
      parties: [
        { personId: w.sarah.id, role: 'owner' },
        { personId: w.bishop.id, role: 'with' },
      ],
      detail: 'A detail',
      dueOn: '2026-10-09',
    })
    await make(w.parish.id, 'On the retreat', { projectId: w.retreat.id })
    await make(w.parish.id, 'For the staff', { parties: [{ groupId: w.staff.id, role: 'owner' }] })
    const placed = await make(w.parish.id, 'Placed by hand')
    await placeItem(db, actor, meeting.id, placed.id)
    // The parish: what it is not about.
    await make(w.parish.id, 'Only John', { parties: [{ personId: w.john.id, role: 'owner' }] })
    await make(w.parish.id, 'On the campaign', { projectId: w.campaign.id })
    await make(w.parish.id, 'With the bishop', { parties: [{ personId: w.bishop.id, role: 'with' }] })
    const finished = await make(w.parish.id, 'Already done', { parties: [{ personId: w.sarah.id, role: 'owner' }] })
    await completeItem(db, actor, finished.id, { resolution: null })
    await make(w.parish.id, 'Quick-added here', { originMeetingId: meeting.id })

    // The diocese: the same people, another context.
    const leak1 = await make(w.diocese.id, 'Diocese secret with Sarah', {
      parties: [{ personId: w.sarah.id, role: 'owner' }],
      projectId: w.synod.id,
    })
    const leak2 = await make(w.diocese.id, 'Diocese secret for the council', {
      parties: [{ groupId: w.council.id, role: 'owner' }, { personId: w.tom.id, role: 'with' }],
    })
    const other = await createMeeting(db, actor, {
      contextId: w.diocese.id,
      title: 'Council session',
      personIds: [w.sarah.id, w.tom.id],
      projectIds: [w.synod.id],
    })
    const dioceseNote = await paste(other.id, 'D: Diocese decision in a note')
    await processRun(db, dioceseNote.run.id)

    const section = await addLine(db, actor, meeting.id, { text: 'Budget', privateNote: 'push back' })
    const earlier = await paste(meeting.id, 'D: An earlier decision')
    await processRun(db, earlier.run.id)
    const { note } = await paste(
      meeting.id,
      'D: Keep the Thursday slot @sarah\nSome prose about the diocese.',
    )

    const input = await buildExtractionInput(db, note.id)

    expect(input.meeting).toEqual({
      id: meeting.id,
      title: 'Staff',
      startsAt: '2026-10-01 10:00',
      people: expect.arrayContaining([
        { id: w.sarah.id, name: 'Sarah Jones' },
        { id: w.tom.id, name: 'Tom Baker' },
      ]),
      group: null,
      projects: [{ id: w.retreat.id, name: 'Retreat' }],
    })
    expect(input.meeting.people).toHaveLength(2)
    expect(input.self).toEqual({ id: w.john.id, name: 'John' })
    expect(input.today).toBe('2026-10-01')
    expect(input.note).toEqual({
      body: 'D: Keep the Thursday slot @sarah\nSome prose about the diocese.',
      summary: null,
      transcript: null,
    })
    expect(input.agenda).toEqual([
      { lineId: expect.any(String), section: null, text: 'Placed by hand', itemId: placed.id },
      { lineId: section, section: null, text: 'Budget', itemId: null },
    ])
    // Not the staff's item (the meeting has no group), nor one with no party and no project.
    expect(input.openItems.map((item) => item.text).sort()).toEqual([
      'On the retreat',
      'Placed by hand',
      'Sarah owes this',
    ])
    expect(input.openItems.find((item) => item.id === withSarah.id)).toEqual({
      id: withSarah.id,
      kind: 'action',
      text: 'Sarah owes this',
      detail: 'A detail',
      owners: ['Sarah Jones'],
      with: ['Bishop Wright'],
      project: null,
      dueOn: '2026-10-09',
    })
    expect(input.directory.groups).toEqual([{ id: w.staff.id, name: 'Staff' }])
    expect(input.directory.projects).toEqual([
      { id: w.campaign.id, name: 'Capital campaign' },
      { id: w.retreat.id, name: 'Retreat' },
    ])
    // People are global: the whole directory, John included.
    expect(input.directory.people.map((person) => person.name)).toEqual([
      'Bishop Wright',
      'John',
      'Sarah Jones',
      'Tom Baker',
    ])
    expect(input.verbatim).toEqual([{ kind: 'decision', text: 'Keep the Thursday slot @sarah' }])
    expect(input.captured).toEqual([{ kind: 'action', text: 'Quick-added here' }])
    expect(input.handled).toEqual(['An earlier decision'])

    // Nothing of the diocese, by id or by wording, anywhere in what is sent.
    const sent = JSON.stringify(input)
    for (const secret of [
      w.diocese.id,
      w.synod.id,
      'Synod',
      w.council.id,
      'Council',
      leak1.id,
      leak2.id,
      'Diocese secret',
      'Diocese decision',
      other.id,
      'push back',
    ]) {
      expect(sent).not.toContain(secret)
    }

    // The day is the user's, not UTC's.
    const late = await paste(evening.id, 'nothing')
    const lateInput = await buildExtractionInput(db, late.note.id)
    expect(lateInput.meeting.startsAt).toBe('2026-10-01 22:30')
    expect(lateInput.today).toBe('2026-10-01')
  })

  it('includes what the meeting’s group owes when the meeting has one', async () => {
    const w = await makeWorld()
    const meeting = await createMeeting(db, actor, { contextId: w.parish.id, groupId: w.staff.id })
    await createItem(db, actor, {
      contextId: w.parish.id,
      text: 'For the staff',
      parties: [{ groupId: w.staff.id, role: 'owner' }],
    })
    await createItem(db, actor, { contextId: w.parish.id, text: 'Nobody’s' })
    const { note } = await paste(meeting.id, 'notes')

    const input = await buildExtractionInput(db, note.id)
    expect(input.meeting.group).toEqual({ id: w.staff.id, name: 'Staff' })
    expect(input.openItems.map((item) => item.text)).toEqual(['For the staff'])
  })

  it('refuses a note that does not exist', async () => {
    await expect(buildExtractionInput(db, randomUUID())).rejects.toThrow(NotFoundError)
  })
})

describe('re-delivery', () => {
  const granola = (meetingId: string, body: string, summary = 'We met.') =>
    saveNote(db, actor, { meetingId, source: 'granola', externalId: 'g-1', body, summary })

  it('queues nothing for the same content, and a new run for changed content', async () => {
    const { meeting } = await setup()
    const first = await granola(meeting.id, 'D: one')
    const run = await queueRun(db, first.note.id)
    expect(run).toMatchObject({ status: 'queued', contentHash: first.note.contentHash })

    // Delivered again before it ran, and again after.
    expect(await queueRun(db, first.note.id)).toBeNull()
    await processRun(db, run!.id)
    const again = await granola(meeting.id, 'D: one')
    expect(again.changed).toBe(false)
    expect(await queueRun(db, again.note.id)).toBeNull()
    expect(await runsOf(first.note.id)).toHaveLength(1)

    const edited = await granola(meeting.id, 'D: one\nD: two')
    expect(edited.changed).toBe(true)
    const second = await queueRun(db, edited.note.id)
    expect(second).toMatchObject({ status: 'queued', contentHash: edited.note.contentHash })
    expect(second!.id).not.toBe(run!.id)
    expect(await runsOf(first.note.id)).toHaveLength(2)

    await expect(queueRun(db, randomUUID())).rejects.toThrow(NotFoundError)
  })

  it('proposes only what is new: a rejection does not come back, an acceptance is not repeated', async () => {
    const { w, meeting } = await setup()
    const drafts = [action('Email the caterer'), action('Book the bus')]
    const { extractor, seen } = fake(() => ({ drafts }))

    const first = await granola(meeting.id, 'D: Keep Thursday\nQ: who brings lunch')
    await processRun(db, (await queueRun(db, first.note.id))!.id, extractor)
    const [keep, lunch, caterer, bus] = await listProposals(db, meeting.id)
    expect(texts([keep!, lunch!, caterer!, bus!])).toEqual([
      'Keep Thursday',
      'who brings lunch',
      'Email the caterer',
      'Book the bus',
    ])

    await acceptProposal(db, actor, keep!.id)
    await rejectProposal(db, actor, lunch!.id)
    await acceptProposal(db, actor, caterer!.id)
    await rejectProposal(db, actor, bus!.id)

    // The note is edited: the same lines reworded in case and punctuation, one new; the model repeats itself and adds one.
    drafts.push(action('Order the cake'))
    const edited = await granola(
      meeting.id,
      'D: keep thursday!\nQ: Who brings lunch?\nA: print the programme',
    )
    const second = await queueRun(db, edited.note.id)
    expect((await processRun(db, second!.id, extractor)).status).toBe('done')

    const list = await listProposals(db, meeting.id)
    expect(list.map((p) => [p.status, (p.payload as ItemPayload).text])).toEqual([
      ['pending', 'print the programme'],
      ['pending', 'Order the cake'],
      ['accepted', 'Keep Thursday'],
      ['accepted', 'Email the caterer'],
      ['rejected', 'who brings lunch'],
      ['rejected', 'Book the bus'],
    ])
    expect((await listItems(db, { contextId: w.parish.id })).map((item) => item.text).sort()).toEqual([
      'Email the caterer',
      'Keep Thursday',
    ])

    // The second time, the model was told what was already captured and handled.
    expect(seen[1]!.captured.map((item) => item.text).sort()).toEqual(['Email the caterer', 'Keep Thursday'])
    expect(seen[1]!.handled).toEqual(
      expect.arrayContaining(['Keep Thursday', 'who brings lunch', 'Email the caterer', 'Book the bus']),
    )
  })

  it('reprocesses on request, whatever the hash, and keeps what was handled', async () => {
    const { w, meeting } = await setup()
    const a = await paste(meeting.id, 'D: one\nD: two')
    const b = await paste(meeting.id, 'D: three')
    await processRun(db, a.run.id)
    await processRun(db, b.run.id)
    const [one, two] = await listProposals(db, meeting.id)
    await acceptProposal(db, actor, one!.id)
    await rejectProposal(db, actor, two!.id)

    const { extractor } = fake(() => ({ drafts: [action('Something the model now sees')] }))
    const again = await reprocessMeeting(db, actor, meeting.id)
    expect(again.map((run) => [run.id, run.status, run.error, run.finishedAt])).toEqual([
      [a.run.id, 'queued', null, null],
      [b.run.id, 'queued', null, null],
    ])
    // Asked twice: what is already waiting is left alone.
    expect(await reprocessMeeting(db, actor, meeting.id)).toEqual([])

    expect(await processQueued(db, extractor)).toEqual({ processed: 2, failed: 0 })
    const list = await listProposals(db, meeting.id)
    expect(list.map((p) => [p.status, (p.payload as ItemPayload).text])).toEqual([
      ['pending', 'three'],
      ['pending', 'Something the model now sees'],
      ['accepted', 'one'],
      ['rejected', 'two'],
    ])
    expect(await listItems(db, { contextId: w.parish.id })).toHaveLength(1)
    expect((await runsOf(a.note.id))[0]).toMatchObject({ attempts: 2, model: 'fake-model-1' })

    await expect(reprocessMeeting(db, actor, randomUUID())).rejects.toThrow(NotFoundError)
  })

  it('queues a run for a note that changed since its last one when reprocessing', async () => {
    const { meeting } = await setup()
    const first = await granola(meeting.id, 'D: one')
    await processRun(db, (await queueRun(db, first.note.id))!.id)
    const edited = await granola(meeting.id, 'D: one\nD: two')

    const [run] = await reprocessMeeting(db, actor, meeting.id)
    expect(run).toMatchObject({ status: 'queued', contentHash: edited.note.contentHash, attempts: 0 })
    await processRun(db, run!.id)
    expect(texts(await listProposals(db, meeting.id))).toEqual(['one', 'two'])
  })

  it('does not process a version of the note that has since been replaced', async () => {
    const { meeting } = await setup()
    const first = await granola(meeting.id, 'D: one')
    const stale = await queueRun(db, first.note.id)
    const edited = await granola(meeting.id, 'D: two')
    const fresh = await queueRun(db, edited.note.id)

    const { extractor, seen } = fake()
    const skipped = await processRun(db, stale!.id, extractor)
    expect(skipped.status).toBe('done')
    expect(skipped.error).toMatch(/changed/)
    expect(seen).toEqual([])
    expect(await listProposals(db, meeting.id)).toEqual([])

    await processRun(db, fresh!.id, extractor)
    expect(texts(await listProposals(db, meeting.id))).toEqual(['two'])
  })
})

describe('two notes on one meeting', () => {
  it('proposes from both, once each by fingerprint', async () => {
    const { meeting } = await setup()
    const a = await paste(meeting.id, 'D: Keep the Thursday slot\nA: book the hall @tom')
    const b = await paste(meeting.id, 'D: keep the thursday slot.\nQ: who brings lunch')
    const { extractor } = fake((input) => ({
      drafts: [action('Email the caterer'), action(`From ${input.note.body.length}`)],
    }))

    expect(await processQueued(db, extractor)).toEqual({ processed: 2, failed: 0 })

    const list = await listProposals(db, meeting.id)
    expect(list.map((p) => [(p.payload as ItemPayload).text, p.noteId])).toEqual([
      ['Keep the Thursday slot', a.note.id],
      ['book the hall', a.note.id],
      ['Email the caterer', a.note.id],
      [`From ${a.note.body.length}`, a.note.id],
      ['who brings lunch', b.note.id],
      [`From ${b.note.body.length}`, b.note.id],
    ])
    expect(new Set(list.map((p) => p.position)).size).toBe(list.length)

    const rows = await db.select().from(proposals).where(eq(proposals.meetingId, meeting.id))
    expect(new Set(rows.map((row) => row.fingerprint)).size).toBe(rows.length)
  })
})

describe('when the extractor fails', () => {
  it('marks the run failed without throwing, keeps the verbatim lines, and succeeds on a retry', async () => {
    const { meeting } = await setup()
    const { note, run } = await paste(meeting.id, 'D: Keep the Thursday slot')
    const broken: RunExtractor = {
      model: 'fake-model-1',
      extractor: async () => {
        throw new Error('529 overloaded')
      },
    }

    const failed = await processRun(db, run.id, broken)
    expect(failed).toMatchObject({
      status: 'failed',
      error: '529 overloaded',
      model: 'fake-model-1',
      attempts: 1,
      output: null,
    })
    expect(failed.finishedAt).toBeInstanceOf(Date)
    expect(texts(await listProposals(db, meeting.id))).toEqual(['Keep the Thursday slot'])
    expect(await latestRun(db, meeting.id)).toMatchObject({ id: run.id, status: 'failed' })

    // A failed run is not picked up by itself, and the same content queues nothing.
    expect(await processQueued(db, broken)).toEqual({ processed: 0, failed: 0 })
    expect(await queueRun(db, note.id)).toBeNull()

    const { extractor } = fake(() => ({
      drafts: [action('Email the caterer')],
      verbatimDetails: [{ index: 0, detail: 'Everyone agreed.' }],
    }))
    const [retry] = await reprocessMeeting(db, actor, meeting.id)
    expect(retry).toMatchObject({ id: run.id, status: 'queued', error: null })
    const done = await processRun(db, retry!.id, extractor)
    expect(done).toMatchObject({ status: 'done', error: null, model: 'fake-model-1', attempts: 2 })

    const list = await listProposals(db, meeting.id)
    expect(texts(list)).toEqual(['Keep the Thursday slot', 'Email the caterer'])
    expect((list[0]!.payload as ItemPayload).detail).toBe('Everyone agreed.')
  })

  it('counts a failure in processQueued and carries on with the rest', async () => {
    const { meeting } = await setup()
    await paste(meeting.id, 'D: first')
    await paste(meeting.id, 'boom')
    await paste(meeting.id, 'D: third')
    const { extractor } = fake((input) => {
      if (input.note.body === 'boom') throw new Error('no')
      return {}
    })
    expect(await processQueued(db, extractor)).toEqual({ processed: 2, failed: 1 })
    expect(texts(await listProposals(db, meeting.id))).toEqual(['first', 'third'])
  })
})

describe('processQueued', () => {
  it('processes every queued run, oldest first', async () => {
    const { w, meeting } = await setup()
    const other = await createMeeting(db, actor, { contextId: w.diocese.id, title: 'Council' })
    const c = await paste(meeting.id, 'third')
    const a = await paste(other.id, 'first')
    const b = await paste(meeting.id, 'second')
    const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1, 12, minutes))
    for (const [run, minutes] of [[a.run, 1], [b.run, 2], [c.run, 3]] as const) {
      await db.update(processingRuns).set({ createdAt: at(minutes) }).where(eq(processingRuns.id, run.id))
    }

    const { extractor, seen } = fake()
    expect(await processQueued(db, extractor)).toEqual({ processed: 3, failed: 0 })
    expect(seen.map((input) => input.note.body)).toEqual(['first', 'second', 'third'])

    expect(await processQueued(db, extractor)).toEqual({ processed: 0, failed: 0 })
    expect(seen).toHaveLength(3)
  })

  it('puts a run abandoned while running back in the queue, and leaves a fresh one alone', async () => {
    const { meeting } = await setup()
    const dead = await paste(meeting.id, 'D: from the dead run')
    const live = await paste(meeting.id, 'D: from the live run')
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000)
    await db
      .update(processingRuns)
      .set({ status: 'running', attempts: 1, startedAt: ago(20) })
      .where(eq(processingRuns.id, dead.run.id))
    await db
      .update(processingRuns)
      .set({ status: 'running', attempts: 1, startedAt: ago(2) })
      .where(eq(processingRuns.id, live.run.id))

    expect(await processQueued(db)).toEqual({ processed: 1, failed: 0 })
    expect((await runsOf(dead.note.id))[0]).toMatchObject({ status: 'done', attempts: 2 })
    expect((await runsOf(live.note.id))[0]).toMatchObject({ status: 'running', attempts: 1 })
    expect(texts(await listProposals(db, meeting.id))).toEqual(['from the dead run'])
  })
})

describe('processRun', () => {
  it('returns a run that is not queued as it is, without running it again', async () => {
    const { meeting } = await setup()
    const { run } = await paste(meeting.id, 'D: one')
    const { extractor, seen } = fake()
    const done = await processRun(db, run.id, extractor)
    const again = await processRun(db, run.id, extractor)
    expect(again).toEqual(done)
    expect(seen).toHaveLength(1)
    await expect(processRun(db, randomUUID())).rejects.toThrow(NotFoundError)
  })

  it('lets only one of two workers take a run', async () => {
    const { meeting } = await setup()
    const { run } = await paste(meeting.id, 'D: one')
    const { extractor, seen } = fake()
    await Promise.all([processRun(db, run.id, extractor), processRun(db, run.id, extractor)])
    expect(seen).toHaveLength(1)
    expect((await runsOf(run.noteId))[0]).toMatchObject({ status: 'done', attempts: 1 })
    expect(await listProposals(db, meeting.id)).toHaveLength(1)
  })
})

describe('latestRun', () => {
  it('is the run waiting or under way, else the last to finish', async () => {
    const { w, meeting } = await setup()
    expect(await latestRun(db, meeting.id)).toBeNull()

    const a = await paste(meeting.id, 'D: one')
    expect(await latestRun(db, meeting.id)).toMatchObject({ id: a.run.id, status: 'queued' })
    await processRun(db, a.run.id)
    expect(await latestRun(db, meeting.id)).toMatchObject({ id: a.run.id, status: 'done' })

    const b = await paste(meeting.id, 'D: two')
    expect(await latestRun(db, meeting.id)).toMatchObject({ id: b.run.id, status: 'queued' })
    await processRun(db, b.run.id)
    expect(await latestRun(db, meeting.id)).toMatchObject({ id: b.run.id, status: 'done' })

    // The first is run again and finishes last.
    await reprocessMeeting(db, actor, meeting.id)
    await processRun(db, b.run.id)
    expect(await latestRun(db, meeting.id)).toMatchObject({ id: a.run.id, status: 'queued' })
    await processRun(db, a.run.id)
    expect(await latestRun(db, meeting.id)).toMatchObject({ id: a.run.id, status: 'done' })

    // Another meeting's runs are not this one's.
    const other = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Other' })
    await paste(other.id, 'D: elsewhere')
    expect(await latestRun(db, meeting.id)).toMatchObject({ id: a.run.id })
  })
})
