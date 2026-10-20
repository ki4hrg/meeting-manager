/*
 * A Granola note becoming a meeting's note, against the real database and a
 * scripted Granola. Which context a note lands in is the thing most worth
 * proving here: only its folder decides, and nothing crosses.
 */

import { unknownAttendees } from '../lib/notes/attendees'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connections, meetings, notes, people, processingRuns } from '../lib/db/schema'
import { ValidationError } from '../lib/core/types'
import type { CalendarEvent } from '../lib/calendar/feed'
import {
  bindFolder,
  connectGranola,
  disconnectGranola,
  listFolderBindings,
  listGranolaAccounts,
  signingSecrets,
  unbindFolder,
} from '../lib/connect/granola/connection'
import { listBindings, listConnections } from '../lib/connect/connections'
import { granolaActor, ingestNoteById, type IngestOutcome } from '../lib/connect/granola/ingest'
import {
  countUnfiledNotes,
  dismissHeldNote,
  eventsNearNotes,
  undismissHeldNote,
  fileHeldNote,
  listUnfiledNotes,
  previewFiling,
} from '../lib/connect/granola/unfiled'
import { listItems } from '../lib/items/items'
import { createMeeting, deleteMeeting, getMeeting, listMeetings } from '../lib/meetings/meetings'
import { createSeries } from '../lib/meetings/series'
import { listNotes } from '../lib/notes/notes'
import { acceptProposal, listProposals } from '../lib/processing/proposals'
import { processQueued } from '../lib/processing/run'
import { db, resetBetweenTests } from './helpers/db'
import { actor, makeWorld } from './helpers/fixtures'
import {
  TEST_KEY,
  TEST_SECRET,
  connect,
  fakeGranola,
  folder,
  note,
  noteId,
} from './helpers/granola'

resetBetweenTests()
afterEach(() => vi.unstubAllGlobals())

const PARISH = 'fol_parish00000000'
const DIOCESE = 'fol_diocese0000000'
const OTHER = 'fol_other000000000'

const parishFolder = folder(PARISH, 'Parish')
const dioceseFolder = folder(DIOCESE, 'Diocese')

async function setUp() {
  const world = await makeWorld()
  const granola = fakeGranola({ folders: [parishFolder, dioceseFolder, folder(OTHER, 'Personal')] })
  const account = await connect([
    { folderId: PARISH, contextId: world.parish.id },
    { folderId: DIOCESE, contextId: world.diocese.id },
  ])
  const ingest = (id: string) => ingestNoteById(db, granolaActor('webhook'), account.id, id)
  return { ...world, granola, account, ingest }
}

function filed(outcome: IngestOutcome) {
  if (outcome.kind !== 'filed') throw new Error(`expected a filed note, got ${JSON.stringify(outcome)}`)
  return outcome
}

const everyMeeting = () => db.select().from(meetings)
const everyRun = () => db.select().from(processingRuns)

describe('walkthrough: a drop-in from a Granola note with no calendar event', () => {
  it('makes its own meeting, is processed, reviewed, and can be discarded', async () => {
    const { parish, diocese, sarah, granola, ingest } = await setUp()
    const id = noteId()
    granola.script.notes[id] = note({
      id,
      title: 'Corridor chat about the retreat',
      created_at: '2026-10-01T15:00:00Z',
      attendees: [
        { name: 'John', email: 'john@example.test' },
        { name: 'Sarah', email: 'Sarah@Example.test' },
        { name: 'A stranger', email: 'stranger@example.test' },
      ],
      folder_membership: [parishFolder],
      private_notes_markdown: '- D: The retreat moves to the spring\n- thinking aloud',
      summary_markdown: '## Retreat\n\nMoved to spring.',
    })
    granola.script.transcripts[id] = [
      { speaker: { attribution: 'me' }, text: 'Shall we move it?', start_time: '2026-10-01T15:00:05Z', end_time: '2026-10-01T15:00:09Z' },
      { speaker: { name: 'Sarah Jones' }, text: 'Spring is better.', start_time: '2026-10-01T15:00:10Z', end_time: '2026-10-01T15:20:00Z' },
    ]
    const peopleBefore = (await db.select().from(people)).length

    const outcome = filed(await ingest(id))

    // A meeting of its own, in the folder's context, when the note was started.
    expect(outcome).toMatchObject({ via: 'new', changed: true, queued: true })
    const meeting = await getMeeting(db, outcome.meetingId)
    expect(meeting).toMatchObject({
      contextId: parish.id,
      title: 'Corridor chat about the retreat',
      calendarEventId: null,
      series: null,
    })
    expect(meeting.startsAt).toEqual(new Date('2026-10-01T15:00:00Z'))
    // It ran until the last thing said.
    expect(meeting.endsAt).toEqual(new Date('2026-10-01T15:20:00Z'))
    // Who is already in the directory; never John, and nobody invented.
    expect(meeting.people.map((person) => person.id)).toEqual([sarah.id])
    expect((await db.select().from(people)).length).toBe(peopleBefore)
    expect(await listMeetings(db, { contextId: diocese.id })).toEqual([])

    // The note: John's notepad as the body, the summary and transcript beside it.
    const [saved] = await listNotes(db, meeting.id)
    expect(saved).toMatchObject({
      source: 'granola',
      externalId: id,
      body: '- D: The retreat moves to the spring\n- thinking aloud',
      summary: '## Retreat\n\nMoved to spring.',
      transcript: 'Me: Shall we move it?\nSarah Jones: Spring is better.',
    })

    // The one nobody knows waits on the note, to be asked about at review.
    expect(await unknownAttendees(db, meeting.id)).toEqual([
      { email: 'stranger@example.test', name: 'A stranger' },
    ])

    // Processing, with no model: the verbatim line, in his words.
    expect(await processQueued(db, null)).toEqual({ processed: 1, failed: 0 })
    const proposals = await listProposals(db, meeting.id)
    expect(proposals).toHaveLength(1)
    expect(proposals[0]).toMatchObject({ status: 'pending', verbatim: true })
    expect(proposals[0]!.payload).toMatchObject({
      type: 'item',
      kind: 'decision',
      text: 'The retreat moves to the spring',
    })

    // Nothing is an item until it is accepted; then it is one, in this context.
    expect(await listItems(db, { contextId: parish.id })).toEqual([])
    await acceptProposal(db, actor, proposals[0]!.id)
    const items = await listItems(db, { contextId: parish.id })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'decision', originMeetingId: meeting.id })
    expect(await listItems(db, { contextId: diocese.id })).toEqual([])

    // An auto-created meeting can be discarded; its note goes with it.
    await deleteMeeting(db, actor, meeting.id)
    expect(await db.select().from(notes)).toEqual([])
  })

  it('makes nothing for a note with nothing in it yet', async () => {
    const { granola, ingest } = await setUp()
    const id = noteId()
    granola.script.notes[id] = note({ id, folder_membership: [parishFolder], summary_markdown: null })

    expect(await ingest(id)).toEqual({ kind: 'ignored', reason: 'empty' })
    expect(await everyMeeting()).toEqual([])
  })
})

