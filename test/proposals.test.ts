/*
 * Proposals: nothing real until accepted, everything accepted can be taken
 * back while it is untouched, and a payload never writes across contexts.
 */

import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { getAgenda } from '../lib/agenda/lines'
import { placeItem } from '../lib/agenda/candidates'
import { ValidationError } from '../lib/core/types'
import { items, meetings, proposals, type ProposalPayload } from '../lib/db/schema'
import { getDocument, listDocuments, updateDocument } from '../lib/documents/documents'
import {
  answerItem,
  completeItem,
  createItem,
  getItem,
  getThread,
  listItems,
  updateItem,
} from '../lib/items/items'
import { createMeeting, getMeeting, listMeetings, updateMeeting } from '../lib/meetings/meetings'
import { createSeries } from '../lib/meetings/series'
import { missingDetails } from '../lib/processing/missing'
import {
  acceptEdited,
  acceptProposal,
  acceptedSteps,
  addProposals,
  approveAll,
  cleanPayload,
  editProposal,
  fingerprintOf,
  getProposal,
  listProposals,
  pendingByMeeting,
  pendingOnCards,
  rejectProposal,
  undoProposal,
  unresolvedIn,
  type ProposalDraft,
} from '../lib/processing/proposals'
import { db, resetBetweenTests } from './helpers/db'
import { actor, makeWorld } from './helpers/fixtures'

resetBetweenTests()

type ItemPayload = Extract<ProposalPayload, { type: 'item' }>

const item = (text: string, over: Partial<ItemPayload> = {}): ItemPayload => ({
  type: 'item',
  kind: 'action',
  text,
  parties: [],
  ...over,
})

async function setup() {
  const w = await makeWorld()
  const meeting = await createMeeting(db, actor, {
    contextId: w.parish.id,
    title: 'Staff',
    startsAt: new Date('2026-10-01T15:00:00Z'),
    personIds: [w.sarah.id, w.tom.id],
  })
  return { w, meeting }
}

/* Add drafts and hand back their views in the order given. */
async function propose(meetingId: string, drafts: ProposalDraft[]) {
  const before = new Set((await listProposals(db, meetingId)).map((p) => p.id))
  await addProposals(db, { meetingId }, drafts)
  return (await listProposals(db, meetingId))
    .filter((p) => !before.has(p.id))
    .sort((a, b) => a.position - b.position)
}

async function itemCount(contextId: string) {
  return (await listItems(db, { contextId })).length
}

describe('fingerprintOf', () => {
  it('ignores case, spacing and punctuation, but not the kind', () => {
    const a = fingerprintOf(item('Book the hall.'))
    expect(fingerprintOf(item('  book  THE hall'))).toBe(a)
    expect(fingerprintOf(item('Book the hall', { detail: 'by Friday', dueOn: '2026-10-09' }))).toBe(a)
    expect(fingerprintOf(item('Book the hall', { kind: 'question' }))).not.toBe(a)
    expect(fingerprintOf(item('Book the other hall'))).not.toBe(a)
  })

  it('knows an update by its item and change, and two notes on one item apart', () => {
    const id = '11111111-1111-4111-8111-111111111111'
    const complete = fingerprintOf({ type: 'update', itemId: id, change: 'complete', text: 'done' })
    expect(fingerprintOf({ type: 'update', itemId: id, change: 'complete', text: 'finished!' })).toBe(
      complete,
    )
    expect(fingerprintOf({ type: 'update', itemId: id, change: 'drop' })).not.toBe(complete)
    expect(fingerprintOf({ type: 'update', itemId: id, change: 'note', text: 'one' })).not.toBe(
      fingerprintOf({ type: 'update', itemId: id, change: 'note', text: 'two' }),
    )
  })

  it('knows a stub by who it is with, whatever the title', () => {
    const a = fingerprintOf({ type: 'stub', title: 'Catch up', people: [{ name: 'Sarah', personId: 'p1' }] })
    const b = fingerprintOf({ type: 'stub', title: 'Follow-up chat', people: [{ name: 'S.', personId: 'p1' }] })
    expect(a).toBe(b)
  })
})

describe('addProposals', () => {
  it('stores what is new by fingerprint and reports how many', async () => {
    const { meeting } = await setup()
    expect(
      await addProposals(db, { meetingId: meeting.id }, [
        { payload: item('Book the hall') },
        { payload: item('book the hall!') },
        { payload: item('Order chairs'), ownerGuessed: true },
      ]),
    ).toBe(2)
    expect(await addProposals(db, { meetingId: meeting.id }, [{ payload: item('BOOK THE HALL') }])).toBe(0)

    const list = await listProposals(db, meeting.id)
    expect(list.map((p) => [p.position, (p.payload as ItemPayload).text, p.ownerGuessed])).toEqual([
      [0, 'Book the hall', false],
      [1, 'Order chairs', true],
    ])
  })

  it('writes nothing to items, documents or meetings', async () => {
    const { w, meeting } = await setup()
    const open = await createItem(db, actor, { contextId: w.parish.id, kind: 'action', text: 'Existing' })
    await propose(meeting.id, [
      { payload: item('New action') },
      { payload: { type: 'update', itemId: open.id, change: 'complete' } },
      { payload: { type: 'document', title: 'Draft', body: 'text' } },
      { payload: { type: 'stub', title: 'Follow up', people: [{ name: 'Sarah', personId: w.sarah.id }] } },
    ])

    expect(await itemCount(w.parish.id)).toBe(1)
    expect((await getItem(db, open.id)).status).toBe('open')
    expect(await listDocuments(db, { contextId: w.parish.id })).toEqual([])
    expect(await listMeetings(db, { contextId: w.parish.id })).toHaveLength(1)
  })

  it('looks a party given by name only up in the directory', async () => {
    const { w, meeting } = await setup()
    const [resolved, unknown] = await propose(meeting.id, [
      { payload: item('Send it', { parties: [{ role: 'owner', name: 'sarah' }] }) },
      { payload: item('Call them', { parties: [{ role: 'owner', name: 'Priya' }] }) },
    ])
    expect(resolved!.parties).toEqual([
      { role: 'owner', name: 'Sarah Jones', type: 'person', id: w.sarah.id, unresolved: false },
    ])
    expect(unknown!.parties).toEqual([
      { role: 'owner', name: 'Priya', type: null, id: null, unresolved: true },
    ])
    expect(unknown!.unresolved).toEqual(['Priya'])
  })
})

