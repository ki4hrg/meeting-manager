/* Prepping: a person, a series or a calendar event becomes a meeting with its agenda started. */

import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { getCandidates, placeAutomatic } from '../lib/agenda/candidates'
import { getAgenda } from '../lib/agenda/lines'
import type { CalendarEvent } from '../lib/calendar/feed'
import { agendaLines, meetings } from '../lib/db/schema'
import { createItem } from '../lib/items/items'
import { createMeeting, getMeeting, listMeetings, updateMeeting } from '../lib/meetings/meetings'
import { moveMeeting } from '../lib/meetings/move'
import {
  attachStub,
  cadenceOf,
  listPast,
  listUpcoming,
  prepFromEvent,
  prepNextInSeries,
  prepWithGroup,
  prepWithPerson,
  seriesFromEvent,
} from '../lib/meetings/prep'
import { createSeries } from '../lib/meetings/series'
import { db, resetBetweenTests } from './helpers/db'
import { actor, makeWorld } from './helpers/fixtures'

resetBetweenTests()

const NOW = new Date('2026-10-05T15:00:00Z')

function event(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    calendarId: 'cal-1',
    eventId: 'evt-1',
    seriesId: null,
    title: 'Coffee',
    startsAt: new Date('2026-10-07T15:00:00Z'),
    endsAt: new Date('2026-10-07T16:00:00Z'),
    allDay: false,
    attendees: [],
    location: null,
    htmlLink: null,
    ...over,
  }
}

async function addLineTo(meetingId: string, text: string) {
  await db.insert(agendaLines).values({ meetingId, text })
}

function itemTexts(agenda: Awaited<ReturnType<typeof getAgenda>>): string[] {
  return agenda.nodes.flatMap((node) =>
    node.type === 'section' ? node.lines.map((line) => line.text) : [node.text],
  )
}

describe('the sporadic meeting', () => {
  it('places six items saved up for one person, and attaches to its event without a duplicate', async () => {
    const w = await makeWorld()
    for (let n = 0; n < 6; n++) {
      await createItem(db, actor, {
        contextId: w.parish.id,
        text: `ask the bishop ${n}`,
        projectId: n % 2 ? w.retreat.id : w.campaign.id,
        parties: [{ personId: w.bishop.id, role: 'with' }],
      })
    }
    // Another context's item for the same person stays where it is.
    await createItem(db, actor, {
      contextId: w.diocese.id,
      text: 'diocesan matter',
      parties: [{ personId: w.bishop.id, role: 'with' }],
    })

    const stub = await prepWithPerson(db, actor, { contextId: w.parish.id, personId: w.bishop.id }, NOW)
    expect(stub.startsAt).toBeNull()
    expect(stub.title).toBe('Bishop Wright')
    const texts = itemTexts(await getAgenda(db, stub.id))
    expect(texts).toHaveLength(6)
    expect(texts).not.toContain('diocesan matter')

    // Asking again returns the same stub and picks up what was captured since.
    await createItem(db, actor, {
      contextId: w.parish.id,
      text: 'one more',
      parties: [{ personId: w.bishop.id, role: 'with' }],
    })
    const again = await prepWithPerson(db, actor, { contextId: w.parish.id, personId: w.bishop.id }, NOW)
    expect(again.id).toBe(stub.id)
    expect(itemTexts(await getAgenda(db, stub.id))).toHaveLength(7)

    // The event appears on the calendar; the stub is offered for it.
    const invite = event({
      attendees: [{ personId: w.bishop.id, email: 'bishop@example.test', name: null, declined: false }],
    })
    const upcoming = await listUpcoming(db, w.parish.id, { now: NOW, events: [invite] })
    expect(upcoming.entries).toHaveLength(1)
    expect(upcoming.entries[0]!.meeting).toBeNull()
    expect(upcoming.entries[0]!.stubs.map((s) => s.id)).toEqual([stub.id])

    const attached = await attachStub(db, actor, stub.id, invite, NOW)
    expect(attached.id).toBe(stub.id)
    expect(attached.startsAt).toEqual(invite.startsAt)
    expect(await db.select().from(meetings)).toHaveLength(1)
    expect(await db.select().from(agendaLines).where(eq(agendaLines.meetingId, stub.id))).toHaveLength(7)

    // Prepping the event now finds that meeting rather than making another.
    const found = await prepFromEvent(db, actor, { contextId: w.parish.id, event: invite }, NOW)
    expect(found.id).toBe(stub.id)
    expect(await db.select().from(meetings)).toHaveLength(1)

    const after = await listUpcoming(db, w.parish.id, { now: NOW, events: [invite] })
    expect(after.entries).toHaveLength(1)
    expect(after.entries[0]!.meeting?.id).toBe(stub.id)
    expect(after.stubs).toHaveLength(0)
  })

  it('refuses a meeting with yourself', async () => {
    const w = await makeWorld()
    await expect(
      prepWithPerson(db, actor, { contextId: w.parish.id, personId: w.john.id }),
    ).rejects.toThrow(/other than yourself/)
  })
})

