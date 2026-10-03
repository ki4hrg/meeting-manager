/*
 * Moving a meeting or a series to another context: what crosses, what is left
 * behind, and what the calendar feed shows afterwards. Each case asserts on
 * exact ids, since anything extra on the far side is a leak.
 */

import { eq, inArray } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { dismissCandidate, getCandidates, placeAutomatic, placeItem } from '../lib/agenda/candidates'
import { computeBlocks } from '../lib/agenda/generated'
import { addLine, addSection, getAgenda, moveLine } from '../lib/agenda/lines'
import type { CalendarEvent } from '../lib/calendar/feed'
import {
  agendaLines,
  itemEvents,
  items,
  meetingDismissals,
  meetingProjects,
  meetings,
  notes,
  processingRuns,
  proposals,
} from '../lib/db/schema'
import { createItem, getItem, listItems } from '../lib/items/items'
import {
  createMeeting,
  getMeeting,
  listMeetings,
  setMeetingProjects,
  updateMeeting,
} from '../lib/meetings/meetings'
import { moveMeeting, moveSeries } from '../lib/meetings/move'
import { listUpcoming, prepFromEvent } from '../lib/meetings/prep'
import { createSeries, getSeries, listSeries } from '../lib/meetings/series'
import { db, resetBetweenTests } from './helpers/db'
import { actor, makeWorld } from './helpers/fixtures'

resetBetweenTests()

type World = Awaited<ReturnType<typeof makeWorld>>

const NOW = new Date('2026-10-05T15:00:00Z')
const TODAY = '2026-10-05'

function event(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    calendarId: 'work-cal',
    eventId: 'evt-1',
    seriesId: null,
    title: 'Coffee with the bishop',
    startsAt: new Date('2026-10-07T15:00:00Z'),
    endsAt: new Date('2026-10-07T16:00:00Z'),
    allDay: false,
    attendees: [],
    location: null,
    htmlLink: null,
    ...over,
  }
}

const ids = (list: { id: string }[]) => list.map((one) => one.id).sort()

async function itemLines(meetingIds: string[]) {
  const rows = await db.select().from(agendaLines).where(inArray(agendaLines.meetingId, meetingIds))
  return rows.filter((row) => row.itemId !== null)
}

/* What is written on an agenda, in order, with the item behind each line. */
async function outline(meetingId: string) {
  const agenda = await getAgenda(db, meetingId)
  return agenda.nodes.map((node) =>
    node.type === 'section'
      ? { [node.title]: node.lines.map((line) => line.text) }
      : node.text,
  )
}

/*
 * A 1:1 with the bishop, prepped from an event on a calendar bound to the
 * parish, carrying everything a meeting can hold of its context.
 */
async function parishMeeting(w: World) {
  const withBishop = await createItem(db, actor, {
    contextId: w.parish.id,
    text: 'parish: raise with the bishop',
    parties: [{ personId: w.bishop.id, role: 'with' }],
  })
  const onRetreat = await createItem(db, actor, {
    contextId: w.parish.id,
    text: 'parish: retreat budget',
    projectId: w.retreat.id,
  })
  const turnedAway = await createItem(db, actor, {
    contextId: w.parish.id,
    text: 'parish: not this time',
    projectId: w.retreat.id,
  })
  // The same person is met in the diocese too.
  const dioceseItem = await createItem(db, actor, {
    contextId: w.diocese.id,
    text: 'diocese: raise with the bishop',
    parties: [{ personId: w.bishop.id, role: 'with' }],
  })

  const invite = event({
    attendees: [{ personId: w.bishop.id, email: 'bishop@example.test', name: 'Bishop', declined: false }],
  })
  const meeting = await prepFromEvent(db, actor, { contextId: w.parish.id, event: invite }, NOW)
  await setMeetingProjects(db, actor, meeting.id, [w.retreat.id])
  await updateMeeting(db, actor, meeting.id, { groupId: w.staff.id })
  // A one-off event with one invitee only suggests what is for him; it was taken.
  await placeItem(db, actor, meeting.id, withBishop.id)

  const aimed = await createItem(db, actor, {
    contextId: w.parish.id,
    text: 'parish: aimed at this meeting',
    target: { meetingId: meeting.id },
  })
  await placeAutomatic(db, actor, meeting.id, NOW)

  const opening = await addSection(db, actor, meeting.id, { title: 'Opening' })
  await addLine(db, actor, meeting.id, {
    text: 'Prayer',
    sectionId: opening,
    minutes: 5,
    privateNote: 'keep it short',
  })
  await addLine(db, actor, meeting.id, { text: 'Any other business' })
  // An item line between the typed ones, so taking it out leaves a gap to close.
  await placeItem(db, actor, meeting.id, onRetreat.id)
  const [placed] = await db.select().from(agendaLines).where(eq(agendaLines.itemId, onRetreat.id))
  await moveLine(db, actor, placed!.id, { sectionId: opening, position: 0 })
  await dismissCandidate(db, actor, meeting.id, turnedAway.id)

  return { meeting, invite, withBishop, onRetreat, turnedAway, aimed, dioceseItem }
}