describe('listProposals', () => {
  it('gives the review screen names, the project, the agenda line and the item an update changes', async () => {
    const { w, meeting } = await setup()
    const open = await createItem(db, actor, {
      contextId: w.parish.id,
      kind: 'action',
      text: 'Book the hall',
      parties: [{ personId: w.tom.id, role: 'owner' }],
    })
    await placeItem(db, actor, meeting.id, open.id)
    const agenda = await getAgenda(db, meeting.id)
    const lineId = agenda.nodes[0]!.id

    const [made, update] = await propose(meeting.id, [
      {
        payload: item('Print the programme', {
          parties: [
            { role: 'owner', name: 'Sarah', personId: w.sarah.id },
            { role: 'with', name: 'the staff', groupId: w.staff.id },
          ],
          projectId: w.retreat.id,
          parentItemId: open.id,
        }),
        agendaLineId: lineId,
      },
      { payload: { type: 'update', itemId: open.id, change: 'complete', text: 'Booked for May' } },
    ])

    expect(made).toMatchObject({
      status: 'pending',
      verbatim: false,
      ownerGuessed: false,
      parties: [
        { role: 'owner', name: 'Sarah Jones', type: 'person', id: w.sarah.id, unresolved: false },
        { role: 'with', name: 'Staff', type: 'group', id: w.staff.id, unresolved: false },
      ],
      unresolved: [],
      project: { id: w.retreat.id, name: 'Retreat' },
      agendaLine: { id: lineId, text: 'Book the hall' },
      made: null,
    })
    expect(made!.parent?.id).toBe(open.id)
    expect(update!.item).toMatchObject({ id: open.id, text: 'Book the hall', status: 'open' })
    expect(update!.item!.parties[0]!.name).toBe('Tom Baker')
  })

  it('lists pending first, then accepted, then rejected', async () => {
    const { meeting } = await setup()
    const [a, b, c, d] = await propose(meeting.id, [
      { payload: item('a') },
      { payload: item('b') },
      { payload: item('c') },
      { payload: item('d') },
    ])
    await rejectProposal(db, actor, a!.id)
    await acceptProposal(db, actor, b!.id)

    const list = await listProposals(db, meeting.id)
    expect(list.map((p) => p.id)).toEqual([c!.id, d!.id, b!.id, a!.id])
    expect(list.map((p) => p.status)).toEqual(['pending', 'pending', 'accepted', 'rejected'])
  })

  it('counts pending proposals per meeting of one context only', async () => {
    const { w, meeting } = await setup()
    const quiet = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Quiet' })
    const elsewhere = await createMeeting(db, actor, { contextId: w.diocese.id, title: 'Council' })
    const [first] = await propose(meeting.id, [{ payload: item('a') }, { payload: item('b') }, { payload: item('c') }])
    await rejectProposal(db, actor, first!.id)
    await propose(elsewhere.id, [{ payload: item('x') }])

    const parish = await pendingByMeeting(db, w.parish.id)
    expect([...parish]).toEqual([[meeting.id, 2]])
    expect(parish.has(quiet.id)).toBe(false)
    expect([...(await pendingByMeeting(db, w.diocese.id))]).toEqual([[elsewhere.id, 1]])
  })

  it("counts a session's waiting proposals on its meeting's card too", async () => {
    const { w } = await setup()
    const retreat = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Retreat' })
    const dayOne = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Day one', parentMeetingId: retreat.id })
    const dayTwo = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Day two', parentMeetingId: retreat.id })
    await propose(dayOne.id, [{ payload: item('a') }, { payload: item('b') }])
    await propose(dayTwo.id, [{ payload: item('c') }])

    const cards = await pendingOnCards(db, w.parish.id)
    expect(cards.get(retreat.id)).toBe(3)
    expect(cards.get(dayOne.id)).toBe(2)
    // The review list still names each session alone.
    expect((await pendingByMeeting(db, w.parish.id)).has(retreat.id)).toBe(false)
  })
})