describe('context isolation', () => {
  it('holds a note outside every bound folder in no context, and runs nothing on it', async () => {
    const { granola, ingest } = await setUp()
    const unfiled = noteId()
    const elsewhere = noteId()
    granola.script.notes[unfiled] = note({ id: unfiled })
    granola.script.notes[elsewhere] = note({ id: elsewhere, folder_membership: [folder(OTHER, 'Personal')] })
    granola.script.transcripts[elsewhere] = []

    expect(await ingest(unfiled)).toMatchObject({ kind: 'held', reason: 'unbound', changed: true })
    expect(await ingest(elsewhere)).toMatchObject({ kind: 'held', reason: 'unbound', changed: true })
    expect(await everyMeeting()).toEqual([])
    const held = await db.select().from(notes)
    expect(held).toHaveLength(2)
    expect(held.every((row) => row.meetingId === null)).toBe(true)
    expect(await everyRun()).toEqual([])
  })

  it('files a note in the folder’s context even when its calendar event is a meeting elsewhere', async () => {
    const { parish, diocese, granola, ingest } = await setUp()
    const theirs = await createMeeting(db, actor, {
      contextId: diocese.id,
      title: 'Council',
      startsAt: new Date('2026-10-01T15:00:00Z'),
      calendarId: 'cal',
      calendarEventId: 'evt_council',
    })
    const id = noteId()
    granola.script.notes[id] = note({
      id,
      title: 'Council',
      folder_membership: [parishFolder],
      calendar_event: {
        event_title: 'Council',
        invitees: [],
        organiser: null,
        calendar_event_id: 'evt_council',
        scheduled_start_time: '2026-10-01T15:00:00Z',
        scheduled_end_time: '2026-10-01T16:00:00Z',
      },
    })

    const outcome = filed(await ingest(id))

    expect(outcome.via).toBe('new')
    expect(outcome.meetingId).not.toBe(theirs.id)
    const made = await getMeeting(db, outcome.meetingId)
    expect(made.contextId).toBe(parish.id)
    // The event stays the other meeting's; this one does not claim it.
    expect(made.calendarEventId).toBeNull()
    expect(await listNotes(db, theirs.id)).toEqual([])
    expect((await getMeeting(db, theirs.id)).calendarEventId).toBe('evt_council')
  })

  it('never matches by time across contexts', async () => {
    const { parish, diocese, granola, ingest } = await setUp()
    const theirs = await createMeeting(db, actor, {
      contextId: diocese.id,
      title: 'Council by hand',
      startsAt: new Date('2026-10-01T15:00:00Z'),
    })
    const id = noteId()
    granola.script.notes[id] = note({ id, folder_membership: [parishFolder] })

    const outcome = filed(await ingest(id))

    expect(outcome.via).toBe('new')
    expect((await getMeeting(db, outcome.meetingId)).contextId).toBe(parish.id)
    expect(await listNotes(db, theirs.id)).toEqual([])
  })

  it('does not join a series that lives in another context', async () => {
    const { parish, diocese, granola, ingest } = await setUp()
    await createSeries(db, { contextId: diocese.id, name: 'Council', calendarSeriesId: 'rec_council' })
    const id = noteId()
    granola.script.notes[id] = note({
      id,
      folder_membership: [parishFolder],
      calendar_event: {
        event_title: 'Council',
        invitees: [],
        organiser: null,
        calendar_event_id: 'rec_council_20261001T150000Z',
        scheduled_start_time: '2026-10-01T15:00:00Z',
        scheduled_end_time: null,
      },
    })

    const made = await getMeeting(db, filed(await ingest(id)).meetingId)
    expect(made).toMatchObject({ contextId: parish.id, series: null })
  })

  it('holds a note whose folders feed two contexts, rather than choosing', async () => {
    const { granola, ingest } = await setUp()
    const id = noteId()
    granola.script.notes[id] = note({ id, folder_membership: [parishFolder, dioceseFolder] })

    expect(await ingest(id)).toMatchObject({ kind: 'held', reason: 'ambiguous' })
    expect(await everyMeeting()).toEqual([])
    expect((await db.select().from(notes)).map((row) => row.meetingId)).toEqual([null])
  })

  it('uses only the bindings of the account the note came through', async () => {
    const { diocese, granola } = await setUp()
    /* A second account, with the same folder id bound to the other context. */
    const [second] = await db
      .insert(connections)
      .values({ provider: 'granola', account: 'second@example.test', credentials: '{}' })
      .returning()
    const [first] = (await listGranolaAccounts(db)).filter((one) => one.id !== second!.id)
    await db.update(connections).set({ credentials: (await db.select().from(connections).where(eq(connections.id, first!.id)))[0]!.credentials }).where(eq(connections.id, second!.id))
    await unbindFolder(db, { connectionId: first!.id, folderId: PARISH })
    await bindFolder(db, { connectionId: second!.id, folderId: PARISH, name: 'Parish', contextId: diocese.id })

    const id = noteId()
    granola.script.notes[id] = note({ id, folder_membership: [parishFolder] })

    // Through the first account the folder is not bound at all.
    expect(await ingestNoteById(db, granolaActor('job'), first!.id, id)).toMatchObject({ kind: 'held', reason: 'unbound' })
    // Through the second it feeds the context that account bound it to, and the held note is filed there.
    const outcome = filed(await ingestNoteById(db, granolaActor('job'), second!.id, id))
    expect((await getMeeting(db, outcome.meetingId)).contextId).toBe(diocese.id)
  })
})

