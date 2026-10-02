import { beforeEach, describe, expect, it } from 'vitest'
import { clearFeedCache, listEvents, listEventsIn, matchPeople } from '../lib/calendar/feed'
import { bindCalendar, getConnection, saveGoogleConnection } from '../lib/connect/connections'
import { users } from '../lib/db/schema'
import { createContext } from '../lib/directory/contexts'
import { createPerson } from '../lib/directory/people'
import { moveMeeting } from '../lib/meetings/move'
import { prepFromEvent } from '../lib/meetings/prep'
import { createSeries } from '../lib/meetings/series'
import { db, resetBetweenTests } from './helpers/db'
import { actor } from './helpers/fixtures'

resetBetweenTests()
/* The feed is cached by range, for every bound calendar at once, and each test
   binds its own. */
beforeEach(clearFeedCache)

const mockCalendarEvents: Array<{
  status?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  id?: string
  recurringEventId?: string
  summary?: string
  location?: string
  htmlLink?: string
  attendees?: Array<{
    email?: string
    self?: boolean
    responseStatus?: string
    displayName?: string
  }>
}> = [
  {
    id: 'event1',
    recurringEventId: undefined,
    summary: 'Team Meeting',
    start: { dateTime: '2026-10-15T10:00:00Z' },
    end: { dateTime: '2026-10-15T11:00:00Z' },
    status: 'confirmed',
    htmlLink: 'https://calendar.google.com/event1',
    attendees: [
      {
        email: 'john@example.com',
        displayName: 'John',
        self: true,
        responseStatus: 'accepted',
      },
      {
        email: 'sarah@example.com',
        displayName: 'Sarah',
        self: false,
        responseStatus: 'accepted',
      },
    ],
    location: 'Conference Room A',
  },
  {
    id: 'event2',
    recurringEventId: 'series1',
    summary: 'Weekly Standup',
    start: { dateTime: '2026-10-16T09:00:00Z' },
    end: { dateTime: '2026-10-16T09:30:00Z' },
    status: 'confirmed',
    htmlLink: 'https://calendar.google.com/event2',
    attendees: [
      { email: 'john@example.com', displayName: 'John', self: true, responseStatus: 'accepted' },
    ],
    location: undefined,
  },
  {
    id: 'event3_cancelled',
    recurringEventId: undefined,
    summary: 'Cancelled Event',
    start: { dateTime: '2026-10-17T10:00:00Z' },
    end: { dateTime: '2026-10-17T11:00:00Z' },
    status: 'cancelled',
    htmlLink: 'https://calendar.google.com/event3',
    attendees: [],
    location: undefined,
  },
  {
    id: 'event4_declined',
    recurringEventId: undefined,
    summary: 'Declined Event',
    start: { dateTime: '2026-10-18T10:00:00Z' },
    end: { dateTime: '2026-10-18T11:00:00Z' },
    status: 'confirmed',
    htmlLink: 'https://calendar.google.com/event4',
    attendees: [
      { email: 'john@example.com', displayName: 'John', self: true, responseStatus: 'declined' },
    ],
    location: undefined,
  },
]