describe('accepting', () => {
  it('makes an item with its parties, project and deadline, originating in the meeting', async () => {
    const { w, meeting } = await setup()
    const [proposal] = await propose(meeting.id, [
      {
        payload: item('Print the programme', {
          detail: 'Two hundred copies',
          parties: [{ role: 'owner', name: 'Sarah', personId: w.sarah.id }],
          projectId: w.retreat.id,
          dueOn: '2026-10-09',
        }),
      },
    ])

    const accepted = await acceptProposal(db, actor, proposal!.id)
    expect(accepted.status).toBe('accepted')
    expect(accepted.resolvedAt).toBeInstanceOf(Date)

    const made = await getItem(db, accepted.result!.itemId!)
    expect(made).toMatchObject({
      contextId: w.parish.id,
      kind: 'action',
      status: 'open',
      text: 'Print the programme',
      detail: 'Two hundred copies',
      dueOn: '2026-10-09',
      originMeetingId: meeting.id,
      project: { id: w.retreat.id },
    })
    expect(made.parties).toMatchObject([{ id: w.sarah.id, role: 'owner' }])
    expect(accepted.made?.item?.id).toBe(made.id)

    // Accepting twice makes nothing more.
    await acceptProposal(db, actor, proposal!.id)
    expect(await itemCount(w.parish.id)).toBe(1)
  })

  it('creates a question that was answered in the meeting and answers it', async () => {
    const { w, meeting } = await setup()
    const [proposal] = await propose(meeting.id, [
      { payload: item('Which hall?', { kind: 'question', resolution: 'St Mark’s' }) },
    ])
    const accepted = await acceptProposal(db, actor, proposal!.id)
    const made = await getItem(db, accepted.result!.itemId!)
    expect(made).toMatchObject({ kind: 'question', status: 'done', resolution: 'St Mark’s' })
    expect(made.closedAt).not.toBeNull()
    expect(await itemCount(w.parish.id)).toBe(1)
  })

  it('creates a decision as decided, and closes a topic that ended with how it ended', async () => {
    const { meeting } = await setup()
    const [decision, topic] = await propose(meeting.id, [
      { payload: item('Move the retreat to May', { kind: 'decision' }) },
      { payload: item('Parking', { kind: 'topic', resolution: 'Nothing to do this year' }) },
    ])
    const d = await getItem(db, (await acceptProposal(db, actor, decision!.id)).result!.itemId!)
    expect(d).toMatchObject({ kind: 'decision', status: 'decided', originMeetingId: meeting.id })
    const t = await getItem(db, (await acceptProposal(db, actor, topic!.id)).result!.itemId!)
    expect(t).toMatchObject({ kind: 'topic', status: 'done', resolution: 'Nothing to do this year' })
  })

  it('accepts the lunch-menu draft as one question owned by three', async () => {
    const { w, meeting } = await setup()
    const [proposal] = await propose(meeting.id, [
      {
        payload: item('Decide the lunch menu', {
          kind: 'question',
          parties: [
            { role: 'owner', name: 'Sarah', personId: w.sarah.id },
            { role: 'owner', name: 'Tom', personId: w.tom.id },
            { role: 'owner', name: 'the bishop', personId: w.bishop.id },
          ],
          projectId: w.retreat.id,
        }),
      },
    ])
    await acceptProposal(db, actor, proposal!.id)

    const all = await listItems(db, { contextId: w.parish.id })
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ kind: 'question', status: 'open', text: 'Decide the lunch menu' })
    expect(all[0]!.parties.map((p) => [p.id, p.role])).toEqual([
      [w.sarah.id, 'owner'],
      [w.tom.id, 'owner'],
      [w.bishop.id, 'owner'],
    ])
    for (const person of [w.sarah, w.tom, w.bishop]) {
      const owed = await listItems(db, {
        contextId: w.parish.id,
        open: true,
        party: { personId: person.id, role: 'owner' },
      })
      expect(owed.map((i) => i.id)).toEqual([all[0]!.id])
    }
  })

  it('applies each kind of update through the item lifecycle and records what was there before', async () => {
    const { w, meeting } = await setup()
    const make = (kind: 'action' | 'question' | 'topic', text: string) =>
      createItem(db, actor, { contextId: w.parish.id, kind, text })
    const action = await make('action', 'Book the hall')
    const question = await make('question', 'Which caterer?')
    const dropped = await make('action', 'Rent a marquee')
    const topic = await make('topic', 'Parking')

    const list = await propose(meeting.id, [
      { payload: { type: 'update', itemId: action.id, change: 'complete', text: 'Booked' } },
      { payload: { type: 'update', itemId: question.id, change: 'answer', text: 'Baker & Sons' } },
      { payload: { type: 'update', itemId: dropped.id, change: 'drop' } },
      { payload: { type: 'update', itemId: topic.id, change: 'note', text: 'Ask the council' } },
      { payload: { type: 'update', itemId: topic.id, change: 'discussed' } },
    ])
    const results = []
    for (const p of list) results.push(await acceptProposal(db, actor, p.id))

    expect(await getItem(db, action.id)).toMatchObject({ status: 'done', resolution: 'Booked' })
    expect(await getItem(db, question.id)).toMatchObject({ status: 'done', resolution: 'Baker & Sons' })
    expect(await getItem(db, dropped.id)).toMatchObject({ status: 'dropped' })
    expect(await getItem(db, topic.id)).toMatchObject({ status: 'open' })

    const { events } = await getThread(db, topic.id)
    expect(events.map((e) => e.type)).toEqual(['created', 'note', 'discussed'])
    expect(events[2]!.data).toEqual({ meetingId: meeting.id })

    expect(results[0]!.result).toMatchObject({
      itemId: action.id,
      before: { status: 'open', resolution: null, closedAt: null },
    })
    expect(results[0]!.result!.eventId).toBeTruthy()
    // An update makes nothing new.
    expect(await itemCount(w.parish.id)).toBe(4)
    expect(results[0]!.item).toMatchObject({ id: action.id, status: 'done' })
  })

  it('says which of an item’s steps came from which meeting’s review', async () => {
    const { meeting } = await setup()
    const [made] = await propose(meeting.id, [{ payload: item('Book the hall') }])
    const { result } = await acceptProposal(db, actor, made!.id)
    const itemId = result!.itemId!

    const [done] = await propose(meeting.id, [{ payload: { type: 'update', itemId, change: 'complete', text: 'Booked' } }])
    const update = await acceptProposal(db, actor, done!.id)

    const steps = await acceptedSteps(db, itemId)
    expect(steps.created).toEqual({ meetingId: meeting.id, title: 'Staff' })
    expect([...steps.events]).toEqual([[update.result!.eventId, { meetingId: meeting.id, title: 'Staff' }]])

    const byHand = await createItem(db, actor, { contextId: meeting.contextId, kind: 'action', text: 'By hand' })
    expect(await acceptedSteps(db, byHand.id)).toEqual({ created: null, events: new Map() })
  })

  it('closes by what the item is, not by the word the model chose', async () => {
    const { w, meeting } = await setup()
    const question = await createItem(db, actor, { contextId: w.parish.id, kind: 'question', text: 'Which day?' })
    const action = await createItem(db, actor, { contextId: w.parish.id, kind: 'action', text: 'Send invites' })
    const [q, a] = await propose(meeting.id, [
      { payload: { type: 'update', itemId: question.id, change: 'complete', text: 'Saturday' } },
      { payload: { type: 'update', itemId: action.id, change: 'answer', text: 'Sent Monday' } },
    ])
    await acceptProposal(db, actor, q!.id)
    await acceptProposal(db, actor, a!.id)
    expect(await getItem(db, question.id)).toMatchObject({ status: 'done', resolution: 'Saturday' })
    expect(await getItem(db, action.id)).toMatchObject({ status: 'done', resolution: 'Sent Monday' })
  })

  it('saves a document on its project and creates a stub with its people', async () => {
    const { w, meeting } = await setup()
    const [doc, stub] = await propose(meeting.id, [
      { payload: { type: 'document', title: 'Retreat agenda', body: '# Day one', projectId: w.retreat.id } },
      {
        payload: {
          type: 'stub',
          title: 'Budget follow-up',
          people: [
            { name: 'Sarah', personId: w.sarah.id },
            { name: 'Bishop', personId: w.bishop.id },
          ],
        },
      },
    ])

    const acceptedDoc = await acceptProposal(db, actor, doc!.id)
    const document = await getDocument(db, acceptedDoc.result!.documentId!)
    expect(document).toMatchObject({
      contextId: w.parish.id,
      projectId: w.retreat.id,
      meetingId: meeting.id,
      title: 'Retreat agenda',
      body: '# Day one',
    })
    expect(acceptedDoc.made?.document).toEqual({ id: document.id, title: 'Retreat agenda' })

    const acceptedStub = await acceptProposal(db, actor, stub!.id)
    const made = await getMeeting(db, acceptedStub.result!.meetingId!)
    expect(made).toMatchObject({ contextId: w.parish.id, title: 'Budget follow-up', startsAt: null })
    expect(made.people.map((p) => p.id).sort()).toEqual([w.sarah.id, w.bishop.id].sort())
    expect(acceptedStub.made?.meeting).toEqual({ id: made.id, title: 'Budget follow-up' })
  })

  it('refuses a proposal with a party still to be named, and says who', async () => {
    const { w, meeting } = await setup()
    const [proposal, stub] = await propose(meeting.id, [
      { payload: item('Call the caterer', { parties: [{ role: 'owner', name: 'Priya' }] }) },
      { payload: { type: 'stub', title: 'Chat', people: [{ name: 'Priya' }] } },
    ])
    await expect(acceptProposal(db, actor, proposal!.id)).rejects.toThrow(
      'Say who Priya is before accepting this.',
    )
    await expect(acceptProposal(db, actor, stub!.id)).rejects.toThrow(ValidationError)
    expect(await itemCount(w.parish.id)).toBe(0)
    expect((await getProposal(db, proposal!.id)).status).toBe('pending')

    // Once edited to name someone, it goes through.
    await editProposal(db, actor, proposal!.id, item('Call the caterer', {
      parties: [{ role: 'owner', name: 'Tom', personId: w.tom.id }],
    }))
    const accepted = await acceptProposal(db, actor, proposal!.id)
    expect(accepted.made?.item?.parties.map((p) => p.id)).toEqual([w.tom.id])
  })

  it('refuses a rejected proposal until it is put back', async () => {
    const { w, meeting } = await setup()
    const [proposal] = await propose(meeting.id, [{ payload: item('Book the hall') }])
    await rejectProposal(db, actor, proposal!.id)
    await expect(acceptProposal(db, actor, proposal!.id)).rejects.toThrow(ValidationError)
    expect(await itemCount(w.parish.id)).toBe(0)
  })
})