describe('the Inbox', () => {
  const council = {
    event_title: 'Council',
    invitees: [{ email: 'sarah@example.test' }],
    organiser: null,
    calendar_event_id: 'evt_council',
    scheduled_start_time: '2026-10-01T15:00:00Z',
    scheduled_end_time: '2026-10-01T16:00:00Z',
  }

  it('lists a held note, whichever context is selected, with when and who', async () => {
    const { granola, ingest } = await setUp()
    const id = noteId()
    granola.script.notes[id] = note({
      id,
      title: 'Hallway',
      calendar_event: council,
      attendees: [
        { name: 'John', email: 'john@example.test' },
        { name: 'Sarah', email: 'sarah@example.test' },
      ],
    })
    await ingest(id)

    const [held] = await listUnfiledNotes(db)
    expect(held).toMatchObject({
      title: 'Hallway',
      startsAt: new Date('2026-10-01T15:00:00Z'),
      endsAt: new Date('2026-10-01T16:00:00Z'),
      // The note's owner (John) is never listed.
      attendees: [{ email: 'sarah@example.test', name: 'Sarah' }],
    })
    expect(await countUnfiledNotes(db)).toBe(1)
  })

  it('holds a note in no folder at all, as Granola sends it with or without the field', async () => {
    const { granola, ingest } = await setUp()
    const bare = noteId()
    const empty = noteId()
    const noField = note({ id: bare, title: 'No folder' })
    delete noField.folder_membership
    granola.script.notes[bare] = noField
    granola.script.notes[empty] = note({ id: empty, title: 'Empty folders', folder_membership: [] })

    expect(await ingest(bare)).toMatchObject({ kind: 'held', reason: 'unbound' })
    expect(await ingest(empty)).toMatchObject({ kind: 'held', reason: 'unbound' })
    expect((await listUnfiledNotes(db)).map((held) => held.title).sort()).toEqual(['Empty folders', 'No folder'])
  })

  it('files a note with no bound folder on the meeting made for its calendar event', async () => {
    const { diocese, granola, ingest } = await setUp()
    const prepped = await createMeeting(db, actor, {
      contextId: diocese.id,
      title: 'Council',
      startsAt: new Date('2026-10-01T15:00:00Z'),
      calendarId: 'cal',
      calendarEventId: 'evt_council',
    })
    const id = noteId()
    granola.script.notes[id] = note({ id, calendar_event: council })

    const outcome = filed(await ingest(id))
    expect(outcome).toMatchObject({ meetingId: prepped.id, via: 'event', queued: true })
    expect(await listUnfiledNotes(db)).toEqual([])
  })

  it('files a held note in the chosen context: the meeting under way there, or one of its own', async () => {
    const { parish, diocese, sarah, granola, ingest } = await setUp()
    const byHand = await createMeeting(db, actor, {
      contextId: parish.id,
      title: 'Staff',
      startsAt: new Date('2026-10-01T15:00:00Z'),
    })
    const first = noteId()
    const second = noteId()
    granola.script.notes[first] = note({ id: first })
    granola.script.notes[second] = note({
      id: second,
      title: 'Council',
      calendar_event: council,
      attendees: [{ name: 'Sarah', email: 'sarah@example.test' }],
    })
    const one = await ingest(first)
    const two = await ingest(second)
    if (one.kind !== 'held' || two.kind !== 'held') throw new Error('expected both held')

    // Under way in the parish when it was started: filed there.
    expect(await fileHeldNote(db, actor, one.noteId, parish.id)).toEqual({ meetingId: byHand.id, via: 'time' })
    // Nothing in the diocese: a meeting of its own, claiming its event, with who is known.
    const made = await fileHeldNote(db, actor, two.noteId, diocese.id)
    expect(made.via).toBe('new')
    const meeting = await getMeeting(db, made.meetingId)
    expect(meeting).toMatchObject({ contextId: diocese.id, title: 'Council', calendarEventId: 'evt_council' })
    expect(meeting.people.map((person) => person.id)).toEqual([sarah.id])
    expect(meeting.endsAt).toEqual(new Date('2026-10-01T16:00:00Z'))

    // Each filed note is queued like any arriving note, and the Inbox is empty.
    expect((await everyRun()).map((run) => run.noteId).sort()).toEqual([one.noteId, two.noteId].sort())
    expect(await listUnfiledNotes(db)).toEqual([])
    await expect(fileHeldNote(db, actor, one.noteId, diocese.id)).rejects.toThrow(ValidationError)

    // A later delivery updates it where it was filed.
    granola.script.notes[second] = { ...granola.script.notes[second]!, summary_markdown: 'More.', updated_at: '2026-10-01T17:00:00Z' }
    expect(filed(await ingest(second))).toMatchObject({ meetingId: made.meetingId, via: 'note', changed: true })
  })

  it('shows where File would go, and files a held note on a meeting John picks instead', async () => {
    const { parish, diocese, granola, ingest } = await setUp()
    const byHand = await createMeeting(db, actor, {
      contextId: parish.id,
      title: 'Staff',
      startsAt: new Date('2026-10-01T15:00:00Z'),
    })
    const retreat = await createMeeting(db, actor, { contextId: parish.id, title: 'Retreat' })
    const day = await createMeeting(db, actor, {
      contextId: parish.id,
      title: 'Day one',
      parentMeetingId: retreat.id,
      startsAt: new Date('2026-10-03T15:00:00Z'),
    })
    const elsewhere = await createMeeting(db, actor, { contextId: diocese.id, title: 'Council' })
    const id = noteId()
    granola.script.notes[id] = note({ id })
    const held = await ingest(id)
    if (held.kind !== 'held') throw new Error('expected held')

    expect(await previewFiling(db, held.noteId, parish.id)).toEqual({ meetingId: byHand.id, via: 'time' })
    expect(await previewFiling(db, held.noteId, diocese.id)).toBeNull()
    // Previewing files nothing.
    expect((await listUnfiledNotes(db)).map((one) => one.id)).toEqual([held.noteId])

    // The session, not the meeting it belongs to; and only in the chosen context.
    await expect(
      fileHeldNote(db, actor, held.noteId, parish.id, { meetingId: retreat.id }),
    ).rejects.toThrow(/sessions/)
    await expect(
      fileHeldNote(db, actor, held.noteId, parish.id, { meetingId: elsewhere.id }),
    ).rejects.toThrow(/another context/)

    expect(await fileHeldNote(db, actor, held.noteId, parish.id, { meetingId: day.id })).toEqual({
      meetingId: day.id,
      via: 'chosen',
    })
    expect((await everyRun()).map((run) => run.noteId)).toEqual([held.noteId])
    expect(await listUnfiledNotes(db)).toEqual([])
    // No meeting was made for it.
    expect(await listMeetings(db, { contextId: parish.id })).toHaveLength(3)
  })

  it('offers the calendar events near a held note, and files it on one, prepping its meeting', async () => {
    const { parish, diocese, sarah, granola, ingest } = await setUp()
    const event = (over: Partial<CalendarEvent>): CalendarEvent => ({
      calendarId: 'cal-1',
      eventId: 'evt-1',
      seriesId: null,
      title: 'Event',
      startsAt: new Date('2026-10-01T15:00:00Z'),
      endsAt: new Date('2026-10-01T16:00:00Z'),
      allDay: false,
      attendees: [],
      location: null,
      htmlLink: null,
      ...over,
    })
    const councilEvent = event({
      eventId: 'evt_council',
      title: 'Council',
      attendees: [{ personId: sarah.id, email: 'sarah@example.test', name: 'Sarah', declined: false }],
    })
    const lunch = event({ eventId: 'evt_lunch', title: 'Lunch', startsAt: new Date('2026-10-01T14:30:00Z') })
    const elsewhere = event({ eventId: 'evt_elsewhere', title: 'Elsewhere', startsAt: new Date('2026-10-01T15:30:00Z') })
    const events = [
      lunch,
      councilEvent,
      elsewhere,
      event({ eventId: 'evt_later', title: 'Later', startsAt: new Date('2026-10-04T15:00:00Z') }),
      event({ eventId: 'evt_allday', title: 'Feast', allDay: true }),
    ]
    // An event that already has a meeting is offered as that meeting, not as an event.
    await createMeeting(db, actor, {
      contextId: diocese.id,
      title: 'Elsewhere',
      startsAt: elsewhere.startsAt,
      calendarEventId: 'evt_elsewhere',
    })

    const first = noteId()
    granola.script.notes[first] = note({ id: first, title: 'Council', calendar_event: council })
    const held = await ingest(first)
    if (held.kind !== 'held') throw new Error('expected held')

    const unfiled = await listUnfiledNotes(db)
    expect(unfiled[0]).toMatchObject({ calendarEventId: 'evt_council' })
    // Its own event first, then the closest; nothing far off, all day, or already a meeting.
    const near = await eventsNearNotes(db, parish.id, unfiled, { events })
    expect(near.get(held.noteId)!.map((one) => one.title)).toEqual(['Council', 'Lunch'])

    expect(await fileHeldNote(db, actor, held.noteId, parish.id, { event: councilEvent })).toMatchObject({
      via: 'chosen',
    })
    const [filedOn] = await listMeetings(db, { contextId: parish.id })
    expect(filedOn).toMatchObject({ title: 'Council', calendarEventId: 'evt_council', contextId: parish.id })
    expect(filedOn!.people.map((person) => person.id)).toEqual([sarah.id])
    expect((await listNotes(db, filedOn!.id)).map((one) => one.id)).toEqual([held.noteId])
    expect((await everyRun()).map((run) => run.noteId)).toEqual([held.noteId])

    // An event whose meeting is in another context is refused, and nothing is filed.
    const second = noteId()
    granola.script.notes[second] = note({ id: second })
    const other = await ingest(second)
    if (other.kind !== 'held') throw new Error('expected held')
    await expect(fileHeldNote(db, actor, other.noteId, parish.id, { event: elsewhere })).rejects.toThrow(
      /another context/,
    )
    expect((await listUnfiledNotes(db)).map((one) => one.id)).toEqual([other.noteId])
  })

  it('keeps a held note held when it changes, and files it once its folder is bound', async () => {
    const { parish, granola, ingest, account } = await setUp()
    const id = noteId()
    granola.script.notes[id] = note({ id, folder_membership: [folder(OTHER, 'Personal')] })
    const held = await ingest(id)
    if (held.kind !== 'held') throw new Error('expected held')

    granola.script.notes[id] = { ...granola.script.notes[id]!, summary_markdown: 'Edited.' }
    expect(await ingest(id)).toMatchObject({ kind: 'held', noteId: held.noteId, changed: true })
    expect(await ingest(id)).toMatchObject({ kind: 'held', changed: false })
    expect(await everyRun()).toEqual([])

    await bindFolder(db, { connectionId: account.id, folderId: OTHER, name: 'Personal', contextId: parish.id })
    const outcome = filed(await ingest(id))
    expect(outcome).toMatchObject({ noteId: held.noteId, via: 'new', queued: true })
    expect((await getMeeting(db, outcome.meetingId)).contextId).toBe(parish.id)
  })

  it('a dismissed note stays out of the Inbox when it is delivered again', async () => {
    const { granola, ingest } = await setUp()
    const id = noteId()
    granola.script.notes[id] = note({ id })
    const held = await ingest(id)
    if (held.kind !== 'held') throw new Error('expected held')

    await dismissHeldNote(db, actor, held.noteId)
    expect(await listUnfiledNotes(db)).toEqual([])
    granola.script.notes[id] = { ...granola.script.notes[id]!, summary_markdown: 'Edited.' }
    await ingest(id)
    expect(await countUnfiledNotes(db)).toBe(0)

    // Undo brings it back to the Inbox.
    await undismissHeldNote(db, actor, held.noteId)
    expect(await countUnfiledNotes(db)).toBe(1)
  })

  it('refuses to dismiss or file a note that is already filed', async () => {
    const { parish, granola, ingest } = await setUp()
    const id = noteId()
    granola.script.notes[id] = note({ id, folder_membership: [parishFolder] })
    const outcome = filed(await ingest(id))

    await expect(dismissHeldNote(db, actor, outcome.noteId)).rejects.toThrow(ValidationError)
    await expect(fileHeldNote(db, actor, outcome.noteId, parish.id)).rejects.toThrow(ValidationError)
  })
})