describe('calendar feed', () => {
  it('lists events from bound calendars', async () => {
    const ctx = await createContext(db, { name: 'Work' })
    const conn = await saveGoogleConnection(db, {
      account: 'john@example.com',
      tokens: {
        accessToken: 'access',
        refreshToken: null,
        expiresAt: null,
      },
      scopes: ['calendar.readonly'],
    })

    await bindCalendar(db, {
      connectionId: conn.id,
      calendarId: 'john@google.com',
      name: 'John Calendar',
      contextId: ctx.id,
    })

    const events = await listEvents(
      db,
      {
        contextId: ctx.id,
        from: new Date('2026-10-01'),
        to: new Date('2026-10-31'),
      },
      {
        fetchEvents: async () => mockCalendarEvents,
      },
    )

    // Should include event1 and event2, skip cancelled and declined
    expect(events.length).toBeGreaterThan(0)
  })

  it('drops cancelled events', async () => {
    const ctx = await createContext(db, { name: 'Work' })
    const conn = await saveGoogleConnection(db, {
      account: 'john@example.com',
      tokens: {
        accessToken: 'access',
        refreshToken: null,
        expiresAt: null,
      },
      scopes: ['calendar.readonly'],
    })

    await bindCalendar(db, {
      connectionId: conn.id,
      calendarId: 'john@google.com',
      name: 'John Calendar',
      contextId: ctx.id,
    })

    const events = await listEvents(
      db,
      {
        contextId: ctx.id,
        from: new Date('2026-10-01'),
        to: new Date('2026-10-31'),
      },
      {
        fetchEvents: async () => mockCalendarEvents,
      },
    )

    const cancelled = events.find((e) => e.title === 'Cancelled Event')
    expect(cancelled).toBeUndefined()
  })

  it('drops events John declined', async () => {
    const ctx = await createContext(db, { name: 'Work' })
    const conn = await saveGoogleConnection(db, {
      account: 'john@example.com',
      tokens: {
        accessToken: 'access',
        refreshToken: null,
        expiresAt: null,
      },
      scopes: ['calendar.readonly'],
    })

    await bindCalendar(db, {
      connectionId: conn.id,
      calendarId: 'john@google.com',
      name: 'John Calendar',
      contextId: ctx.id,
    })

    const events = await listEvents(
      db,
      {
        contextId: ctx.id,
        from: new Date('2026-10-01'),
        to: new Date('2026-10-31'),
      },
      {
        fetchEvents: async () => mockCalendarEvents,
      },
    )

    const declined = events.find((e) => e.title === 'Declined Event')
    expect(declined).toBeUndefined()
  })

  it('sorts events by start time', async () => {
    const ctx = await createContext(db, { name: 'Work' })
    const conn = await saveGoogleConnection(db, {
      account: 'john@example.com',
      tokens: {
        accessToken: 'access',
        refreshToken: null,
        expiresAt: null,
      },
      scopes: ['calendar.readonly'],
    })

    await bindCalendar(db, {
      connectionId: conn.id,
      calendarId: 'john@google.com',
      name: 'John Calendar',
      contextId: ctx.id,
    })

    const events = await listEvents(
      db,
      {
        contextId: ctx.id,
        from: new Date('2026-10-01'),
        to: new Date('2026-10-31'),
      },
      {
        fetchEvents: async () => mockCalendarEvents,
      },
    )

    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.startsAt.getTime()).toBeGreaterThanOrEqual(
        events[i - 1]!.startsAt.getTime(),
      )
    }
  })

  it('handles missing calendars gracefully', async () => {
    const ctx = await createContext(db, { name: 'Work' })
    const conn = await saveGoogleConnection(db, {
      account: 'john@example.com',
      tokens: {
        accessToken: 'access',
        refreshToken: null,
        expiresAt: null,
      },
      scopes: ['calendar.readonly'],
    })

    await bindCalendar(db, {
      connectionId: conn.id,
      calendarId: 'cal1',
      name: 'Calendar 1',
      contextId: ctx.id,
    })

    await bindCalendar(db, {
      connectionId: conn.id,
      calendarId: 'cal2',
      name: 'Calendar 2',
      contextId: ctx.id,
    })

    let callCount = 0
    await listEvents(
      db,
      {
        contextId: ctx.id,
        from: new Date('2026-10-01'),
        to: new Date('2026-10-31'),
      },
      {
        fetchEvents: async (token, calendarId) => {
          callCount++
          if (calendarId === 'cal1') {
            throw new Error('Calendar 1 failed')
          }
          return mockCalendarEvents
        },
      },
    )

    // Should have fetched both calendars
    expect(callCount).toBe(2)
  })

  it('caches results for 2 minutes', async () => {
    const ctx = await createContext(db, { name: 'Work' })
    const conn = await saveGoogleConnection(db, {
      account: 'john@example.com',
      tokens: {
        accessToken: 'access',
        refreshToken: null,
        expiresAt: null,
      },
      scopes: ['calendar.readonly'],
    })

    await bindCalendar(db, {
      connectionId: conn.id,
      calendarId: 'john@google.com',
      name: 'John Calendar',
      contextId: ctx.id,
    })

    let callCount = 0
    const from = new Date('2026-10-01')
    const to = new Date('2026-10-31')

    await listEvents(
      db,
      { contextId: ctx.id, from, to },
      {
        fetchEvents: async () => {
          callCount++
          return mockCalendarEvents
        },
      },
    )

    await listEvents(
      db,
      { contextId: ctx.id, from, to },
      {
        fetchEvents: async () => {
          callCount++
          return mockCalendarEvents
        },
      },
    )

    // Second call should use cache
    expect(callCount).toBe(1)
  })

  it('clears cache', async () => {
    clearFeedCache()

    const ctx = await createContext(db, { name: 'Work' })
    const conn = await saveGoogleConnection(db, {
      account: 'john@example.com',
      tokens: {
        accessToken: 'access',
        refreshToken: null,
        expiresAt: null,
      },
      scopes: ['calendar.readonly'],
    })

    await bindCalendar(db, {
      connectionId: conn.id,
      calendarId: 'john@google.com',
      name: 'John Calendar',
      contextId: ctx.id,
    })

    let callCount = 0
    const from = new Date('2026-10-01')
    const to = new Date('2026-10-31')

    await listEvents(
      db,
      { contextId: ctx.id, from, to },
      {
        fetchEvents: async () => {
          callCount++
          return mockCalendarEvents
        },
      },
    )

    clearFeedCache()

    await listEvents(
      db,
      { contextId: ctx.id, from, to },
      {
        fetchEvents: async () => {
          callCount++
          return mockCalendarEvents
        },
      },
    )

    expect(callCount).toBe(2)
  })
})