describe('a meeting with a group', () => {
  it('makes one stub with the members as its roster, and offers what waits for the group', async () => {
    const w = await makeWorld()
    await createItem(db, actor, {
      contextId: w.parish.id,
      text: 'for the staff',
      parties: [{ groupId: w.staff.id, role: 'with' }],
    })

    const stub = await prepWithGroup(db, actor, { contextId: w.parish.id, groupId: w.staff.id }, NOW)
    expect(stub.title).toBe('Staff')
    // The group stands for its members.
    expect(stub.people).toEqual([])
    expect(stub.attendees.map((person) => person.name)).toEqual(['Sarah Jones', 'Tom Baker'])
    // By the candidate rules a group match is suggested, never placed unasked.
    expect(itemTexts(await getAgenda(db, stub.id))).toEqual([])
    const { suggested } = await getCandidates(db, stub.id, NOW)
    expect(suggested.map((group) => group.items.map((item) => item.text))).toEqual([['for the staff']])

    const again = await prepWithGroup(db, actor, { contextId: w.parish.id, groupId: w.staff.id }, NOW)
    expect(again.id).toBe(stub.id)
  })
})

describe('the routine 1:1', () => {
  it('lays down the skeleton, places what is aimed at the series, and uses the roster when the event names nobody', async () => {
    const w = await makeWorld()
    const recurring = event({ eventId: 'evt-oct7', seriesId: 'rec-1', title: 'Sarah 1:1' })
    const series = await seriesFromEvent(db, { contextId: w.parish.id, event: recurring })
    expect(series.calendarSeriesId).toBe('rec-1')
    expect((await seriesFromEvent(db, { contextId: w.parish.id, event: recurring })).id).toBe(series.id)

    const { setSeriesPeople, updateSeries } = await import('../lib/meetings/series')
    await setSeriesPeople(db, series.id, [w.sarah.id])
    await updateSeries(db, series.id, {
      skeleton: [{ title: 'Check-in', lines: [{ text: 'How are things', minutes: 5 }] }],
    })

    await createItem(db, actor, {
      contextId: w.parish.id,
      text: 'raise with sarah',
      parties: [{ personId: w.sarah.id, role: 'with' }],
    })
    await createItem(db, actor, {
      contextId: w.parish.id,
      text: 'for the series',
      target: { seriesId: series.id },
    })

    const meeting = await prepFromEvent(db, actor, { contextId: w.parish.id, event: recurring }, NOW)
    expect(meeting.series?.id).toBe(series.id)
    expect(meeting.people.map((p) => p.id)).toEqual([w.sarah.id])

    const agenda = await getAgenda(db, meeting.id)
    expect(agenda.nodes[0]).toMatchObject({ type: 'section', title: 'Check-in' })
    expect(itemTexts(agenda)).toEqual(['How are things', 'for the series'])
    // What is for her alone waits as a suggestion.
    const { suggested } = await getCandidates(db, meeting.id, NOW)
    expect(suggested.flatMap((group) => group.items.map((item) => item.text))).toEqual(['raise with sarah'])
  })

  it('a series made from one occurrence adopts the occurrences already prepped', async () => {
    const w = await makeWorld()
    const on = (eventId: string, day: string, seriesId = 'rec-7') =>
      event({
        eventId,
        seriesId,
        title: 'Tom 1:1',
        startsAt: new Date(`2026-10-${day}T15:00:00Z`),
        endsAt: new Date(`2026-10-${day}T16:00:00Z`),
        attendees: [{ personId: w.tom.id, email: 'tom@example.test', name: 'Tom', declined: false }],
      })
    const first = on('occ-06', '06')
    const second = on('occ-13', '13')
    const third = on('occ-20', '20')
    const unrelated = on('other-13', '13', 'rec-8')
    const feed = [first, second, third, unrelated]
    const labels = async () =>
      (await listUpcoming(db, w.parish.id, { now: NOW, events: feed })).entries.map((entry) => [
        entry.event?.eventId,
        entry.series?.name ?? null,
      ])

    // The second occurrence is prepped before there is a series to belong to.
    const early = await prepFromEvent(db, actor, { contextId: w.parish.id, event: second }, NOW)
    expect(early.series).toBeNull()
    await addLineTo(early.id, 'already typed')
    // Not this recurring event's, and not this context's: neither joins.
    const other = await prepFromEvent(db, actor, { contextId: w.parish.id, event: unrelated }, NOW)
    const away = await prepFromEvent(db, actor, { contextId: w.parish.id, event: third }, NOW)
    await moveMeeting(db, actor, away.id, w.diocese.id)

    const series = await seriesFromEvent(db, {
      contextId: w.parish.id,
      event: first,
      occurrences: feed,
    })
    expect(series.contextId).toBe(w.parish.id)

    // It joins as it is: same people, same agenda, nothing laid over it.
    const adopted = await getMeeting(db, early.id)
    expect(adopted.series).toEqual({ id: series.id, name: 'Tom 1:1' })
    expect(adopted.people.map((person) => person.id)).toEqual([w.tom.id])
    expect(itemTexts(await getAgenda(db, early.id))).toEqual(['already typed'])
    expect((await getMeeting(db, other.id)).series).toBeNull()
    expect(await getMeeting(db, away.id)).toMatchObject({ contextId: w.diocese.id, series: null })

    // The list says what the rows say.
    expect(await labels()).toEqual([
      ['occ-06', 'Tom 1:1'],
      ['occ-13', 'Tom 1:1'],
      ['other-13', null],
    ])
    await updateMeeting(db, actor, early.id, { seriesId: null })
    expect(await labels()).toEqual([
      ['occ-06', 'Tom 1:1'],
      ['occ-13', null],
      ['other-13', null],
    ])
    // Asked again, the series is found rather than made, and the meeting rejoins.
    const again = await seriesFromEvent(db, { contextId: w.parish.id, event: first, occurrences: feed })
    expect(again.id).toBe(series.id)
    expect((await getMeeting(db, early.id)).series?.id).toBe(series.id)

    // An item for the series still goes to the next occurrence only.
    await createItem(db, actor, {
      contextId: w.parish.id,
      text: 'for the series',
      target: { seriesId: series.id },
    })
    const next = await prepFromEvent(db, actor, { contextId: w.parish.id, event: first }, NOW)
    expect(next.series?.id).toBe(series.id)
    expect(itemTexts(await getAgenda(db, next.id))).toEqual(['for the series'])
    expect(await placeAutomatic(db, actor, early.id, NOW)).toBe(0)
    expect(itemTexts(await getAgenda(db, early.id))).toEqual(['already typed'])
  })

  it('prepNextInSeries returns the occurrence already waiting', async () => {
    const w = await makeWorld()
    const series = await createSeries(db, { contextId: w.parish.id, name: 'Staff', groupId: w.staff.id })
    const first = await prepNextInSeries(db, actor, series.id, NOW)
    const second = await prepNextInSeries(db, actor, series.id, NOW)
    expect(second.id).toBe(first.id)
    expect(await listMeetings(db, { contextId: w.parish.id, seriesId: series.id })).toHaveLength(1)
  })
})