describe('accepting with what was missing', () => {
  it('asks for an owner and a due date on an action, a project wherever one could go', () => {
    expect(missingDetails(item('Book the hall'), true)).toEqual(['owner', 'project', 'due'])
    expect(missingDetails(item('Book the hall'), false)).toEqual(['owner', 'due'])
    expect(
      missingDetails(
        item('Book the hall', {
          parties: [{ role: 'owner', name: 'Tom' }],
          projectId: '11111111-1111-4111-8111-111111111111',
          dueOn: '2026-10-20',
        }),
        true,
      ),
    ).toEqual([])
    // Who it is with is not who owns it.
    expect(missingDetails(item('Lunch menu?', { kind: 'question', parties: [{ role: 'with', name: 'Tom' }] }), false)).toEqual(['owner'])
    expect(missingDetails(item('Budget', { kind: 'topic' }), true)).toEqual(['project'])
    expect(missingDetails(item('Budget', { kind: 'decision' }), false)).toEqual([])
    expect(missingDetails({ type: 'document', title: 'Agenda', body: '# x' }, true)).toEqual(['project'])
    expect(missingDetails({ type: 'stub', title: 'Catch up', people: [] }, true)).toEqual([])
  })

  it('edits and accepts in one step', async () => {
    const { w, meeting } = await setup()
    const [proposal] = await propose(meeting.id, [{ payload: item('Book the hall') }])
    const accepted = await acceptEdited(db, actor, proposal!.id, item('Book the hall', {
      parties: [{ role: 'owner', name: 'Tom', personId: w.tom.id }],
      dueOn: '2026-10-20',
    }))
    expect(accepted.status).toBe('accepted')
    expect(accepted.made?.item).toMatchObject({ text: 'Book the hall', dueOn: '2026-10-20' })
    expect(accepted.made?.item?.parties.map((p) => p.id)).toEqual([w.tom.id])
  })

  it('confirms a guessed owner on accept, and does not bring the guess back on undo', async () => {
    const { w, meeting } = await setup()
    const [proposal] = await propose(meeting.id, [
      { payload: item('A guess', { parties: [{ role: 'owner', name: 'Sarah', personId: w.sarah.id }] }), ownerGuessed: true },
    ])
    expect(proposal!.ownerGuessed).toBe(true)

    expect((await acceptProposal(db, actor, proposal!.id)).ownerGuessed).toBe(false)
    expect((await undoProposal(db, actor, proposal!.id)).ownerGuessed).toBe(false)

    // Rejecting keeps it: put back, the owner is still to be confirmed.
    await db.update(proposals).set({ ownerGuessed: true }).where(eq(proposals.id, proposal!.id))
    expect((await rejectProposal(db, actor, proposal!.id)).ownerGuessed).toBe(true)
  })

  it('holds no accepted proposal that is still a guess', async () => {
    const { w, meeting } = await setup()
    const [proposal] = await propose(meeting.id, [
      { payload: item('A guess', { parties: [{ role: 'owner', name: 'Sarah', personId: w.sarah.id }] }) },
    ])
    await acceptProposal(db, actor, proposal!.id)
    await expect(
      db.update(proposals).set({ ownerGuessed: true }).where(eq(proposals.id, proposal!.id)),
    ).rejects.toThrow()
  })

  it('raises the item it makes at the series it was edited to name, and refuses another context’s', async () => {
    const { w, meeting } = await setup()
    const weekly = await createSeries(db, { contextId: w.parish.id, name: 'Staff weekly' })
    const theirs = await createSeries(db, { contextId: w.diocese.id, name: 'Clergy' })
    const [proposal] = await propose(meeting.id, [{ payload: item('Book the hall') }])

    await expect(
      acceptEdited(db, actor, proposal!.id, item('Book the hall', { seriesId: theirs.id })),
    ).rejects.toThrow('That series is not in this context.')

    const accepted = await acceptEdited(db, actor, proposal!.id, item('Book the hall', { seriesId: weekly.id }))
    expect(accepted.series).toEqual({ id: weekly.id, name: 'Staff weekly' })
    expect(accepted.made?.item?.targetSeriesId).toBe(weekly.id)

    await undoProposal(db, actor, proposal!.id)
    expect(await itemCount(w.parish.id)).toBe(0)
  })

  it('keeps neither the edit nor the accept when accepting is refused', async () => {
    const { w, meeting } = await setup()
    const [proposal] = await propose(meeting.id, [{ payload: item('Book the hall') }])
    await expect(
      acceptEdited(db, actor, proposal!.id, item('Book the hall', {
        parties: [{ role: 'owner', name: 'Priya' }],
        dueOn: '2026-10-20',
      })),
    ).rejects.toThrow('Say who Priya is before accepting this.')
    const after = await getProposal(db, proposal!.id)
    expect(after.status).toBe('pending')
    expect(after.payload).toMatchObject({ parties: [] })
    expect((after.payload as ItemPayload).dueOn ?? null).toBeNull()
    expect(await itemCount(w.parish.id)).toBe(0)
  })
})