describe('what Google actually sends', () => {
  const range = { from: new Date('2026-10-01'), to: new Date('2026-10-31') }

  async function bound(...calendarIds: string[]) {
    clearFeedCache()
    const ctx = await createContext(db, { name: 'Work' })
    const conn = await saveGoogleConnection(db, {
      account: 'john@example.com',
      tokens: { accessToken: 'access', refreshToken: null, expiresAt: null },
      scopes: ['calendar.readonly'],
    })
    for (const calendarId of calendarIds) {
      await bindCalendar(db, { connectionId: conn.id, calendarId, name: calendarId, contextId: ctx.id })
    }
    return { ctx, conn }
  }

  it('starts an all-day event at midnight where John is, not midnight UTC', async () => {
    const { ctx } = await bound('cal1')

    const [event] = await listEvents(
      db,
      { contextId: ctx.id, ...range, timeZone: 'America/Chicago' },
      {
        fetchEvents: async () => [
          { id: 'retreat', summary: 'Retreat', start: { date: '2026-10-05' }, end: { date: '2026-10-07' } },
        ],
      },
    )

    expect(event?.allDay).toBe(true)
    // Midnight in Chicago in October is 05:00 UTC; the end date is the day after the last.
    expect(event?.startsAt.toISOString()).toBe('2026-10-05T05:00:00.000Z')
    expect(event?.endsAt?.toISOString()).toBe('2026-10-07T05:00:00.000Z')
  })

  it("uses the user's own zone when the caller names none", async () => {
    const { ctx } = await bound('cal1')
    await db.insert(users).values({
      email: 'john@example.com',
      displayName: 'John',
      passwordHash: 'x',
      timeZone: 'Asia/Tokyo',
    })

    const [event] = await listEvents(
      db,
      { contextId: ctx.id, ...range },
      { fetchEvents: async () => [{ id: 'd', start: { date: '2026-10-05' }, end: { date: '2026-10-06' } }] },
    )
    expect(event?.startsAt.toISOString()).toBe('2026-10-04T15:00:00.000Z')
  })

  it('leaves out working locations, focus time, out-of-office and birthdays', async () => {
    const { ctx } = await bound('cal1')
    const at = { start: { dateTime: '2026-10-15T10:00:00Z' }, end: { dateTime: '2026-10-15T11:00:00Z' } }

    const events = await listEvents(
      db,
      { contextId: ctx.id, ...range },
      {
        fetchEvents: async () => [
          { id: 'home', eventType: 'workingLocation', summary: 'Home', ...at },
          { id: 'focus', eventType: 'focusTime', summary: 'Focus', ...at },
          { id: 'away', eventType: 'outOfOffice', summary: 'Away', ...at },
          { id: 'cake', eventType: 'birthday', summary: 'Birthday', ...at },
          { id: 'real', eventType: 'default', summary: 'Staff', ...at },
          { id: 'older-api', summary: 'No type', ...at },
        ],
      },
    )
    expect(events.map((event) => event.eventId).sort()).toEqual(['older-api', 'real'])
  })

  it('lists an event on two bound calendars once', async () => {
    const { ctx } = await bound('mine', 'shared')
    const event = {
      id: 'same-event',
      summary: 'Staff',
      start: { dateTime: '2026-10-15T10:00:00Z' },
      end: { dateTime: '2026-10-15T11:00:00Z' },
    }

    const events = await listEvents(db, { contextId: ctx.id, ...range }, { fetchEvents: async () => [event] })
    expect(events).toHaveLength(1)
  })

  it('skips an event with no id and leaves rooms out of the attendees', async () => {
    const { ctx } = await bound('cal1')
    const at = { start: { dateTime: '2026-10-15T10:00:00Z' }, end: { dateTime: '2026-10-15T11:00:00Z' } }

    const events = await listEvents(
      db,
      { contextId: ctx.id, ...range },
      {
        fetchEvents: async () => [
          { summary: 'No id', ...at },
          {
            id: 'e1',
            ...at,
            attendees: [
              { email: 'room@resource.calendar.google.com', resource: true, displayName: 'Hall' },
              { email: 'sarah@example.com', displayName: 'Sarah' },
            ],
          },
        ],
      },
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.attendees.map((attendee) => attendee.email)).toEqual(['sarah@example.com'])
  })

  it('does not cache a feed that is missing a calendar, and says which connection failed', async () => {
    const { ctx, conn } = await bound('good', 'bad')
    let fail = true
    const fetchEvents = async (_token: string, calendarId: string) => {
      if (calendarId === 'bad' && fail) throw new Error('Google Calendar refused bad: Not Found')
      return [
        {
          id: `${calendarId}-1`,
          start: { dateTime: '2026-10-15T10:00:00Z' },
          end: { dateTime: '2026-10-15T11:00:00Z' },
        },
      ]
    }

    expect(await listEvents(db, { contextId: ctx.id, ...range }, { fetchEvents })).toHaveLength(1)
    expect((await getConnection(db, conn.id)).lastError).toContain('Not Found')

    // The calendar is back: the next read asks again rather than serving the partial answer.
    fail = false
    expect(await listEvents(db, { contextId: ctx.id, ...range }, { fetchEvents })).toHaveLength(2)
    expect((await getConnection(db, conn.id)).lastError).toBeNull()
  })
})

