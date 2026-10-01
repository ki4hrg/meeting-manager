/* Prepping: a person, a series or a calendar event becomes a meeting with its agenda started. */

import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { getCandidates } from '../lib/agenda/candidates'
import { getAgenda } from '../lib/agenda/lines'
import type { CalendarEvent } from '../lib/calendar/feed'
import { agendaLines, meetings } from '../lib/db/schema'
import { createItem } from '../lib/items/items'
import { listMeetings } from '../lib/meetings/meetings'
import {
  attachStub,
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
    expect(stub.people.map((person) => person.name)).toEqual(['Sarah Jones', 'Tom Baker'])
    // By the candidate rules a group match is suggested, never placed unasked.
    expect(itemTexts(await getAgenda(db, stub.id))).toEqual([])
    const { suggested } = await getCandidates(db, stub.id, NOW)
    expect(suggested.map((group) => group.items.map((item) => item.text))).toEqual([['for the staff']])

    const again = await prepWithGroup(db, actor, { contextId: w.parish.id, groupId: w.staff.id }, NOW)
    expect(again.id).toBe(stub.id)
  })
})

describe('the routine 1:1', () => {
  it('lays down the skeleton, places person items, and uses the roster when the event names nobody', async () => {
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
    expect(itemTexts(agenda)).toEqual(
      expect.arrayContaining(['How are things', 'raise with sarah', 'for the series']),
    )
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
  it('ignores a series from another context and never offers a stub to an event with strangers only', async () => {
    const w = await makeWorld()
    await createSeries(db, { contextId: w.diocese.id, name: 'Council', calendarSeriesId: 'rec-9' })
    await prepWithPerson(db, actor, { contextId: w.parish.id, personId: w.tom.id }, NOW)

    const upcoming = await listUpcoming(db, w.parish.id, {
      now: NOW,
      events: [event({ seriesId: 'rec-9' }), event({ eventId: 'all-day', allDay: true })],
    })
    expect(upcoming.entries).toHaveLength(1)
    expect(upcoming.entries[0]!.series).toBeNull()
    expect(upcoming.entries[0]!.stubs).toHaveLength(0)
    expect(upcoming.stubs).toHaveLength(1)
  })
})