describe('editing', () => {
  it('replaces the payload while pending and keeps the fingerprint and the verbatim flag', async () => {
    const { w, meeting } = await setup()
    await addProposals(db, { meetingId: meeting.id }, [
      { payload: item('Book teh hall', { kind: 'decision' }), verbatim: true, ownerGuessed: true },
    ])
    const [proposal] = await listProposals(db, meeting.id)
    const [before] = await db.select().from(proposals).where(eq(proposals.id, proposal!.id))

    const edited = await editProposal(db, actor, proposal!.id, item('Book the hall', {
      kind: 'action',
      parties: [{ role: 'owner', name: 'Tom', personId: w.tom.id }],
      dueOn: '2026-10-20',
    }))
    expect(edited.payload).toMatchObject({ kind: 'action', text: 'Book the hall', dueOn: '2026-10-20' })
    expect(edited.verbatim).toBe(true)
    // John has now said who owns it.
    expect(edited.ownerGuessed).toBe(false)

    const [after] = await db.select().from(proposals).where(eq(proposals.id, proposal!.id))
    expect(after!.fingerprint).toBe(before!.fingerprint)

    // The original wording still counts as proposed.
    expect(await addProposals(db, { meetingId: meeting.id }, [{ payload: item('Book teh hall', { kind: 'decision' }) }])).toBe(0)
  })

  it('still dedupes against the original after reject, undo and edit', async () => {
    const { meeting } = await setup()
    const [proposal] = await propose(meeting.id, [{ payload: item('Order chairs') }])
    await rejectProposal(db, actor, proposal!.id)
    await undoProposal(db, actor, proposal!.id)
    await editProposal(db, actor, proposal!.id, item('Order two hundred chairs'))
    expect(await addProposals(db, { meetingId: meeting.id }, [{ payload: item('Order chairs') }])).toBe(0)
  })

  it('refuses once resolved, refuses a change of type, and refuses empty text', async () => {
    const { meeting } = await setup()
    const [a, b] = await propose(meeting.id, [{ payload: item('a') }, { payload: item('b') }])
    await acceptProposal(db, actor, a!.id)
    await expect(editProposal(db, actor, a!.id, item('changed'))).rejects.toThrow(ValidationError)
    await expect(
      editProposal(db, actor, b!.id, { type: 'document', title: 't', body: 'b' }),
    ).rejects.toThrow(ValidationError)
    await expect(editProposal(db, actor, b!.id, item('   '))).rejects.toThrow('Enter some text.')
    expect((await getProposal(db, b!.id)).payload).toMatchObject({ text: 'b' })
  })
})