describe('where an event belongs', () => {
  const range = { from: new Date('2026-10-01'), to: new Date('2026-10-31') }
  const at = (id: string, day: string, recurringEventId?: string) => ({
    id,
    recurringEventId,
    summary: id,
    start: { dateTime: `2026-10-${day}T10:00:00Z` },
    end: { dateTime: `2026-10-${day}T11:00:00Z` },
  })
  /* A work calendar holding a church meeting and a recurring event, a church
     calendar, and one event that is on both. */
  const calendars: Record<string, ReturnType<typeof at>[]> = {
    'work-cal': [at('standup', '12'), at('vestry', '13'), at('weekly-14', '14', 'rec-1'), at('shared', '15')],
    'church-cal': [at('choir', '12'), at('shared', '15')],
  }

  async function twoContexts() {
    const work = await createContext(db, { name: 'Work' })
    const church = await createContext(db, { name: 'Church' })
    const conn = await saveGoogleConnection(db, {
      account: 'john@example.com',
      tokens: { accessToken: 'access', refreshToken: null, expiresAt: null },
      scopes: ['calendar.readonly'],
    })
    await bindCalendar(db, { connectionId: conn.id, calendarId: 'work-cal', name: 'Work', contextId: work.id })
    await bindCalendar(db, { connectionId: conn.id, calendarId: 'church-cal', name: 'Church', contextId: church.id })

    let calls = 0
    const deps = {
      fetchEvents: async (_token: string, calendarId: string) => {
        calls++
        return calendars[calendarId] ?? []
      },
    }
    const inContext = async (contextId: string) =>
      (await listEventsIn(db, { contextId, ...range }, deps)).map((event) => event.eventId)
    const eventOf = async (contextId: string, eventId: string) =>
      (await listEventsIn(db, { contextId, ...range }, deps)).find((event) => event.eventId === eventId)!
    return { work, church, deps, inContext, eventOf, calls: () => calls }
  }

  it('is its calendar’s context until its meeting or its series lives elsewhere', async () => {
    const { work, church, deps, inContext, eventOf, calls } = await twoContexts()
    const now = new Date('2026-10-05T15:00:00Z')

    expect(await inContext(work.id)).toEqual(['standup', 'vestry', 'weekly-14', 'shared'])
    // An event on calendars of two contexts is offered in both until one preps it.
    expect(await inContext(church.id)).toEqual(['choir', 'shared'])
    // Both contexts are answered from one fetch of each calendar.
    expect(calls()).toBe(2)

    // The church meeting on the work calendar is prepped where it shows, then moved.
    const vestry = await prepFromEvent(
      db,
      actor,
      { contextId: work.id, event: await eventOf(work.id, 'vestry') },
      now,
    )
    expect(await inContext(work.id)).toContain('vestry')
    await moveMeeting(db, actor, vestry.id, church.id)
    expect(await inContext(work.id)).toEqual(['standup', 'weekly-14', 'shared'])
    expect(await inContext(church.id)).toEqual(['choir', 'vestry', 'shared'])
    // It is still the work calendar's event; only where it is listed changed.
    expect((await eventOf(church.id, 'vestry')).calendarId).toBe('work-cal')

    // A recurring event whose series lives in the other context follows the series.
    await createSeries(db, { contextId: church.id, name: 'Weekly', calendarSeriesId: 'rec-1' })
    expect(await inContext(work.id)).toEqual(['standup', 'shared'])
    expect(await inContext(church.id)).toEqual(['choir', 'vestry', 'weekly-14', 'shared'])

    // Once prepped, the shared event is in the one context its meeting is in.
    await prepFromEvent(db, actor, { contextId: work.id, event: await eventOf(work.id, 'shared') }, now)
    expect(await inContext(work.id)).toEqual(['standup', 'shared'])
    expect(await inContext(church.id)).toEqual(['choir', 'vestry', 'weekly-14'])

    // What each calendar holds is unchanged by any of it.
    const raw = await listEvents(db, { contextId: work.id, ...range }, deps)
    expect(raw.map((event) => event.eventId)).toEqual(['standup', 'vestry', 'weekly-14', 'shared'])
    expect(calls()).toBe(2)
  })

  it('lists nothing in two contexts once it has a meeting or a series', async () => {
    const { work, church, inContext, eventOf } = await twoContexts()
    const now = new Date('2026-10-05T15:00:00Z')
    for (const id of ['standup', 'vestry', 'shared']) {
      await prepFromEvent(db, actor, { contextId: work.id, event: await eventOf(work.id, id) }, now)
    }
    await createSeries(db, { contextId: church.id, name: 'Weekly', calendarSeriesId: 'rec-1' })

    const here = await inContext(work.id)
    const there = await inContext(church.id)
    expect(here.filter((id) => there.includes(id))).toEqual([])
    expect([...here, ...there].sort()).toEqual(['choir', 'shared', 'standup', 'vestry', 'weekly-14'])
  })
})