describe('folders', () => {
  it('holds a note from a folder bound to an archived context, without climbing past it', async () => {
    const { diocese, granola, ingest, account } = await setUp()
    const { archive, unarchive } = await import('../lib/archive/archive')
    const child = folder('fol_child000000000', 'Staff', PARISH)
    granola.script.folders.push(child)
    await bindFolder(db, { connectionId: account.id, folderId: child.id, name: 'Staff', contextId: diocese.id })
    await archive(db, 'context', diocese.id)

    const direct = noteId()
    granola.script.notes[direct] = note({ id: direct, folder_membership: [dioceseFolder] })
    expect(await ingest(direct)).toMatchObject({ kind: 'held', reason: 'unbound' })

    // The parish folder above is bound, but the dormant one below stops the climb.
    const nested = noteId()
    granola.script.notes[nested] = note({ id: nested, created_at: '2026-10-02T15:00:00Z', folder_membership: [child] })
    expect(await ingest(nested)).toMatchObject({ kind: 'held', reason: 'unbound' })
    expect(await everyMeeting()).toEqual([])

    await unarchive(db, 'context', diocese.id)
    const after = noteId()
    granola.script.notes[after] = note({ id: after, created_at: '2026-10-03T15:00:00Z', folder_membership: [child] })
    expect((await getMeeting(db, filed(await ingest(after)).meetingId)).contextId).toBe(diocese.id)
  })

  it('runs nothing in an archived context, until it is restored', async () => {
    const { parish, granola, ingest } = await setUp()
    const { archive, unarchive } = await import('../lib/archive/archive')
    const id = noteId()
    granola.script.notes[id] = note({ id, folder_membership: [parishFolder] })
    granola.script.transcripts[id] = []
    expect(filed(await ingest(id)).queued).toBe(true)

    // Archiving the parish needs another live context: the diocese is one.
    await archive(db, 'context', parish.id)
    expect(await processQueued(db, null)).toEqual({ processed: 0, failed: 0 })
    expect((await everyRun()).map((run) => run.status)).toEqual(['queued'])

    await unarchive(db, 'context', parish.id)
    expect((await processQueued(db, null)).processed).toBe(1)
  })

  it('takes the nearest bound folder above an unbound one', async () => {
    const { parish, diocese, granola, ingest, account } = await setUp()
    const child = folder('fol_child000000000', 'Staff', PARISH)
    const grandchild = folder('fol_grand000000000', '1:1s', child.id)
    granola.script.folders.push(child, grandchild)

    const deep = noteId()
    granola.script.notes[deep] = note({ id: deep, folder_membership: [grandchild] })
    expect((await getMeeting(db, filed(await ingest(deep)).meetingId)).contextId).toBe(parish.id)
    // The tree was needed, and asked for.
    expect(granola.count(/GET \/v1\/folders/)).toBe(1)

    // A binding of its own on the folder in between wins over the one above.
    await bindFolder(db, { connectionId: account.id, folderId: child.id, name: 'Staff', contextId: diocese.id })
    const next = noteId()
    granola.script.notes[next] = note({ id: next, created_at: '2026-10-02T15:00:00Z', folder_membership: [grandchild] })
    expect((await getMeeting(db, filed(await ingest(next)).meetingId)).contextId).toBe(diocese.id)
  })

  it("puts a project-bound folder's project on the meeting, alongside what it has", async () => {
    const { parish, retreat, campaign, tom, granola, ingest, account } = await setUp()
    const child = folder('fol_retreat0000000', 'Retreat', PARISH)
    const loose = folder('fol_loose00000000', 'Loose', child.id)
    granola.script.folders.push(child, loose)
    await bindFolder(db, { connectionId: account.id, folderId: child.id, name: 'Retreat', contextId: parish.id, scope: { kind: 'project', id: retreat.id } })

    // A drop-in made for the note takes the project.
    const first = noteId()
    granola.script.notes[first] = note({ id: first, folder_membership: [child] })
    const made = await getMeeting(db, filed(await ingest(first)).meetingId)
    expect(made.contextId).toBe(parish.id)
    expect(made.projects.map((project) => project.id)).toEqual([retreat.id])

    // A prepped meeting keeps its projects and gains the folder's.
    const prepped = await createMeeting(db, actor, {
      contextId: parish.id,
      title: 'Planning',
      startsAt: new Date('2026-10-03T15:00:00Z'),
      calendarEventId: 'evt_planning',
      personIds: [tom.id],
      projectIds: [campaign.id],
    })
    const second = noteId()
    granola.script.notes[second] = note({
      id: second,
      folder_membership: [child],
      calendar_event: {
        event_title: 'Planning',
        invitees: [],
        organiser: null,
        calendar_event_id: 'evt_planning',
        scheduled_start_time: '2026-10-03T15:00:00Z',
        scheduled_end_time: '2026-10-03T16:00:00Z',
      },
    })
    expect(filed(await ingest(second))).toMatchObject({ via: 'event', meetingId: prepped.id })
    expect((await getMeeting(db, prepped.id)).projects.map((project) => project.id).sort()).toEqual(
      [retreat.id, campaign.id].sort(),
    )

    // A subfolder bound to the whole context names no project.
    await bindFolder(db, { connectionId: account.id, folderId: loose.id, name: 'Loose', contextId: parish.id })
    const third = noteId()
    granola.script.notes[third] = note({ id: third, created_at: '2026-10-05T15:00:00Z', folder_membership: [loose] })
    expect((await getMeeting(db, filed(await ingest(third)).meetingId)).projects).toEqual([])
  })

  it("puts a series-bound folder's note on a meeting in that series, and a group-bound folder's group on it", async () => {
    const { parish, diocese, staff, council, sarah, tom, granola, ingest, account } = await setUp()
    const weekly = await createSeries(db, { contextId: parish.id, name: 'Weekly staff', personIds: [tom.id] })
    const seriesFolder = folder('fol_weekly0000000', 'Weekly', PARISH)
    const groupFolder = folder('fol_staffgrp00000', 'Staff', PARISH)
    granola.script.folders.push(seriesFolder, groupFolder)
    await bindFolder(db, { connectionId: account.id, folderId: seriesFolder.id, name: 'Weekly', contextId: parish.id, scope: { kind: 'series', id: weekly.id } })
    await bindFolder(db, { connectionId: account.id, folderId: groupFolder.id, name: 'Staff', contextId: parish.id, scope: { kind: 'group', id: staff.id } })

    // A meeting made for the note joins the series, its roster standing in.
    const first = noteId()
    granola.script.notes[first] = note({ id: first, folder_membership: [seriesFolder] })
    const made = await getMeeting(db, filed(await ingest(first)).meetingId)
    expect(made.contextId).toBe(parish.id)
    expect(made.series?.id).toBe(weekly.id)
    expect(made.people.map((person) => person.id)).toEqual([tom.id])

    // A meeting it is filed on keeps its series, or its lack of one.
    const prepped = await createMeeting(db, actor, {
      contextId: parish.id,
      title: 'Hallway',
      startsAt: new Date('2026-10-06T15:00:00Z'),
      calendarEventId: 'evt_hallway',
      personIds: [sarah.id],
    })
    const second = noteId()
    granola.script.notes[second] = note({
      id: second,
      folder_membership: [seriesFolder],
      calendar_event: {
        event_title: 'Hallway',
        invitees: [],
        organiser: null,
        calendar_event_id: 'evt_hallway',
        scheduled_start_time: '2026-10-06T15:00:00Z',
        scheduled_end_time: '2026-10-06T16:00:00Z',
      },
    })
    expect(filed(await ingest(second))).toMatchObject({ via: 'event', meetingId: prepped.id })
    expect((await getMeeting(db, prepped.id)).series).toBeNull()

    // The group folder's group joins the meeting.
    const third = noteId()
    granola.script.notes[third] = note({ id: third, created_at: '2026-10-08T15:00:00Z', folder_membership: [groupFolder] })
    const grouped = await getMeeting(db, filed(await ingest(third)).meetingId)
    expect(grouped.groups.map((group) => group.id)).toEqual([staff.id])
    expect(grouped.series).toBeNull()

    // Two series named: neither is guessed.
    const other = await createSeries(db, { contextId: parish.id, name: 'Other' })
    const otherFolder = folder('fol_otherser00000', 'Other', PARISH)
    granola.script.folders.push(otherFolder)
    await bindFolder(db, { connectionId: account.id, folderId: otherFolder.id, name: 'Other', contextId: parish.id, scope: { kind: 'series', id: other.id } })
    const fourth = noteId()
    granola.script.notes[fourth] = note({ id: fourth, created_at: '2026-10-10T15:00:00Z', folder_membership: [seriesFolder, otherFolder] })
    expect((await getMeeting(db, filed(await ingest(fourth)).meetingId)).series).toBeNull()

    // An archived series makes no meeting of it; the folder still feeds the context.
    const { archive } = await import('../lib/archive/archive')
    await archive(db, 'series', weekly.id)
    const fifth = noteId()
    granola.script.notes[fifth] = note({ id: fifth, created_at: '2026-10-12T15:00:00Z', folder_membership: [seriesFolder] })
    const after = await getMeeting(db, filed(await ingest(fifth)).meetingId)
    expect(after.contextId).toBe(parish.id)
    expect(after.series).toBeNull()

    // A series or group from another context is refused.
    await expect(
      bindFolder(db, { connectionId: account.id, folderId: PARISH, name: 'Parish', contextId: diocese.id, scope: { kind: 'series', id: other.id } }),
    ).rejects.toThrow(ValidationError)
    await expect(
      bindFolder(db, { connectionId: account.id, folderId: PARISH, name: 'Parish', contextId: parish.id, scope: { kind: 'group', id: council.id } }),
    ).rejects.toThrow(ValidationError)
  })

  it('keeps one scope on a folder: binding to a group clears the project', async () => {
    const { parish, retreat, staff, account } = await setUp()
    await bindFolder(db, { connectionId: account.id, folderId: PARISH, name: 'Parish', contextId: parish.id, scope: { kind: 'project', id: retreat.id } })
    await bindFolder(db, { connectionId: account.id, folderId: PARISH, name: 'Parish', contextId: parish.id, scope: { kind: 'group', id: staff.id } })
    const [bound] = (await listFolderBindings(db, { connectionId: account.id })).filter((one) => one.externalId === PARISH)
    expect(bound).toMatchObject({ contextId: parish.id, projectId: null, seriesId: null, groupId: staff.id })
  })

  it('refuses a project from another context, and binding again clears the project', async () => {
    const { parish, diocese, retreat, account } = await setUp()
    await expect(
      bindFolder(db, { connectionId: account.id, folderId: PARISH, name: 'Parish', contextId: diocese.id, scope: { kind: 'project', id: retreat.id } }),
    ).rejects.toThrow(ValidationError)

    await bindFolder(db, { connectionId: account.id, folderId: PARISH, name: 'Parish', contextId: parish.id, scope: { kind: 'project', id: retreat.id } })
    await bindFolder(db, { connectionId: account.id, folderId: PARISH, name: 'Parish', contextId: parish.id })
    const [bound] = (await listFolderBindings(db, { connectionId: account.id })).filter((one) => one.externalId === PARISH)
    expect(bound).toMatchObject({ contextId: parish.id, projectId: null })
  })

  it('binds a folder to one context, and binding again moves it', async () => {
    const { parish, diocese, account } = await setUp()
    await bindFolder(db, { connectionId: account.id, folderId: PARISH, name: 'Parish', contextId: diocese.id })

    const bound = await listFolderBindings(db, { connectionId: account.id })
    expect(bound.filter((one) => one.externalId === PARISH).map((one) => one.contextId)).toEqual([diocese.id])
    expect(bound.some((one) => one.contextId === parish.id)).toBe(false)
    // Folder bindings are not calendars: the feed never sees them.
    expect(await listBindings(db)).toEqual([])

    await unbindFolder(db, { connectionId: account.id, folderId: PARISH })
    expect((await listFolderBindings(db)).map((one) => one.externalId)).toEqual([DIOCESE])
  })
})