describe('rejecting and undoing', () => {
  it('keeps a rejected row and puts it back to pending on undo', async () => {
    const { w, meeting } = await setup()
    const [proposal] = await propose(meeting.id, [{ payload: item('Order chairs') }])

    const rejected = await rejectProposal(db, actor, proposal!.id)
    expect(rejected.status).toBe('rejected')
    expect(await addProposals(db, { meetingId: meeting.id }, [{ payload: item('order chairs') }])).toBe(0)

    const back = await undoProposal(db, actor, proposal!.id)
    expect(back).toMatchObject({ status: 'pending', resolvedAt: null, result: null })
    expect(await itemCount(w.parish.id)).toBe(0)
  })

  it('removes the item an acceptance made', async () => {
    const { w, meeting } = await setup()
    const parent = await createItem(db, actor, { contextId: w.parish.id, kind: 'decision', text: 'Go ahead' })
    const [proposal] = await propose(meeting.id, [
      {
        payload: item('Book the hall', {
          parties: [{ role: 'owner', name: 'Tom', personId: w.tom.id }],
          parentItemId: parent.id,
        }),
      },
    ])
    const accepted = await acceptProposal(db, actor, proposal!.id)
    const itemId = accepted.result!.itemId!
    const ofParent = async () =>
      (await getThread(db, parent.id)).events.filter((e) => e.itemId === parent.id).map((e) => e.type)
    expect(await ofParent()).toEqual(['created', 'spawned'])

    const back = await undoProposal(db, actor, proposal!.id)
    expect(back).toMatchObject({ status: 'pending', result: null, made: null })
    expect(await db.select().from(items).where(eq(items.id, itemId))).toEqual([])
    // The parent no longer says it spawned something.
    expect(await ofParent()).toEqual(['created'])

    // And it can be accepted again.
    const again = await acceptProposal(db, actor, proposal!.id)
    expect(again.result!.itemId).not.toBe(itemId)
  })

  it('removes a question that was created already answered', async () => {
    const { w, meeting } = await setup()
    const [proposal] = await propose(meeting.id, [
      { payload: item('Which hall?', { kind: 'question', resolution: 'St Mark’s' }) },
    ])
    await acceptProposal(db, actor, proposal!.id)
    await undoProposal(db, actor, proposal!.id)
    expect(await itemCount(w.parish.id)).toBe(0)
  })

  it('reopens an item an accepted completion closed', async () => {
    const { w, meeting } = await setup()
    const action = await createItem(db, actor, { contextId: w.parish.id, kind: 'action', text: 'Book the hall' })
    const [proposal] = await propose(meeting.id, [
      { payload: { type: 'update', itemId: action.id, change: 'complete', text: 'Booked' } },
    ])
    await acceptProposal(db, actor, proposal!.id)
    expect((await getItem(db, action.id)).status).toBe('done')

    const back = await undoProposal(db, actor, proposal!.id)
    expect(back.status).toBe('pending')
    expect(await getItem(db, action.id)).toMatchObject({ status: 'open', resolution: null, closedAt: null })
    expect((await getThread(db, action.id)).events.map((e) => e.type)).toEqual([
      'created',
      'completed',
      'reopened',
    ])
  })

  it('reopens a question an accepted answer closed', async () => {
    const { w, meeting } = await setup()
    const question = await createItem(db, actor, { contextId: w.parish.id, kind: 'question', text: 'Which day?' })
    const [proposal] = await propose(meeting.id, [
      { payload: { type: 'update', itemId: question.id, change: 'answer', text: 'Saturday' } },
    ])
    await acceptProposal(db, actor, proposal!.id)
    expect(await getItem(db, question.id)).toMatchObject({ status: 'done', resolution: 'Saturday' })

    await undoProposal(db, actor, proposal!.id)
    expect(await getItem(db, question.id)).toMatchObject({
      kind: 'question',
      status: 'open',
      resolution: null,
      closedAt: null,
    })
    // And the answer can be accepted again.
    await acceptProposal(db, actor, proposal!.id)
    expect(await getItem(db, question.id)).toMatchObject({ status: 'done', resolution: 'Saturday' })
  })

  it('takes a note and a "discussed" back out of the history', async () => {
    const { w, meeting } = await setup()
    const topic = await createItem(db, actor, { contextId: w.parish.id, text: 'Parking' })
    const [note, discussed] = await propose(meeting.id, [
      { payload: { type: 'update', itemId: topic.id, change: 'note', text: 'Ask the council' } },
      { payload: { type: 'update', itemId: topic.id, change: 'discussed' } },
    ])
    await acceptProposal(db, actor, note!.id)
    await acceptProposal(db, actor, discussed!.id)

    await undoProposal(db, actor, note!.id)
    expect((await getThread(db, topic.id)).events.map((e) => e.type)).toEqual(['created', 'discussed'])
    await undoProposal(db, actor, discussed!.id)
    expect((await getThread(db, topic.id)).events.map((e) => e.type)).toEqual(['created'])
  })

  it('refuses to remove a created item once it has moved on', async () => {
    const { w, meeting } = await setup()
    const list = await propose(meeting.id, [
      { payload: item('Edited later') },
      { payload: item('Completed later') },
      { payload: item('Spawned something') },
      { payload: item('Placed on an agenda', { parties: [{ role: 'with', name: 'Tom', personId: w.tom.id }] }) },
    ])
    const ids: string[] = []
    for (const p of list) ids.push((await acceptProposal(db, actor, p.id)).result!.itemId!)

    await updateItem(db, actor, ids[0]!, { detail: 'more to it' })
    await completeItem(db, actor, ids[1]!)
    await createItem(db, actor, { contextId: w.parish.id, text: 'child', parentItemId: ids[2]! })
    const next = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Next', personIds: [w.tom.id] })
    await placeItem(db, actor, next.id, ids[3]!)

    for (const [index, p] of list.entries()) {
      await expect(undoProposal(db, actor, p.id)).rejects.toThrow(ValidationError)
      expect((await getProposal(db, p.id)).status).toBe('accepted')
      expect((await getItem(db, ids[index]!)).id).toBe(ids[index])
    }
    await expect(undoProposal(db, actor, list[3]!.id)).rejects.toThrow(/agenda/)
  })

  it('refuses to revert an update once the item has changed again, and lets a hand-reopened one go', async () => {
    const { w, meeting } = await setup()
    const question = await createItem(db, actor, { contextId: w.parish.id, kind: 'question', text: 'Which day?' })
    const action = await createItem(db, actor, { contextId: w.parish.id, kind: 'action', text: 'Send invites' })
    const [answer, complete] = await propose(meeting.id, [
      { payload: { type: 'update', itemId: question.id, change: 'answer', text: 'Saturday' } },
      { payload: { type: 'update', itemId: action.id, change: 'complete' } },
    ])
    await acceptProposal(db, actor, answer!.id)
    await acceptProposal(db, actor, complete!.id)

    // The question was reopened and answered differently since.
    const { reopenItem } = await import('../lib/items/items')
    await reopenItem(db, actor, question.id)
    await answerItem(db, actor, question.id, { answer: 'Sunday' })
    await expect(undoProposal(db, actor, answer!.id)).rejects.toThrow(/changed since/)
    expect(await getItem(db, question.id)).toMatchObject({ status: 'done', resolution: 'Sunday' })

    // The action was reopened by hand: nothing left to take back.
    await reopenItem(db, actor, action.id)
    expect((await undoProposal(db, actor, complete!.id)).status).toBe('pending')
    expect((await getItem(db, action.id)).status).toBe('open')
  })

  it('deletes an untouched document or stub, and refuses once either was worked on', async () => {
    const { w, meeting } = await setup()
    const stubOf = (name: string, personId: string) => ({
      payload: { type: 'stub' as const, title: `With ${name}`, people: [{ name, personId }] },
    })
    const [doc1, doc2, stub1, stub2] = await propose(meeting.id, [
      { payload: { type: 'document', title: 'One', body: 'text' } },
      { payload: { type: 'document', title: 'Two', body: 'text' } },
      stubOf('Sarah', w.sarah.id),
      stubOf('Tom', w.tom.id),
    ])
    const d1 = (await acceptProposal(db, actor, doc1!.id)).result!.documentId!
    const d2 = (await acceptProposal(db, actor, doc2!.id)).result!.documentId!
    const s1 = (await acceptProposal(db, actor, stub1!.id)).result!.meetingId!
    const s2 = (await acceptProposal(db, actor, stub2!.id)).result!.meetingId!

    await undoProposal(db, actor, doc1!.id)
    await expect(getDocument(db, d1)).rejects.toThrow(/not found/)
    await undoProposal(db, actor, stub1!.id)
    expect(await db.select().from(meetings).where(eq(meetings.id, s1))).toEqual([])

    await updateDocument(db, actor, d2, { body: 'rewritten' })
    await expect(undoProposal(db, actor, doc2!.id)).rejects.toThrow(/edited since/)
    await updateMeeting(db, actor, s2, { startsAt: new Date('2026-10-12T15:00:00Z') })
    await expect(undoProposal(db, actor, stub2!.id)).rejects.toThrow(/worked on/)
    expect((await getMeeting(db, s2)).id).toBe(s2)
  })
})