describe('matchPeople', () => {
  it('matches attendee emails to people case-insensitively', async () => {
    const sarah = await createPerson(db, { name: 'Sarah', email: 'Sarah@Example.com' })

    const matched = await matchPeople(db, [
      { email: 'sarah@example.com', name: 'Sarah', declined: false },
    ])

    expect(matched).toHaveLength(1)
    expect(matched[0]?.personId).toBe(sarah.id)
  })

  it('handles multiple attendees', async () => {
    const sarah = await createPerson(db, { name: 'Sarah', email: 'sarah@example.com' })
    const tom = await createPerson(db, { name: 'Tom', email: 'tom@example.com' })

    const matched = await matchPeople(db, [
      { email: 'sarah@example.com', name: 'Sarah', declined: false },
      { email: 'tom@example.com', name: 'Tom', declined: false },
    ])

    expect(matched).toHaveLength(2)
    expect(matched.map((m) => m.personId).sort()).toEqual([sarah.id, tom.id].sort())
  })

  it('skips people without matching emails', async () => {
    await createPerson(db, { name: 'Sarah', email: 'sarah@example.com' })

    const matched = await matchPeople(db, [
      { email: 'unknown@example.com', name: 'Unknown', declined: false },
    ])

    expect(matched).toHaveLength(0)
  })

  it('deduplicates people', async () => {
    const sarah = await createPerson(db, { name: 'Sarah', email: 'sarah@example.com' })

    const matched = await matchPeople(db, [
      { email: 'sarah@example.com', name: 'Sarah', declined: false },
      { email: 'sarah@example.com', name: 'Sarah', declined: false },
    ])

    expect(matched).toHaveLength(1)
    expect(matched[0]?.personId).toBe(sarah.id)
  })
})