async function pastedNote(meetingId: string) {
  const [note] = await db
    .insert(notes)
    .values({ meetingId, source: 'pasted', body: 'T: something', contentHash: 'hash-1' })
    .returning()
  const [run] = await db
    .insert(processingRuns)
    .values({ noteId: note!.id, contentHash: 'hash-1', status: 'done' })
    .returning()
  return { note: note!, run: run! }
}

async function proposal(
  meetingId: string,
  status: 'pending' | 'accepted' | 'rejected',
  from?: { noteId: string; runId: string },
) {
  const [row] = await db
    .insert(proposals)
    .values({
      meetingId,
      noteId: from?.noteId,
      runId: from?.runId,
      status,
      fingerprint: `fp-${status}`,
      payload: { type: 'item', kind: 'topic', text: `a ${status} proposal`, parties: [] },
    })
    .returning()
  return row!
}

describe('moving a meeting', () => {
  it('carries the meeting, its people, what was typed and its calendar ids, and leaves the context behind', async () => {
    const w = await makeWorld()
    const { meeting, withBishop, onRetreat, turnedAway, aimed } = await parishMeeting(w)
    expect(await itemLines([meeting.id])).toHaveLength(3)
    expect(await outline(meeting.id)).toEqual([
      'parish: raise with the bishop',
      'parish: aimed at this meeting',
      { Opening: ['parish: retreat budget', 'Prayer'] },
      'Any other business',
    ])

    const moved = await moveMeeting(db, actor, meeting.id, w.diocese.id)

    expect(moved).toMatchObject({
      id: meeting.id,
      contextId: w.diocese.id,
      title: 'Coffee with the bishop',
      startsAt: meeting.startsAt,
      endsAt: meeting.endsAt,
      calendarId: 'work-cal',
      calendarEventId: 'evt-1',
      people: [{ id: w.bishop.id, name: 'Bishop Wright' }],
      projects: [],
      groups: [],
      series: null,
    })

    // What was typed crosses whole, with its private note and timing, and closes up.
    expect(await outline(meeting.id)).toEqual([{ Opening: ['Prayer'] }, 'Any other business'])
    const rows = await db.select().from(agendaLines).where(eq(agendaLines.meetingId, meeting.id))
    expect(rows.every((row) => row.itemId === null)).toBe(true)
    const prayer = rows.find((row) => row.text === 'Prayer')!
    expect(prayer).toMatchObject({ privateNote: 'keep it short', minutes: 5, position: 0 })
    expect(rows.filter((row) => row.sectionId === null).map((row) => row.position).sort()).toEqual([0, 1])

    // Nothing that points into the parish is still attached.
    expect(await db.select().from(meetingProjects).where(eq(meetingProjects.meetingId, meeting.id))).toEqual([])
    expect(
      await db.select().from(meetingDismissals).where(eq(meetingDismissals.meetingId, meeting.id)),
    ).toEqual([])

    // The parish's items are where they were: open, in the parish, aimed nowhere.
    const left = await listItems(db, { contextId: w.parish.id, open: true })
    expect(ids(left)).toEqual(ids([withBishop, onRetreat, turnedAway, aimed]))
    expect(left.every((item) => item.targetMeetingId === null)).toBe(true)
    for (const item of [withBishop, onRetreat, turnedAway]) {
      const after = await getItem(db, item.id)
      expect(after.updatedAt).toEqual(item.updatedAt)
    }
    // The one that was aimed at it says in its history that it no longer is.
    const history = await db.select().from(itemEvents).where(eq(itemEvents.itemId, aimed.id))
    expect(history.at(-1)).toMatchObject({ type: 'targeted', data: { meetingId: null, seriesId: null } })
  })

  it('offers only the new context’s items afterwards, and is listed nowhere in the old one', async () => {
    const w = await makeWorld()
    const { meeting, dioceseItem } = await parishMeeting(w)
    const dioceseOwed = await createItem(db, actor, {
      contextId: w.diocese.id,
      kind: 'action',
      text: 'diocese: the bishop owes this',
      parties: [{ personId: w.bishop.id, role: 'owner' }],
    })
    await moveMeeting(db, actor, meeting.id, w.diocese.id)

    // Before the page is opened: every candidate is the diocese's.
    const before = await getCandidates(db, meeting.id, NOW)
    expect(before.toPlace).toEqual([])
    expect(ids(before.suggested.flatMap((group) => group.items))).toEqual(ids([dioceseItem, dioceseOwed]))
    expect(before.more).toEqual([])
    expect(before.dismissed).toEqual([])

    // Opening it places nothing of the parish; what is taken is the diocese's.
    expect(await placeAutomatic(db, actor, meeting.id, NOW)).toBe(0)
    await placeItem(db, actor, meeting.id, dioceseItem.id)
    const placed = await itemLines([meeting.id])
    expect(placed.map((row) => row.itemId)).toEqual([dioceseItem.id])
    const agenda = await getAgenda(db, meeting.id)
    const shown = agenda.nodes.flatMap((node) => (node.type === 'section' ? node.lines : [node]))
    expect(shown.flatMap((line) => (line.item ? [line.item.contextId] : []))).toEqual([w.diocese.id])

    // The blocks draw on the agenda, so they hold nothing of the parish either.
    const blocks = await computeBlocks(db, meeting.id, {
      today: TODAY,
      now: NOW,
      force: { followUps: true, sinceLast: true, lookahead: true },
    })
    const inBlocks = [
      ...(blocks.followUps ?? []).flatMap((entry) => entry.items.map((item) => item.itemId)),
      ...(blocks.lookahead?.deadlines ?? []).map((entry) => entry.itemId),
    ]
    expect(inBlocks.filter((id) => id !== dioceseItem.id && id !== dioceseOwed.id)).toEqual([])
    expect(blocks.lookahead?.milestones ?? []).toEqual([])

    // The parish: not in its meetings, nor on the person, project or group hub.
    for (const filter of [
      {},
      { personId: w.bishop.id },
      { projectId: w.retreat.id },
      { groupId: w.staff.id },
    ]) {
      expect(await listMeetings(db, { contextId: w.parish.id, ...filter })).toEqual([])
    }
    expect(ids(await listMeetings(db, { contextId: w.diocese.id, personId: w.bishop.id }))).toEqual([
      meeting.id,
    ])
  })

  it('is a no-op into the context it is already in, and works for a meeting made by hand', async () => {
    const w = await makeWorld()
    const stub = await createMeeting(db, actor, {
      contextId: w.parish.id,
      title: 'By hand',
      projectIds: [w.retreat.id],
    })
    const same = await moveMeeting(db, actor, stub.id, w.parish.id)
    expect(same.projects).toEqual([{ id: w.retreat.id, name: 'Retreat' }])

    const moved = await moveMeeting(db, actor, stub.id, w.diocese.id)
    expect(moved).toMatchObject({ contextId: w.diocese.id, projects: [], calendarEventId: null })
  })

  it('is refused once an item originates in it, and nothing is changed', async () => {
    const w = await makeWorld()
    const { meeting } = await parishMeeting(w)
    await createItem(db, actor, {
      contextId: w.parish.id,
      kind: 'decision',
      text: 'decided at the meeting',
      originMeetingId: meeting.id,
    })
    const before = await outline(meeting.id)

    await expect(moveMeeting(db, actor, meeting.id, w.diocese.id)).rejects.toThrow(
      'Coffee with the bishop has produced items here, and they do not move. It stays.',
    )
    const after = await getMeeting(db, meeting.id)
    expect(after).toMatchObject({ contextId: w.parish.id, groups: [{ id: w.staff.id }] })
    expect(after.projects).toHaveLength(1)
    expect(await outline(meeting.id)).toEqual(before)
  })

  it('is refused once a proposal was accepted', async () => {
    const w = await makeWorld()
    const meeting = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Logged' })
    const { note, run } = await pastedNote(meeting.id)
    await proposal(meeting.id, 'accepted', { noteId: note.id, runId: run.id })
    await proposal(meeting.id, 'pending', { noteId: note.id, runId: run.id })

    await expect(moveMeeting(db, actor, meeting.id, w.diocese.id)).rejects.toThrow(
      /Logged has accepted proposals here/,
    )
    expect(await db.select().from(proposals)).toHaveLength(2)
    expect(await db.select().from(processingRuns)).toHaveLength(1)
  })

  it('keeps the notes, drops the pending and rejected proposals, and queues the notes again', async () => {
    const w = await makeWorld()
    const meeting = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Logged' })
    const { note, run } = await pastedNote(meeting.id)
    await proposal(meeting.id, 'pending', { noteId: note.id, runId: run.id })
    await proposal(meeting.id, 'rejected', { noteId: note.id, runId: run.id })
    // Another meeting's processing is not this move's business.
    const other = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Other' })
    const kept = await pastedNote(other.id)
    await proposal(other.id, 'pending', { noteId: kept.note.id, runId: kept.run.id })

    await moveMeeting(db, actor, meeting.id, w.diocese.id)

    const left = await db.select().from(notes).where(eq(notes.meetingId, meeting.id))
    expect(left).toMatchObject([{ id: note.id, body: 'T: something', contentHash: 'hash-1' }])
    expect(await db.select().from(proposals).where(eq(proposals.meetingId, meeting.id))).toEqual([])
    // The old run is gone and a fresh one waits, to be read in the new context.
    const runs = await db.select().from(processingRuns).where(eq(processingRuns.noteId, note.id))
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ status: 'queued' })
    expect(runs[0]!.id).not.toBe(run.id)
    expect(await db.select().from(proposals).where(eq(proposals.meetingId, other.id))).toHaveLength(1)
    expect(await db.select().from(processingRuns).where(eq(processingRuns.noteId, kept.note.id))).toHaveLength(1)
  })
})