describe('approveAll', () => {
  it('leaves out guessed owners and unresolved proposals', async () => {
    const { w, meeting } = await setup()
    await propose(meeting.id, [
      { payload: item('Sure thing', { parties: [{ role: 'owner', name: 'Tom', personId: w.tom.id }] }) },
      { payload: item('A guess', { parties: [{ role: 'owner', name: 'Sarah', personId: w.sarah.id }] }), ownerGuessed: true },
      { payload: item('Who is this', { parties: [{ role: 'owner', name: 'Priya' }] }) },
      { payload: item('Move to May', { kind: 'decision' }) },
    ])

    const outcome = await approveAll(db, actor, meeting.id)
    expect(outcome).toEqual({ accepted: 2, left: 2, refused: [] })

    const made = await listItems(db, { contextId: w.parish.id })
    expect(made.map((i) => i.text).sort()).toEqual(['Move to May', 'Sure thing'])
    expect(made.every((i) => i.originMeetingId === meeting.id)).toBe(true)

    const pending = (await listProposals(db, meeting.id)).filter((p) => p.status === 'pending')
    expect(pending.map((p) => (p.payload as ItemPayload).text)).toEqual(['A guess', 'Who is this'])
  })

  it('carries on past one that is refused', async () => {
    const { w, meeting } = await setup()
    const action = await createItem(db, actor, { contextId: w.parish.id, kind: 'action', text: 'Book the hall' })
    await propose(meeting.id, [
      { payload: item('First') },
      { payload: { type: 'update', itemId: action.id, change: 'complete' } },
      { payload: item('Last') },
    ])
    // Closed by hand between processing and review.
    await completeItem(db, actor, action.id)

    const outcome = await approveAll(db, actor, meeting.id)
    expect(outcome.accepted).toBe(2)
    expect(outcome.left).toBe(1)
    expect(outcome.refused).toHaveLength(1)
    expect(outcome.refused[0]!.message).toBe('This item is already closed.')
    expect((await listItems(db, { contextId: w.parish.id, originMeetingId: meeting.id })).map((i) => i.text).sort()).toEqual(['First', 'Last'])
  })
})