describe('matching an existing meeting', () => {
  const event = (id: string) => ({
    event_title: 'Staff',
    invitees: [{ email: 'sarah@example.test' }],
    organiser: null,
    calendar_event_id: id,
    scheduled_start_time: '2026-10-01T15:00:00Z',
    scheduled_end_time: '2026-10-01T16:00:00Z',
  })

  it('files on the meeting that holds its calendar event', async () => {
    const { parish, tom, granola, ingest } = await setUp()
    const prepped = await createMeeting(db, actor, {
      contextId: parish.id,
      title: 'Staff',
      startsAt: new Date('2026-10-01T15:00:00Z'),
      calendarId: 'cal',
      calendarEventId: 'evt_staff',
      personIds: [tom.id],
    })
    const id = noteId()
    granola.script.notes[id] = note({ id, folder_membership: [parishFolder], calendar_event: event('evt_staff') })

    const outcome = filed(await ingest(id))

    expect(outcome).toMatchObject({ via: 'event', meetingId: prepped.id })
    expect(await everyMeeting()).toHaveLength(1)
    // The prepped roster is John's; the note does not rewrite it.
    expect((await getMeeting(db, prepped.id)).people.map((person) => person.id)).toEqual([tom.id])
  })

  it('makes the meeting for an event nobody prepped, in its series when that is here', async () => {
    const { parish, sarah, tom, granola, ingest } = await setUp()
    const series = await createSeries(db, {
      contextId: parish.id,
      name: 'Staff',
      personIds: [tom.id],
      calendarSeriesId: 'rec_staff',
    })
    const id = noteId()
    granola.script.notes[id] = note({
      id,
      title: null,
      folder_membership: [parishFolder],
      calendar_event: event('rec_staff_20261001T150000Z'),
    })

    const made = await getMeeting(db, filed(await ingest(id)).meetingId)

    expect(made).toMatchObject({
      title: 'Staff',
      calendarEventId: 'rec_staff_20261001T150000Z',
      series: { id: series.id },
    })
    expect(made.endsAt).toEqual(new Date('2026-10-01T16:00:00Z'))
    // The note named somebody, so they are the people; the roster is the fallback.
    expect(made.people.map((person) => person.id)).toEqual([sarah.id])
    // Not prepped: no agenda was laid down for a meeting that is over.
    expect(made.sessions).toEqual([])
  })

  it('files on the one meeting under way when the note has no event', async () => {
    const { parish, granola, ingest } = await setUp()
    const logged = await createMeeting(db, actor, {
      contextId: parish.id,
      title: 'By hand',
      startsAt: new Date('2026-10-01T14:50:00Z'),
    })
    await createMeeting(db, actor, {
      contextId: parish.id,
      title: 'Earlier',
      startsAt: new Date('2026-10-01T12:00:00Z'),
      endsAt: new Date('2026-10-01T12:30:00Z'),
    })
    const id = noteId()
    granola.script.notes[id] = note({ id, folder_membership: [parishFolder] })

    expect(filed(await ingest(id))).toMatchObject({ via: 'time', meetingId: logged.id })
    expect(await everyMeeting()).toHaveLength(2)
  })

  it('a second recording of the same conversation joins the first', async () => {
    const { granola, ingest } = await setUp()
    const first = noteId()
    const second = noteId()
    granola.script.notes[first] = note({ id: first, folder_membership: [parishFolder] })
    granola.script.transcripts[first] = [
      { speaker: null, text: 'Part one.', start_time: '2026-10-01T15:00:00Z', end_time: '2026-10-01T15:30:00Z' },
    ]
    granola.script.notes[second] = note({ id: second, created_at: '2026-10-01T15:25:00Z', folder_membership: [parishFolder] })

    const one = filed(await ingest(first))
    const two = filed(await ingest(second))

    expect(two).toMatchObject({ via: 'time', meetingId: one.meetingId })
    expect(await listNotes(db, one.meetingId)).toHaveLength(2)
  })

  it('does not join a drop-in that had already ended', async () => {
    const { granola, ingest } = await setUp()
    const first = noteId()
    const second = noteId()
    granola.script.notes[first] = note({ id: first, folder_membership: [parishFolder] })
    granola.script.transcripts[first] = [
      { speaker: null, text: 'Short.', start_time: '2026-10-01T15:00:00Z', end_time: '2026-10-01T15:10:00Z' },
    ]
    granola.script.notes[second] = note({ id: second, created_at: '2026-10-01T15:30:00Z', folder_membership: [parishFolder] })

    const one = filed(await ingest(first))
    const two = filed(await ingest(second))

    expect(two.via).toBe('new')
    expect(two.meetingId).not.toBe(one.meetingId)
  })

  it('makes its own meeting rather than choose between two under way', async () => {
    const { parish, granola, ingest } = await setUp()
    for (const title of ['One', 'Two']) {
      await createMeeting(db, actor, { contextId: parish.id, title, startsAt: new Date('2026-10-01T15:00:00Z') })
    }
    const id = noteId()
    granola.script.notes[id] = note({ id, folder_membership: [parishFolder] })

    expect(filed(await ingest(id)).via).toBe('new')
    expect(await everyMeeting()).toHaveLength(3)
  })

  it('does not file on a meeting whose people are all somebody else', async () => {
    const { parish, tom, granola, ingest } = await setUp()
    const withTom = await createMeeting(db, actor, {
      contextId: parish.id,
      startsAt: new Date('2026-10-01T15:00:00Z'),
      personIds: [tom.id],
    })
    const id = noteId()
    granola.script.notes[id] = note({
      id,
      folder_membership: [parishFolder],
      attendees: [{ email: 'sarah@example.test' }],
    })

    const outcome = filed(await ingest(id))
    expect(outcome.via).toBe('new')
    expect(outcome.meetingId).not.toBe(withTom.id)
  })

  it('prefers the session to the multi-day meeting around it, and never an undated stub', async () => {
    const { parish, sarah, granola, ingest } = await setUp()
    const retreat = await createMeeting(db, actor, {
      contextId: parish.id,
      title: 'Retreat',
      startsAt: new Date('2026-10-01T09:00:00Z'),
      endsAt: new Date('2026-10-03T17:00:00Z'),
    })
    const session = await createMeeting(db, actor, {
      contextId: parish.id,
      title: 'Afternoon',
      parentMeetingId: retreat.id,
      startsAt: new Date('2026-10-01T14:00:00Z'),
      endsAt: new Date('2026-10-01T16:00:00Z'),
    })
    await createMeeting(db, actor, { contextId: parish.id, personIds: [sarah.id] })
    const id = noteId()
    granola.script.notes[id] = note({
      id,
      folder_membership: [parishFolder],
      attendees: [{ email: 'sarah@example.test' }],
    })

    expect(filed(await ingest(id))).toMatchObject({ via: 'time', meetingId: session.id })
  })
})

