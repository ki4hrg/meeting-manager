import { describe, expect, it } from 'vitest'
import type { CalendarEvent } from '../lib/calendar/feed'
import { addGroupEmail } from '../lib/directory/groups'
import { hubPast, hubUpcoming } from '../lib/meetings/hub'
import { createMeeting } from '../lib/meetings/meetings'
import { prepFromEvent } from '../lib/meetings/prep'
import { createSeries } from '../lib/meetings/series'
import { createProject } from '../lib/projects/projects'
import { db, resetBetweenTests } from './helpers/db'
import { actor, makeWorld } from './helpers/fixtures'

resetBetweenTests()

const NOW = new Date('2026-10-05T15:00:00Z')
const at = (iso: string) => new Date(iso)

function event(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    calendarId: 'cal-1',
    eventId: 'evt-1',
    seriesId: null,
    title: 'Coffee',
    startsAt: at('2026-10-07T15:00:00Z'),
    endsAt: at('2026-10-07T16:00:00Z'),
    allDay: false,
    attendees: [],
    location: null,
    htmlLink: null,
    ...over,
  }
}

const titles = (entries: { meeting: { title: string } | null; event: CalendarEvent | null }[]) =>
  entries.map((entry) => entry.meeting?.title ?? entry.event!.title)

describe('a hub reaches its calendar', () => {
  it("lists a series' meetings and the occurrences not yet prepped, then later, stubs and the past", async () => {
    const w = await makeWorld()
    const staff = await createSeries(db, { contextId: w.parish.id, name: 'Staff', calendarSeriesId: 'rec-1' })
    const events = [
      event({ eventId: 'occ-1', seriesId: 'rec-1', title: 'Staff (cal)' }),
      event({ eventId: 'other', title: 'Lunch', startsAt: at('2026-10-08T15:00:00Z'), endsAt: at('2026-10-08T16:00:00Z') }),
    ]
    await createMeeting(db, actor, { contextId: w.parish.id, seriesId: staff.id, title: 'Staff by hand', startsAt: at('2026-10-09T15:00:00Z'), endsAt: at('2026-10-09T16:00:00Z') })
    await createMeeting(db, actor, { contextId: w.parish.id, seriesId: staff.id, title: 'Staff in December', startsAt: at('2026-12-01T15:00:00Z'), endsAt: at('2026-12-01T16:00:00Z') })
    await createMeeting(db, actor, { contextId: w.parish.id, seriesId: staff.id, title: 'Staff stub' })
    await createMeeting(db, actor, { contextId: w.parish.id, seriesId: staff.id, title: 'Staff last week', startsAt: at('2026-09-28T15:00:00Z'), endsAt: at('2026-09-28T16:00:00Z') })
    await createMeeting(db, actor, { contextId: w.parish.id, title: 'Not the series', startsAt: at('2026-10-06T15:00:00Z'), endsAt: at('2026-10-06T16:00:00Z') })

    const hub = { kind: 'series', id: staff.id } as const
    const ahead = await hubUpcoming(db, w.parish.id, hub, { now: NOW, events })
    expect(titles(ahead.entries)).toEqual(['Staff (cal)', 'Staff by hand'])
    expect(ahead.later.map((m) => m.title)).toEqual(['Staff in December'])
    expect(ahead.stubs.map((m) => m.title)).toEqual(['Staff stub'])

    // Further ahead, December comes into the window.
    const further = await hubUpcoming(db, w.parish.id, hub, { now: NOW, days: 90, events })
    expect(titles(further.entries)).toContain('Staff in December')
    expect(further.later).toEqual([])

    expect((await hubPast(db, w.parish.id, hub, { now: NOW, limit: 9 })).meetings.map((m) => m.title)).toEqual([
      'Staff last week',
    ])
  })

  it("shows an event on a group's hub when its list address is on the invite, and on a project's when its calendar is bound there", async () => {
    const w = await makeWorld()
    await addGroupEmail(db, w.staff.id, 'staff@parish.test')
    const worship = await createProject(db, { contextId: w.parish.id, name: 'Worship', parentId: w.retreat.id })
    const events = [
      event({ eventId: 'list', title: 'Staff retreat planning', attendees: [{ email: 'staff@parish.test', name: null, declined: false }] }),
      event({ eventId: 'bound', title: 'Worship walk-through', scope: { kind: 'project', id: worship.id } }),
      event({ eventId: 'neither', title: 'Dentist' }),
    ]

    const group = await hubUpcoming(db, w.parish.id, { kind: 'group', id: w.staff.id }, { now: NOW, events })
    expect(titles(group.entries)).toEqual(['Staff retreat planning'])

    // The sub-project's event shows on the parent only when the hub rolls its sub-projects in.
    const own = await hubUpcoming(db, w.parish.id, { kind: 'project', ids: [w.retreat.id] }, { now: NOW, events })
    expect(titles(own.entries)).toEqual([])
    const rolled = await hubUpcoming(db, w.parish.id, { kind: 'project', ids: [w.retreat.id, worship.id] }, { now: NOW, events })
    expect(titles(rolled.entries)).toEqual(['Worship walk-through'])

    // Prepped, the event's meeting carries what the hub predicted.
    const meeting = await prepFromEvent(db, actor, { contextId: w.parish.id, event: events[0]! }, NOW)
    expect(meeting.groups.map((g) => g.id)).toEqual([w.staff.id])
  })

  it("lists an occurrence of a series with a project on that project's hub", async () => {
    const w = await makeWorld()
    await createSeries(db, { contextId: w.parish.id, name: 'Campaign committee', calendarSeriesId: 'rec-2', projectIds: [w.campaign.id] })
    const events = [event({ eventId: 'occ', seriesId: 'rec-2', title: 'Campaign committee' })]
    const hub = await hubUpcoming(db, w.parish.id, { kind: 'project', ids: [w.campaign.id] }, { now: NOW, events })
    expect(titles(hub.entries)).toEqual(['Campaign committee'])
  })
})