describe('listUpcoming', () => {
  it('lists a recurring event where its series lives and never offers a stub to an event with strangers only', async () => {
    const w = await makeWorld()
    await createSeries(db, { contextId: w.diocese.id, name: 'Council', calendarSeriesId: 'rec-9' })
    await prepWithPerson(db, actor, { contextId: w.parish.id, personId: w.tom.id }, NOW)

    const events = [
      event({ eventId: 'council', seriesId: 'rec-9' }),
      event({ eventId: 'coffee' }),
      event({ eventId: 'all-day', allDay: true }),
    ]
    const upcoming = await listUpcoming(db, w.parish.id, { now: NOW, events })
    // The series is the diocese's, so its occurrence is listed there and not here.
    expect(upcoming.entries.map((entry) => entry.event?.eventId)).toEqual(['coffee'])
    expect(upcoming.entries[0]!.series).toBeNull()
    expect(upcoming.entries[0]!.stubs).toHaveLength(0)
    const elsewhere = await listUpcoming(db, w.diocese.id, { now: NOW, events })
    expect(elsewhere.entries.map((entry) => [entry.event?.eventId, entry.series?.name])).toContainEqual([
      'council',
      'Council',
    ])
    expect(upcoming.stubs).toHaveLength(1)
  })
})

describe('the reach of the meetings lists', () => {
  it('a window that starts ahead lists only what falls in it', async () => {
    const w = await makeWorld()
    const soon = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Soon', startsAt: new Date('2026-10-06T15:00:00Z') })
    const far = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Far', startsAt: new Date('2026-11-20T15:00:00Z') })
    const farEvent = event({ eventId: 'evt-far', startsAt: new Date('2026-11-21T15:00:00Z'), endsAt: new Date('2026-11-21T16:00:00Z') })

    const near = await listUpcoming(db, w.parish.id, { now: NOW, events: [] })
    expect(near.entries.map((entry) => entry.meeting?.id)).toEqual([soon.id])

    const jumped = await listUpcoming(db, w.parish.id, { now: NOW, from: new Date('2026-11-15T06:00:00Z'), events: [farEvent] })
    expect(jumped.entries.map((entry) => entry.meeting?.id ?? entry.event?.eventId)).toEqual([far.id, 'evt-far'])

    const reached = await listUpcoming(db, w.parish.id, { now: NOW, days: 60, events: [] })
    expect(reached.entries.map((entry) => entry.meeting?.id)).toEqual([soon.id, far.id])
  })

  it('the past lists what was held and the events nobody prepped, latest first', async () => {
    const w = await makeWorld()
    const held = await createMeeting(db, actor, {
      contextId: w.parish.id,
      title: 'Held',
      startsAt: new Date('2026-10-01T15:00:00Z'),
      calendarId: 'cal-1',
      calendarEventId: 'evt-held',
    })
    await createMeeting(db, actor, { contextId: w.parish.id, title: 'Long ago', startsAt: new Date('2026-08-01T15:00:00Z') })
    const missed = event({ eventId: 'evt-missed', startsAt: new Date('2026-10-02T15:00:00Z'), endsAt: new Date('2026-10-02T16:00:00Z') })
    const heldEvent = event({ eventId: 'evt-held', startsAt: new Date('2026-10-01T15:00:00Z'), endsAt: new Date('2026-10-01T16:00:00Z') })

    const past = await listPast(db, w.parish.id, { now: NOW, events: [missed, heldEvent] })
    expect(past.entries.map((entry) => entry.meeting?.id ?? entry.event?.eventId)).toEqual(['evt-missed', held.id])

    const earlier = await listPast(db, w.parish.id, { now: NOW, before: new Date('2026-08-10T00:00:00Z'), events: [] })
    expect(earlier.entries.map((entry) => entry.meeting?.title)).toEqual(['Long ago'])

    // A missed event can still be given its meeting, to log its notes against.
    const made = await prepFromEvent(db, actor, { contextId: w.parish.id, event: missed }, NOW)
    expect(made.startsAt).toEqual(missed.startsAt)
  })
})