describe('sessions', () => {
  it('cannot move alone, and go with their meeting', async () => {
    const w = await makeWorld()
    const parent = await createMeeting(db, actor, {
      contextId: w.parish.id,
      title: 'Retreat',
      projectIds: [w.retreat.id],
    })
    const session = await createMeeting(db, actor, {
      contextId: w.parish.id,
      parentMeetingId: parent.id,
      title: 'Day one',
      personIds: [w.sarah.id],
      projectIds: [w.retreat.id],
      groupId: w.staff.id,
    })
    const item = await createItem(db, actor, {
      contextId: w.parish.id,
      text: 'for day one',
      target: { meetingId: session.id },
    })
    await placeAutomatic(db, actor, session.id, NOW)
    await addLine(db, actor, session.id, { text: 'Welcome' })

    await expect(moveMeeting(db, actor, session.id, w.diocese.id)).rejects.toThrow(
      'A session moves with its meeting. Move Retreat instead.',
    )
    expect((await getMeeting(db, session.id)).contextId).toBe(w.parish.id)

    const moved = await moveMeeting(db, actor, parent.id, w.diocese.id)
    expect(moved.sessions.map((one) => one.id)).toEqual([session.id])
    expect(await getMeeting(db, session.id)).toMatchObject({
      contextId: w.diocese.id,
      parentMeetingId: parent.id,
      people: [{ id: w.sarah.id }],
      projects: [],
      groups: [],
    })
    expect(await outline(session.id)).toEqual(['Welcome'])
    expect((await getItem(db, item.id)).targetMeetingId).toBeNull()
    expect(await listMeetings(db, { contextId: w.parish.id })).toEqual([])
  })

  it('hold their meeting back when an item originates in one of them', async () => {
    const w = await makeWorld()
    const parent = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Retreat' })
    const session = await createMeeting(db, actor, {
      contextId: w.parish.id,
      parentMeetingId: parent.id,
      title: 'Day one',
    })
    await createItem(db, actor, { contextId: w.parish.id, text: 'came up', originMeetingId: session.id })

    await expect(moveMeeting(db, actor, parent.id, w.diocese.id)).rejects.toThrow(/has produced items here/)
    expect((await getMeeting(db, session.id)).contextId).toBe(w.parish.id)
  })
})