describe('re-delivery', () => {
  it('unchanged: nothing is saved and nothing is queued', async () => {
    const { granola, ingest } = await setUp()
    const id = noteId()
    granola.script.notes[id] = note({ id, folder_membership: [parishFolder] })

    const first = filed(await ingest(id))
    const again = filed(await ingest(id))

    expect(again).toMatchObject({ via: 'note', changed: false, queued: false, meetingId: first.meetingId, noteId: first.noteId })
    expect(await everyMeeting()).toHaveLength(1)
    expect(await db.select().from(notes)).toHaveLength(1)
    expect(await everyRun()).toHaveLength(1)
  })

  it('edited: the same note, a new version and a new run', async () => {
    const { granola, ingest } = await setUp()
    const id = noteId()
    granola.script.notes[id] = note({ id, folder_membership: [parishFolder], private_notes_markdown: 'D: One thing' })
    const first = filed(await ingest(id))
    await processQueued(db, null)

    granola.script.notes[id] = {
      ...granola.script.notes[id]!,
      updated_at: '2026-10-01T17:00:00Z',
      private_notes_markdown: 'D: One thing\nD: And another',
    }
    const edited = filed(await ingest(id))

    expect(edited).toMatchObject({ via: 'note', changed: true, queued: true, noteId: first.noteId, meetingId: first.meetingId })
    expect(await db.select().from(notes)).toHaveLength(1)
    expect(await everyRun()).toHaveLength(2)

    // Only what is new is proposed the second time.
    await processQueued(db, null)
    const proposals = await listProposals(db, first.meetingId)
    expect(proposals.map((one) => (one.payload.type === 'item' ? one.payload.text : ''))).toEqual([
      'One thing',
      'And another',
    ])
  })

  it('stays on the meeting it was filed on, even after its folder is bound elsewhere', async () => {
    const { parish, diocese, granola, ingest, account } = await setUp()
    const id = noteId()
    granola.script.notes[id] = note({ id, folder_membership: [parishFolder] })
    const first = filed(await ingest(id))

    await bindFolder(db, { connectionId: account.id, folderId: PARISH, name: 'Parish', contextId: diocese.id })
    granola.script.notes[id] = { ...granola.script.notes[id]!, summary_markdown: 'We talked more.' }
    const again = filed(await ingest(id))

    expect(again.meetingId).toBe(first.meetingId)
    expect((await getMeeting(db, again.meetingId)).contextId).toBe(parish.id)
    expect(await listMeetings(db, { contextId: diocese.id })).toEqual([])
  })

  it('two arrivals of one new note at once make one meeting', async () => {
    const { granola, ingest } = await setUp()
    const id = noteId()
    granola.script.notes[id] = note({ id, folder_membership: [parishFolder] })

    const outcomes = await Promise.all([ingest(id), ingest(id)])

    expect(outcomes.every((outcome) => outcome.kind === 'filed')).toBe(true)
    expect(await everyMeeting()).toHaveLength(1)
    expect(await db.select().from(notes)).toHaveLength(1)
    expect(await everyRun()).toHaveLength(1)
  })

  it('two notes of one unprepped calendar event at once share one meeting', async () => {
    const { granola, ingest } = await setUp()
    const ids = [noteId(), noteId()]
    for (const id of ids) {
      granola.script.notes[id] = note({
        id,
        folder_membership: [parishFolder],
        calendar_event: {
          event_title: 'Staff',
          invitees: [],
          organiser: null,
          calendar_event_id: 'evt_twice',
          scheduled_start_time: '2026-10-01T15:00:00Z',
          scheduled_end_time: '2026-10-01T16:00:00Z',
        },
      })
    }

    const outcomes = (await Promise.all(ids.map((id) => ingest(id)))).map(filed)

    expect(outcomes[0]!.meetingId).toBe(outcomes[1]!.meetingId)
    expect(await everyMeeting()).toHaveLength(1)
    expect(await db.select().from(notes)).toHaveLength(2)
  })
})