describe('context isolation', () => {
  async function foreign(w: Awaited<ReturnType<typeof makeWorld>>) {
    const item_ = await createItem(db, actor, {
      contextId: w.diocese.id,
      kind: 'action',
      text: 'Diocesan matter',
    })
    return item_
  }

  it('strips a project, a group and a parent item from another context on the way in', async () => {
    const { w, meeting } = await setup()
    const elsewhere = await foreign(w)

    const cleaned = await cleanPayload(db, w.parish.id, item('Plan the seating', {
      parties: [
        { role: 'owner', name: 'the council', groupId: w.council.id },
        { role: 'with', name: 'Sarah', personId: w.sarah.id },
      ],
      projectId: w.synod.id,
      parentItemId: elsewhere.id,
    }))
    expect(cleaned.payload).toMatchObject({
      projectId: null,
      parentItemId: null,
      parties: [
        { role: 'owner', name: 'the council' },
        { role: 'with', name: 'Sarah', personId: w.sarah.id },
      ],
    })
    expect((cleaned.payload as ItemPayload).parties[0]).not.toHaveProperty('groupId')
    expect(cleaned.problems).toHaveLength(3)

    const [stored] = await propose(meeting.id, [
      { payload: item('Plan the seating', { parties: [{ role: 'owner', name: 'the council', groupId: w.council.id }], projectId: w.synod.id, parentItemId: elsewhere.id }) },
    ])
    expect(JSON.stringify(stored!.payload)).not.toContain(w.council.id)
    expect(JSON.stringify(stored!.payload)).not.toContain(w.synod.id)
    expect(JSON.stringify(stored!.payload)).not.toContain(elsewhere.id)
    expect(stored!.unresolved).toEqual(['the council'])
    expect(stored!.project).toBeNull()
  })

  it('never stores an update to another context’s item, or a document on its project', async () => {
    const { w, meeting } = await setup()
    const elsewhere = await foreign(w)
    const added = await addProposals(db, { meetingId: meeting.id }, [
      { payload: { type: 'update', itemId: elsewhere.id, change: 'complete' } },
      { payload: { type: 'update', itemId: 'not-a-uuid', change: 'complete' } },
      { payload: { type: 'document', title: 'Notes', body: 'text', projectId: w.synod.id } },
    ])
    expect(added).toBe(1)
    const [doc] = await listProposals(db, meeting.id)
    expect(doc!.payload).toEqual({ type: 'document', title: 'Notes', body: 'text', projectId: null })
  })

  it('refuses John’s own edit that points outside the context', async () => {
    const { w, meeting } = await setup()
    const elsewhere = await foreign(w)
    const mine = await createItem(db, actor, { contextId: w.parish.id, kind: 'action', text: 'Mine' })
    const [a, u] = await propose(meeting.id, [
      { payload: item('Plan the seating') },
      { payload: { type: 'update', itemId: mine.id, change: 'complete' } },
    ])

    await expect(editProposal(db, actor, a!.id, item('x', { projectId: w.synod.id }))).rejects.toThrow(ValidationError)
    await expect(
      editProposal(db, actor, a!.id, item('x', { parties: [{ role: 'owner', name: 'Council', groupId: w.council.id }] })),
    ).rejects.toThrow(ValidationError)
    await expect(editProposal(db, actor, a!.id, item('x', { parentItemId: elsewhere.id }))).rejects.toThrow(ValidationError)
    await expect(
      editProposal(db, actor, u!.id, { type: 'update', itemId: elsewhere.id, change: 'complete' }),
    ).rejects.toThrow(ValidationError)
    expect((await getProposal(db, a!.id)).payload).toMatchObject({ text: 'Plan the seating' })
  })

  it('refuses to accept a stored payload tampered to point at another context', async () => {
    const { w, meeting } = await setup()
    const elsewhere = await foreign(w)
    const mine = await createItem(db, actor, { contextId: w.parish.id, kind: 'action', text: 'Mine' })
    const [update, withProject, withGroup, withParent, doc] = await propose(meeting.id, [
      { payload: { type: 'update', itemId: mine.id, change: 'complete' } },
      { payload: item('a') },
      { payload: item('b') },
      { payload: item('c') },
      { payload: { type: 'document', title: 'Notes', body: 'text' } },
    ])

    const tamper = (id: string, payload: ProposalPayload) =>
      db.update(proposals).set({ payload }).where(eq(proposals.id, id))
    await tamper(update!.id, { type: 'update', itemId: elsewhere.id, change: 'complete' })
    await tamper(withProject!.id, item('a', { projectId: w.synod.id }))
    await tamper(withGroup!.id, item('b', { parties: [{ role: 'owner', name: 'Council', groupId: w.council.id }] }))
    await tamper(withParent!.id, item('c', { parentItemId: elsewhere.id }))
    await tamper(doc!.id, { type: 'document', title: 'Notes', body: 'text', projectId: w.synod.id })

    await expect(acceptProposal(db, actor, update!.id)).rejects.toThrow('That item belongs to another context.')
    await expect(acceptProposal(db, actor, withProject!.id)).rejects.toThrow('That project belongs to another context.')
    await expect(acceptProposal(db, actor, withGroup!.id)).rejects.toThrow('That group belongs to another context.')
    await expect(acceptProposal(db, actor, withParent!.id)).rejects.toThrow(ValidationError)
    await expect(acceptProposal(db, actor, doc!.id)).rejects.toThrow('That project belongs to another context.')

    // Nothing was written anywhere, and approve-all fares no better.
    const outcome = await approveAll(db, actor, meeting.id)
    expect(outcome.accepted).toBe(0)
    expect(outcome.refused).toHaveLength(5)
    expect(await getItem(db, elsewhere.id)).toMatchObject({ status: 'open' })
    expect(await itemCount(w.diocese.id)).toBe(1)
    expect(await itemCount(w.parish.id)).toBe(1)
    expect(await listDocuments(db, { contextId: w.parish.id })).toEqual([])
    expect(await listDocuments(db, { contextId: w.diocese.id })).toEqual([])

    // The view shows none of the other context's names either.
    const views = await listProposals(db, meeting.id)
    expect(views.find((p) => p.id === update!.id)!.item).toBeNull()
    expect(views.find((p) => p.id === withProject!.id)!.project).toBeNull()
    expect(views.find((p) => p.id === withGroup!.id)!.parties[0]).toMatchObject({ name: 'Council', unresolved: true, id: null })
    expect(views.find((p) => p.id === withParent!.id)!.parent).toBeNull()
  })

  it('an accepted stub lands in the meeting’s own context', async () => {
    const { w, meeting } = await setup()
    const [stub] = await propose(meeting.id, [
      { payload: { type: 'stub', title: 'Follow up', people: [{ name: 'Bishop', personId: w.bishop.id }] } },
    ])
    const accepted = await acceptProposal(db, actor, stub!.id)
    expect((await getMeeting(db, accepted.result!.meetingId!)).contextId).toBe(w.parish.id)
    expect(await listMeetings(db, { contextId: w.diocese.id })).toEqual([])
  })
})

describe('unresolvedIn', () => {
  it('names the parties with no row behind them', () => {
    expect(
      unresolvedIn(item('x', { parties: [{ role: 'owner', name: 'Priya' }, { role: 'with', name: 'Tom', personId: 'p' }] })),
    ).toEqual(['Priya'])
    expect(unresolvedIn({ type: 'stub', title: 't', people: [{ name: 'Ana' }] })).toEqual(['Ana'])
    expect(unresolvedIn({ type: 'document', title: 't', body: 'b' })).toEqual([])
  })
})