/* A weekly 1:1 on the parish's calendar: one occurrence that has happened and
   produced an item, and the next one prepped. */
async function parishSeries(w: World) {
  const weekly = await createSeries(db, {
    contextId: w.parish.id,
    name: 'Bishop weekly',
    groupId: w.staff.id,
    personIds: [w.bishop.id],
    projectIds: [w.retreat.id],
    skeleton: [{ title: 'Standing', lines: [{ text: 'Diary', minutes: 5 }] }],
    blocks: { followUps: true, sinceLast: false, lookahead: false },
    calendarSeriesId: 'rec-1',
  })
  const last = await prepFromEvent(
    db,
    actor,
    {
      contextId: w.parish.id,
      event: event({
        eventId: 'occ-last',
        seriesId: 'rec-1',
        startsAt: new Date('2026-09-30T15:00:00Z'),
        endsAt: new Date('2026-09-30T16:00:00Z'),
      }),
    },
    NOW,
  )
  const produced = await createItem(db, actor, {
    contextId: w.parish.id,
    kind: 'action',
    text: 'from last week',
    originMeetingId: last.id,
  })
  const next = await prepFromEvent(
    db,
    actor,
    { contextId: w.parish.id, event: event({ eventId: 'occ-next', seriesId: 'rec-1' }) },
    NOW,
  )
  const forSeries = await createItem(db, actor, {
    contextId: w.parish.id,
    text: 'raise at the weekly',
    target: { seriesId: weekly.id },
  })
  await placeAutomatic(db, actor, next.id, NOW)
  return { weekly, last, next, produced, forSeries }
}