describe('a series and its calendar', () => {
  it('a meeting made by hand at the time of its event is offered on the event, not listed beside it', async () => {
    const w = await makeWorld()
    const byHand = await createMeeting(db, actor, {
      contextId: w.parish.id,
      title: 'Adlene/John Check-In',
      startsAt: new Date('2026-10-13T15:00:00Z'),
    })
    const other = await createMeeting(db, actor, {
      contextId: w.parish.id,
      title: 'Something else',
      startsAt: new Date('2026-10-13T15:30:00Z'),
    })
    const occurrence = event({
      eventId: 'evt-13',
      seriesId: 'rec-1',
      title: 'Adlene/John Check-In',
      startsAt: new Date('2026-10-13T15:00:00Z'),
      endsAt: new Date('2026-10-13T16:00:00Z'),
    })
    const { entries } = await listUpcoming(db, w.parish.id, { now: NOW, events: [occurrence] })
    expect(entries.map((entry) => entry.event?.eventId ?? entry.meeting?.id)).toEqual(['evt-13', other.id])
    expect(entries[0]!.stubs.map((stub) => stub.id)).toEqual([byHand.id])

    // Linking keeps the one meeting, with the event's time and series.
    const series = await createSeries(db, {
      contextId: w.parish.id,
      name: 'Check-in',
      personIds: [w.sarah.id],
      calendarSeriesId: 'rec-1',
    })
    const linked = await attachStub(db, actor, byHand.id, occurrence, NOW)
    expect(linked).toMatchObject({ id: byHand.id, calendarEventId: 'evt-13', series: { id: series.id } })
    // Newly in the series, it takes its roster.
    expect(linked.people.map((person) => person.id)).toEqual([w.sarah.id])
  })

  it('reads how often a recurring event comes round', () => {
    const at = (iso: string) => event({ startsAt: new Date(iso) })
    expect(cadenceOf([at('2026-10-06T15:00:00Z'), at('2026-10-13T15:00:00Z'), at('2026-10-20T15:00:00Z')])).toBe('weekly')
    expect(cadenceOf([at('2026-10-06T15:00:00Z'), at('2026-10-20T15:00:00Z')])).toBe('every 2 weeks')
    expect(cadenceOf([at('2026-10-06T15:00:00Z'), at('2026-11-06T16:00:00Z'), at('2026-12-06T16:00:00Z')])).toBe('monthly')
    expect(cadenceOf([at('2026-10-06T15:00:00Z'), at('2026-10-09T15:00:00Z'), at('2026-10-20T15:00:00Z')])).toBeNull()
    expect(cadenceOf([at('2026-10-06T15:00:00Z')])).toBeNull()
  })
})