describe('connecting', () => {
  it('proves the key, names the account, and keeps the secrets sealed', async () => {
    const granola = fakeGranola()
    const id = noteId()
    granola.script.notes[id] = note({ id, owner: { name: 'John', email: 'John@Example.test' } })

    const account = await connectGranola(db, `  ${TEST_KEY} `)

    expect(account).toMatchObject({ account: 'john@example.test', webhook: true, lastError: null })
    expect(granola.calls[0]).toBe('GET /v1/notes?page_size=1')
    expect(granola.count(/POST \/v1\/webhook-endpoints/)).toBe(1)
    expect(await signingSecrets(db)).toEqual([{ connectionId: account.id, secret: TEST_SECRET }])

    const [row] = await db.select().from(connections)
    expect(row!.credentials).not.toContain(TEST_KEY)
    expect(row!.credentials).not.toContain(TEST_SECRET)
    // Readers of connections never get the credentials at all.
    expect(JSON.stringify(await listConnections(db))).not.toContain('credentials')
  })

  it('refuses a key Granola does not accept, storing nothing', async () => {
    fakeGranola()
    await expect(connectGranola(db, 'grn_wrong')).rejects.toThrow(ValidationError)
    await expect(connectGranola(db, '   ')).rejects.toThrow(ValidationError)
    expect(await db.select().from(connections)).toEqual([])
  })

  it('connects without a webhook when Granola will not register one', async () => {
    fakeGranola({ signingSecret: null })
    const account = await connectGranola(db, TEST_KEY)
    expect(account.webhook).toBe(false)
    expect(await signingSecrets(db)).toEqual([])
  })

  it('the same account again replaces the key and keeps its folders and endpoint', async () => {
    const world = await makeWorld()
    const granola = fakeGranola()
    const first = await connect([{ folderId: PARISH, contextId: world.parish.id }])

    granola.script.key = 'grn_rotated'
    const again = await connectGranola(db, 'grn_rotated')

    expect(again.id).toBe(first.id)
    expect(await db.select().from(connections)).toHaveLength(1)
    expect(await listFolderBindings(db)).toHaveLength(1)
    expect(granola.count(/POST \/v1\/webhook-endpoints/)).toBe(1)
  })

  it('records a revoked key on the connection, and clears it when a call works again', async () => {
    const { granola, ingest, account } = await setUp()
    const id = noteId()
    granola.script.notes[id] = note({ id, folder_membership: [parishFolder] })

    granola.script.key = 'grn_other'
    await expect(ingest(id)).rejects.toThrow(/no longer accepts/)
    expect((await listGranolaAccounts(db))[0]!.lastError).toMatch(/no longer accepts/)

    granola.script.key = TEST_KEY
    await ingest(id)
    expect((await listGranolaAccounts(db)).find((one) => one.id === account.id)!.lastError).toBeNull()
  })

  it('disconnecting takes the endpoint and the folder bindings with it', async () => {
    const { granola, account } = await setUp()

    await disconnectGranola(db, account.id)

    expect(granola.count(/DELETE \/v1\/webhook-endpoints\/whe_2mKr8fQxLp7Ta3/)).toBe(1)
    expect(await db.select().from(connections)).toEqual([])
    expect(await listFolderBindings(db)).toEqual([])
  })

  it('the environment’s secret verifies for the one account that has none', async () => {
    fakeGranola({ signingSecret: null })
    const account = await connectGranola(db, TEST_KEY)
    process.env.GRANOLA_WEBHOOK_SECRET = TEST_SECRET
    try {
      expect(await signingSecrets(db)).toEqual([{ connectionId: account.id, secret: TEST_SECRET }])
      expect((await listGranolaAccounts(db))[0]!.webhook).toBe(true)
    } finally {
      delete process.env.GRANOLA_WEBHOOK_SECRET
    }
  })
})