describe('moving a series', () => {
  it('takes the occurrences that can move and leaves the one with items behind, out of the series', async () => {
    const w = await makeWorld()
    const { weekly, last, next, produced, forSeries } = await parishSeries(w)
    expect((await itemLines([next.id])).map((row) => row.itemId)).toEqual([forSeries.id])

    const result = await moveSeries(db, actor, weekly.id, w.diocese.id)

    expect(result.series).toMatchObject({
      id: weekly.id,
      contextId: w.diocese.id,
      name: 'Bishop weekly',
      groups: [],
      projects: [],
      people: [{ id: w.bishop.id, name: 'Bishop Wright' }],
      skeleton: [{ title: 'Standing', lines: [{ text: 'Diary', minutes: 5 }] }],
      blocks: { followUps: true, sinceLast: false, lookahead: false },
      calendarSeriesId: 'rec-1',
    })
    expect(ids(result.moved)).toEqual([next.id])
    expect(ids(result.stayed)).toEqual([last.id])

    // The next occurrence is the diocese's and still the series'.
    expect(await getMeeting(db, next.id)).toMatchObject({
      contextId: w.diocese.id,
      series: { id: weekly.id },
      projects: [],
      calendarEventId: 'occ-next',
    })
    expect(await outline(next.id)).toEqual([{ Standing: ['Diary'] }])

    // The one that produced an item stays with it, and is nobody's occurrence.
    expect(await getMeeting(db, last.id)).toMatchObject({
      contextId: w.parish.id,
      series: null,
      projects: [{ id: w.retreat.id }],
    })
    expect(await getItem(db, produced.id)).toMatchObject({
      contextId: w.parish.id,
      originMeetingId: last.id,
    })

    // What was aimed at the series waits in the parish again.
    expect(await getItem(db, forSeries.id)).toMatchObject({
      contextId: w.parish.id,
      status: 'open',
      targetSeriesId: null,
    })
    expect(await listSeries(db, w.parish.id)).toEqual([])
    expect(ids(await listMeetings(db, { contextId: w.diocese.id, seriesId: weekly.id }))).toEqual([next.id])

    // "Since last time" has no parish occurrence to look back at.
    const blocks = await computeBlocks(db, next.id, {
      today: TODAY,
      now: NOW,
      force: { followUps: true, sinceLast: true, lookahead: true },
    })
    expect(blocks.sinceLast ?? null).toBeNull()
  })

  it('is refused when the name is taken where it is going, and is a no-op where it already is', async () => {
    const w = await makeWorld()
    const { weekly, next } = await parishSeries(w)
    await createSeries(db, { contextId: w.diocese.id, name: 'bishop WEEKLY' })

    await expect(moveSeries(db, actor, weekly.id, w.diocese.id)).rejects.toThrow(
      'There is already a series called Bishop weekly in Diocese.',
    )
    expect((await getSeries(db, weekly.id)).contextId).toBe(w.parish.id)
    expect((await getMeeting(db, next.id)).contextId).toBe(w.parish.id)

    const same = await moveSeries(db, actor, weekly.id, w.parish.id)
    expect(same).toMatchObject({ moved: [], stayed: [] })
    expect(same.series.projects).toHaveLength(1)
  })

  it('takes a session-bearing occurrence whole', async () => {
    const w = await makeWorld()
    const weekly = await createSeries(db, { contextId: w.parish.id, name: 'Synod days' })
    const parent = await createMeeting(db, actor, { contextId: w.parish.id, seriesId: weekly.id })
    const session = await createMeeting(db, actor, {
      contextId: w.parish.id,
      parentMeetingId: parent.id,
      title: 'Morning',
    })

    const result = await moveSeries(db, actor, weekly.id, w.diocese.id)
    expect(ids(result.moved)).toEqual([parent.id])
    const rows = await db.select().from(meetings).where(inArray(meetings.id, [parent.id, session.id]))
    expect(rows.map((row) => row.contextId)).toEqual([w.diocese.id, w.diocese.id])
  })
})

describe('the feed after a move', () => {
  const entriesOf = async (contextId: string, events: CalendarEvent[]) =>
    (await listUpcoming(db, contextId, { now: NOW, events })).entries.map((entry) => ({
      event: entry.event?.eventId ?? null,
      meeting: entry.meeting?.id ?? null,
      series: entry.series?.id ?? null,
    }))

  it('shows a moved meeting’s event where the meeting lives, and does not offer it again where it came from', async () => {
    const w = await makeWorld()
    const { meeting, invite } = await parishMeeting(w)
    expect(await entriesOf(w.parish.id, [invite])).toEqual([
      { event: 'evt-1', meeting: meeting.id, series: null },
    ])

    await moveMeeting(db, actor, meeting.id, w.diocese.id)

    expect(await entriesOf(w.parish.id, [invite])).toEqual([])
    expect(await entriesOf(w.diocese.id, [invite])).toEqual([
      { event: 'evt-1', meeting: meeting.id, series: null },
    ])
    // Pressed from a stale page in the parish, Prep finds the one meeting and makes no second.
    const again = await prepFromEvent(db, actor, { contextId: w.parish.id, event: invite }, NOW)
    expect(again.id).toBe(meeting.id)
    expect(await db.select().from(meetings)).toHaveLength(1)
  })

  it('shows the next occurrences of a moved series in its new context, and preps them there', async () => {
    const w = await makeWorld()
    const { weekly, last, next } = await parishSeries(w)
    await moveSeries(db, actor, weekly.id, w.diocese.id)

    const stayed = event({
      eventId: 'occ-last',
      seriesId: 'rec-1',
      startsAt: new Date('2026-10-05T15:30:00Z'),
    })
    const prepped = event({ eventId: 'occ-next', seriesId: 'rec-1' })
    const unprepped = event({
      eventId: 'occ-after',
      seriesId: 'rec-1',
      startsAt: new Date('2026-10-14T15:00:00Z'),
      endsAt: new Date('2026-10-14T16:00:00Z'),
    })
    const feed = [stayed, prepped, unprepped]

    // The parish keeps only the meeting that stayed; its event is not the series' any more.
    await db.update(meetings).set({ startsAt: stayed.startsAt, endsAt: null }).where(eq(meetings.id, last.id))
    expect(await entriesOf(w.parish.id, feed)).toEqual([
      { event: 'occ-last', meeting: last.id, series: null },
    ])
    expect(await entriesOf(w.diocese.id, feed)).toEqual([
      { event: 'occ-next', meeting: next.id, series: weekly.id },
      { event: 'occ-after', meeting: null, series: weekly.id },
    ])

    // Prepping the next one, even from the parish, makes it the diocese's.
    const made = await prepFromEvent(db, actor, { contextId: w.parish.id, event: unprepped }, NOW)
    expect(made).toMatchObject({
      contextId: w.diocese.id,
      series: { id: weekly.id },
      people: [{ id: w.bishop.id }],
    })
    expect(await outline(made.id)).toEqual([{ Standing: ['Diary'] }])
    const none = await db.select().from(items).where(eq(items.targetMeetingId, made.id))
    expect(none).toEqual([])
    expect((await entriesOf(w.diocese.id, feed)).map((entry) => entry.meeting)).toEqual([next.id, made.id])
    expect(await entriesOf(w.parish.id, feed)).toHaveLength(1)
  })
})
