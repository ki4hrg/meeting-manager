import { describe, expect, it } from 'vitest'
import { NotFoundError } from '../lib/core/types'
import {
  attachToEvent,
  createMeeting,
  deleteMeeting,
  detachFromEvent,
  findMeetingByEvent,
  getMeeting,
  isOver,
  listMeetings,
  nextOccurrence,
  previousOccurrence,
  setMeetingPeople,
  setMeetingProjects,
  updateMeeting,
} from '../lib/meetings/meetings'
import {
  createSeries,
  deleteSeries,
  findSeriesByCalendar,
  getSeries,
  listSeries,
  setSeriesPeople,
  updateSeries,
} from '../lib/meetings/series'
import { createItem, getItem } from '../lib/items/items'
import { db, resetBetweenTests } from './helpers/db'
import { actor, makeWorld } from './helpers/fixtures'

resetBetweenTests()

describe('series', () => {
  it('creates with defaults', async () => {
    const { parish } = await makeWorld()
    const s = await createSeries(db, { contextId: parish.id, name: 'Weekly standup' })

    expect(s).toMatchObject({
      contextId: parish.id,
      name: 'Weekly standup',
      skeleton: [],
      blocks: { followUps: false, sinceLast: false, lookahead: false },
    })
    expect(s.people).toEqual([])
    expect(s.projects).toEqual([])
    expect(s.groups).toEqual([])
  })

  it('creates with people and projects', async () => {
    const { parish, sarah, tom, retreat } = await makeWorld()
    const s = await createSeries(db, {
      contextId: parish.id,
      name: 'Planning',
      personIds: [sarah.id, tom.id],
      projectIds: [retreat.id],
    })

    expect(s.people).toHaveLength(2)
    expect(s.people.map((p) => p.name).sort()).toEqual(['Sarah Jones', 'Tom Baker'])
    expect(s.projects.map((p) => p.id)).toEqual([retreat.id])
  })

  it('drops John from the people list', async () => {
    const { parish, sarah, john } = await makeWorld()
    const s = await createSeries(db, {
      contextId: parish.id,
      name: 'With John',
      personIds: [sarah.id, john.id],
    })

    expect(s.people).toHaveLength(1)
    expect(s.people[0]!.id).toBe(sarah.id)
  })

  it('silently drops John from the roster', async () => {
    const { parish, john } = await makeWorld()
    const s = await createSeries(db, {
      contextId: parish.id,
      name: 'Just John',
      personIds: [john.id],
    })
    /* John is dropped, so the series has no people */
    expect(s.people).toEqual([])
  })

  it('refuses a project from another context', async () => {
    const { parish, synod } = await makeWorld()
    await expect(
      createSeries(db, {
        contextId: parish.id,
        name: 'Bad',
        projectIds: [synod.id],
      }),
    ).rejects.toThrow('another context')
  })

  it('updates name and people', async () => {
    const { parish, sarah, tom, bishop } = await makeWorld()
    const s = await createSeries(db, {
      contextId: parish.id,
      name: 'Original',
      personIds: [sarah.id, tom.id],
    })

    const updated = await setSeriesPeople(db, s.id, [bishop.id, sarah.id])
    expect(updated.people.map((p) => p.id).sort()).toEqual([bishop.id, sarah.id].sort())

    const renamed = await updateSeries(db, s.id, { name: 'Renamed' })
    expect(renamed.name).toBe('Renamed')
  })

  it('refuses a duplicate name', async () => {
    const { parish } = await makeWorld()
    await createSeries(db, { contextId: parish.id, name: 'One' })
    await expect(
      createSeries(db, { contextId: parish.id, name: 'One' }),
    ).rejects.toThrow('already a series')
  })

  it('lists by context and name order', async () => {
    const { parish, diocese } = await makeWorld()
    await createSeries(db, { contextId: parish.id, name: 'Zulu' })
    await createSeries(db, { contextId: parish.id, name: 'Alpha' })
    await createSeries(db, { contextId: diocese.id, name: 'Beta' })

    const inParish = await listSeries(db, parish.id)
    expect(inParish.map((s) => s.name)).toEqual(['Alpha', 'Zulu'])

    const inDiocese = await listSeries(db, diocese.id)
    expect(inDiocese.map((s) => s.name)).toEqual(['Beta'])
  })

  it('finds by calendar series id', async () => {
    const { parish } = await makeWorld()
    const s = await createSeries(db, {
      contextId: parish.id,
      name: 'Cal series',
      calendarSeriesId: 'cal-123',
    })

    const found = await findSeriesByCalendar(db, 'cal-123')
    expect(found?.id).toBe(s.id)

    const notFound = await findSeriesByCalendar(db, 'cal-999')
    expect(notFound).toBeNull()
  })

  it('deletes', async () => {
    const { parish } = await makeWorld()
    const s = await createSeries(db, { contextId: parish.id, name: 'To delete' })

    await deleteSeries(db, s.id)
    await expect(getSeries(db, s.id)).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('meetings', () => {
  it('creates a stub with minimal input', async () => {
    const { parish } = await makeWorld()
    const m = await createMeeting(db, actor, { contextId: parish.id })

    expect(m).toMatchObject({
      contextId: parish.id,
      title: 'Meeting',
      startsAt: null,
      endsAt: null,
    })
    expect(m.series).toBeNull()
    expect(m.people).toEqual([])
    expect(m.projects).toEqual([])
  })

  it('defaults title from series name', async () => {
    const { parish, sarah, tom } = await makeWorld()
    const s = await createSeries(db, {
      contextId: parish.id,
      name: 'Weekly standup',
      personIds: [sarah.id, tom.id],
    })
    const m = await createMeeting(db, actor, { contextId: parish.id, seriesId: s.id })

    expect(m.title).toBe('Weekly standup')
  })

  it('defaults title from one person', async () => {
    const { parish, sarah } = await makeWorld()
    const m = await createMeeting(db, actor, {
      contextId: parish.id,
      personIds: [sarah.id],
    })

    expect(m.title).toBe('Sarah Jones')
  })

  it('defaults title from two people', async () => {
    const { parish, sarah, tom } = await makeWorld()
    const m = await createMeeting(db, actor, {
      contextId: parish.id,
      personIds: [sarah.id, tom.id],
    })

    expect(m.title).toBe('Sarah Jones & Tom Baker')
  })

  it('defaults title from three or more people', async () => {
    const { parish, sarah, tom, bishop } = await makeWorld()
    const m = await createMeeting(db, actor, {
      contextId: parish.id,
      personIds: [sarah.id, tom.id, bishop.id],
    })

    expect(m.title).toContain('&')
    expect(m.title).toContain('1 more')
  })

  it('defaults title from group name', async () => {
    const { parish, staff } = await makeWorld()
    const m = await createMeeting(db, actor, { contextId: parish.id, groupId: staff.id })

    expect(m.title).toBe('Staff')
  })

  it('inherits roster and projects from series', async () => {
    const { parish, sarah, tom, retreat } = await makeWorld()
    const s = await createSeries(db, {
      contextId: parish.id,
      name: 'Meeting',
      personIds: [sarah.id, tom.id],
      projectIds: [retreat.id],
    })
    const m = await createMeeting(db, actor, { contextId: parish.id, seriesId: s.id })

    expect(m.people.map((p) => p.id)).toEqual([sarah.id, tom.id])
    expect(m.projects.map((p) => p.id)).toEqual([retreat.id])
  })

  it('allows explicit people to override series defaults', async () => {
    const { parish, sarah, tom, bishop } = await makeWorld()
    const s = await createSeries(db, {
      contextId: parish.id,
      name: 'Meeting',
      personIds: [sarah.id, tom.id],
    })
    const m = await createMeeting(db, actor, {
      contextId: parish.id,
      seriesId: s.id,
      personIds: [bishop.id],
    })

    expect(m.people.map((p) => p.id)).toEqual([bishop.id])
  })

  it('allows explicit empty people array to clear series roster', async () => {
    const { parish, sarah, tom } = await makeWorld()
    const s = await createSeries(db, {
      contextId: parish.id,
      name: 'Meeting',
      personIds: [sarah.id, tom.id],
    })
    const m = await createMeeting(db, actor, {
      contextId: parish.id,
      seriesId: s.id,
      personIds: [],
    })

    expect(m.people).toEqual([])
  })

  it('drops John from people', async () => {
    const { parish, sarah, john } = await makeWorld()
    const m = await createMeeting(db, actor, {
      contextId: parish.id,
      personIds: [sarah.id, john.id],
    })

    expect(m.people).toHaveLength(1)
    expect(m.people[0]!.id).toBe(sarah.id)
  })

  it('silently drops John from the roster', async () => {
    const { parish, john } = await makeWorld()
    const m = await createMeeting(db, actor, { contextId: parish.id, personIds: [john.id] })
    /* John is dropped, so the meeting has no people */
    expect(m.people).toEqual([])
  })

  it('refuses end before start', async () => {
    const { parish } = await makeWorld()
    const start = new Date('2026-10-01T10:00:00Z')
    const end = new Date('2026-10-01T09:00:00Z')

    await expect(
      createMeeting(db, actor, { contextId: parish.id, startsAt: start, endsAt: end }),
    ).rejects.toThrow('End time must not be before start time')
  })

  it('refuses end with no start', async () => {
    const { parish } = await makeWorld()
    const end = new Date('2026-10-01T10:00:00Z')

    await expect(
      createMeeting(db, actor, { contextId: parish.id, endsAt: end }),
    ).rejects.toThrow('end time requires a start')
  })

  it('refuses a session of a session', async () => {
    const { parish } = await makeWorld()
    const parent = await createMeeting(db, actor, { contextId: parish.id })
    const session = await createMeeting(db, actor, {
      contextId: parish.id,
      parentMeetingId: parent.id,
    })

    await expect(
      createMeeting(db, actor, { contextId: parish.id, parentMeetingId: session.id }),
    ).rejects.toThrow('session cannot itself have a session')
  })

  it('refuses cross-context series, group, project or parent', async () => {
    const { parish, diocese, synod, council } = await makeWorld()

    await expect(
      createMeeting(db, actor, {
        contextId: parish.id,
        seriesId: (await createSeries(db, { contextId: diocese.id, name: 'Other' })).id,
      }),
    ).rejects.toThrow('another context')

    await expect(
      createMeeting(db, actor, { contextId: parish.id, groupId: council.id }),
    ).rejects.toThrow('another context')

    await expect(
      createMeeting(db, actor, { contextId: parish.id, projectIds: [synod.id] }),
    ).rejects.toThrow('another context')

    const other = await createMeeting(db, actor, { contextId: diocese.id })
    await expect(
      createMeeting(db, actor, { contextId: parish.id, parentMeetingId: other.id }),
    ).rejects.toThrow('another context')
  })

  it('updates', async () => {
    const { parish } = await makeWorld()
    const m = await createMeeting(db, actor, { contextId: parish.id })

    const start = new Date('2026-10-05T14:00:00Z')
    const updated = await updateMeeting(db, actor, m.id, {
      title: 'Staff sync',
      startsAt: start,
    })

    expect(updated.title).toBe('Staff sync')
    expect(updated.startsAt).toEqual(start)
  })

  it('sets people', async () => {
    const { parish, sarah, tom } = await makeWorld()
    const m = await createMeeting(db, actor, { contextId: parish.id })

    const updated = await setMeetingPeople(db, actor, m.id, [sarah.id, tom.id])
    expect(updated.people.map((p) => p.id)).toEqual([sarah.id, tom.id])
  })

  it('sets projects', async () => {
    const { parish, retreat, campaign } = await makeWorld()
    const m = await createMeeting(db, actor, { contextId: parish.id })

    const updated = await setMeetingProjects(db, actor, m.id, [retreat.id, campaign.id])
    expect(updated.projects.map((p) => p.id).sort()).toEqual([retreat.id, campaign.id].sort())
  })

  it('attaches a stub to a calendar event', async () => {
    const { parish } = await makeWorld()
    const stub = await createMeeting(db, actor, { contextId: parish.id, title: 'Stub' })

    const start = new Date('2026-10-05T10:00:00Z')
    const end = new Date('2026-10-05T11:00:00Z')
    const attached = await attachToEvent(db, actor, stub.id, {
      calendarId: 'primary',
      calendarEventId: 'evt-123',
      startsAt: start,
      endsAt: end,
    })

    expect(attached.startsAt).toEqual(start)
    expect(attached.endsAt).toEqual(end)
    expect(attached.calendarEventId).toBe('evt-123')
    expect(attached.title).toBe('Stub')
  })

  it('refuses a second meeting on one calendar event', async () => {
    const { parish } = await makeWorld()
    const m1 = await createMeeting(db, actor, { contextId: parish.id })
    const start = new Date('2026-10-05T10:00:00Z')

    await attachToEvent(db, actor, m1.id, {
      calendarId: 'primary',
      calendarEventId: 'evt-123',
      startsAt: start,
    })

    const m2 = await createMeeting(db, actor, { contextId: parish.id })
    await expect(
      attachToEvent(db, actor, m2.id, {
        calendarId: 'primary',
        calendarEventId: 'evt-123',
        startsAt: start,
      }),
    ).rejects.toThrow('calendar event already has a meeting')
  })

  it('rejects createMeeting with a calendarEventId that already has a meeting', async () => {
    const { parish } = await makeWorld()
    const m1 = await createMeeting(db, actor, { contextId: parish.id })
    const start = new Date('2026-10-05T10:00:00Z')

    await attachToEvent(db, actor, m1.id, {
      calendarId: 'primary',
      calendarEventId: 'evt-456',
      startsAt: start,
    })

    await expect(
      createMeeting(db, actor, {
        contextId: parish.id,
        calendarEventId: 'evt-456',
      }),
    ).rejects.toThrow('calendar event already has a meeting')
  })

  it('detaches from event', async () => {
    const { parish } = await makeWorld()
    const m = await createMeeting(db, actor, { contextId: parish.id })
    const start = new Date('2026-10-05T10:00:00Z')

    await attachToEvent(db, actor, m.id, {
      calendarId: 'primary',
      calendarEventId: 'evt-123',
      startsAt: start,
    })

    const detached = await detachFromEvent(db, actor, m.id)
    expect(detached.calendarEventId).toBeNull()
    expect(detached.calendarId).toBeNull()
  })

  it('finds by calendar event id', async () => {
    const { parish } = await makeWorld()
    const m = await createMeeting(db, actor, { contextId: parish.id })
    const start = new Date('2026-10-05T10:00:00Z')

    await attachToEvent(db, actor, m.id, {
      calendarId: 'primary',
      calendarEventId: 'evt-789',
      startsAt: start,
    })

    const found = await findMeetingByEvent(db, 'evt-789')
    expect(found?.id).toBe(m.id)

    const notFound = await findMeetingByEvent(db, 'evt-999')
    expect(notFound).toBeNull()
  })

  it('lists all or by when', async () => {
    const { parish } = await makeWorld()
    const now = new Date('2026-10-01T12:00:00Z')

    const past = new Date('2026-09-20T10:00:00Z')
    const future = new Date('2026-10-15T10:00:00Z')

    const m1 = await createMeeting(db, actor, { contextId: parish.id, startsAt: past })
    const m2 = await createMeeting(db, actor, { contextId: parish.id, startsAt: future })
    const m3 = await createMeeting(db, actor, { contextId: parish.id })

    const all = await listMeetings(db, { contextId: parish.id, now })
    expect(all.map((m) => m.id)).toEqual([m1.id, m2.id, m3.id])

    const upcoming = await listMeetings(db, { contextId: parish.id, when: 'upcoming', now })
    expect(upcoming.map((m) => m.id)).toEqual([m2.id])

    const pasted = await listMeetings(db, { contextId: parish.id, when: 'past', now })
    expect(pasted.map((m) => m.id)).toEqual([m1.id])

    const stubs = await listMeetings(db, { contextId: parish.id, when: 'stubs', now })
    expect(stubs.map((m) => m.id)).toEqual([m3.id])
  })

  it('lists by series, person, project or group', async () => {
    const { parish, sarah, retreat, staff } = await makeWorld()
    const s = await createSeries(db, { contextId: parish.id, name: 'Weekly' })
    await createMeeting(db, actor, {
      contextId: parish.id,
      seriesId: s.id,
      personIds: [sarah.id],
      projectIds: [retreat.id],
    })
    await createMeeting(db, actor, {
      contextId: parish.id,
      groupId: staff.id,
    })

    expect(await listMeetings(db, { contextId: parish.id, seriesId: s.id })).toHaveLength(1)
    /* m2's group stands for its members (sarah, tom), so sarah is at both */
    expect(await listMeetings(db, { contextId: parish.id, personId: sarah.id })).toHaveLength(2)
    expect(await listMeetings(db, { contextId: parish.id, projectId: retreat.id })).toHaveLength(1)
    expect(await listMeetings(db, { contextId: parish.id, groupId: staff.id })).toHaveLength(1)
  })

  it('excludes sessions from topLevelOnly', async () => {
    const { parish } = await makeWorld()
    const parent = await createMeeting(db, actor, { contextId: parish.id })
    const session = await createMeeting(db, actor, {
      contextId: parish.id,
      parentMeetingId: parent.id,
    })

    const all = await listMeetings(db, { contextId: parish.id })
    /* Stubs ordered newest-first, so session comes before parent */
    expect(all.map((m) => m.id)).toEqual([session.id, parent.id])

    const topLevel = await listMeetings(db, { contextId: parish.id, topLevelOnly: true })
    expect(topLevel.map((m) => m.id)).toEqual([parent.id])
  })

  it('shows sessions on their parent', async () => {
    const { parish } = await makeWorld()
    const parent = await createMeeting(db, actor, { contextId: parish.id, title: 'Conference' })
    const session1 = await createMeeting(db, actor, {
      contextId: parish.id,
      parentMeetingId: parent.id,
      title: 'Day 1',
      startsAt: new Date('2026-10-05T09:00:00Z'),
    })
    const session2 = await createMeeting(db, actor, {
      contextId: parish.id,
      parentMeetingId: parent.id,
      title: 'Day 2',
      startsAt: new Date('2026-10-06T09:00:00Z'),
    })

    const p = await getMeeting(db, parent.id)
    expect(p.sessions.map((s) => s.id)).toEqual([session1.id, session2.id])
    expect(p.sessions[0]!.startsAt).toEqual(session1.startsAt)
  })

  it('deletes a meeting and cascades sessions', async () => {
    const { parish } = await makeWorld()
    const parent = await createMeeting(db, actor, { contextId: parish.id })
    const session = await createMeeting(db, actor, {
      contextId: parish.id,
      parentMeetingId: parent.id,
    })

    await deleteMeeting(db, actor, parent.id)

    await expect(getMeeting(db, parent.id)).rejects.toBeInstanceOf(NotFoundError)
    await expect(getMeeting(db, session.id)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('clears items\' target_meeting_id on delete', async () => {
    const { parish } = await makeWorld()
    const m = await createMeeting(db, actor, { contextId: parish.id })
    const item = await createItem(db, actor, {
      contextId: parish.id,
      text: 'Raise this',
      target: { meetingId: m.id },
    })

    await deleteMeeting(db, actor, m.id)

    const updated = await getItem(db, item.id)
    expect(updated.targetMeetingId).toBeNull()
  })

  it('finds previous occurrence in series', async () => {
    const { parish } = await makeWorld()
    const s = await createSeries(db, { contextId: parish.id, name: 'Weekly' })

    await createMeeting(db, actor, {
      contextId: parish.id,
      seriesId: s.id,
      startsAt: new Date('2026-09-20T10:00:00Z'),
    })
    const m2 = await createMeeting(db, actor, {
      contextId: parish.id,
      seriesId: s.id,
      startsAt: new Date('2026-09-27T10:00:00Z'),
    })
    const m3 = await createMeeting(db, actor, {
      contextId: parish.id,
      seriesId: s.id,
      startsAt: new Date('2026-10-04T10:00:00Z'),
    })

    const prev = await previousOccurrence(db, m3)
    expect(prev?.id).toBe(m2.id)
  })

  it('returns null if no previous occurrence', async () => {
    const { parish } = await makeWorld()
    const s = await createSeries(db, { contextId: parish.id, name: 'Weekly' })
    const m = await createMeeting(db, actor, {
      contextId: parish.id,
      seriesId: s.id,
      startsAt: new Date('2026-09-20T10:00:00Z'),
    })

    const prev = await previousOccurrence(db, m)
    expect(prev).toBeNull()
  })

  it('finds latest dated previous for a stub', async () => {
    const { parish } = await makeWorld()
    const s = await createSeries(db, { contextId: parish.id, name: 'Weekly' })

    await createMeeting(db, actor, {
      contextId: parish.id,
      seriesId: s.id,
      startsAt: new Date('2026-09-20T10:00:00Z'),
    })
    const m2 = await createMeeting(db, actor, {
      contextId: parish.id,
      seriesId: s.id,
      startsAt: new Date('2026-09-27T10:00:00Z'),
    })
    const stub = await createMeeting(db, actor, { contextId: parish.id, seriesId: s.id })

    const prev = await previousOccurrence(db, stub)
    expect(prev?.id).toBe(m2.id)
  })

  it('finds next occurrence in series', async () => {
    const { parish } = await makeWorld()
    const s = await createSeries(db, { contextId: parish.id, name: 'Weekly' })
    const now = new Date('2026-10-01T12:00:00Z')

    await createMeeting(db, actor, {
      contextId: parish.id,
      seriesId: s.id,
      startsAt: new Date('2026-09-20T10:00:00Z'),
    })
    const m2 = await createMeeting(db, actor, {
      contextId: parish.id,
      seriesId: s.id,
      startsAt: new Date('2026-10-15T10:00:00Z'),
    })

    const next = await nextOccurrence(db, s.id, now)
    expect(next?.id).toBe(m2.id)
  })

  it('returns null if no next occurrence', async () => {
    const { parish } = await makeWorld()
    const s = await createSeries(db, { contextId: parish.id, name: 'Weekly' })
    const now = new Date('2026-10-20T12:00:00Z')

    await createMeeting(db, actor, {
      contextId: parish.id,
      seriesId: s.id,
      startsAt: new Date('2026-09-20T10:00:00Z'),
    })

    const next = await nextOccurrence(db, s.id, now)
    expect(next).toBeNull()
  })
  it('clearing the start clears the end, and a later start is checked against the stored end', async () => {
    const { parish } = await makeWorld()
    const meeting = await createMeeting(db, actor, {
      contextId: parish.id,
      startsAt: new Date('2026-10-07T14:00:00Z'),
      endsAt: new Date('2026-10-07T15:00:00Z'),
    })

    await expect(
      updateMeeting(db, actor, meeting.id, { startsAt: new Date('2026-10-07T16:00:00Z') }),
    ).rejects.toThrow('End time must not be before start time')
    // Moving both together is fine.
    const moved = await updateMeeting(db, actor, meeting.id, {
      startsAt: new Date('2026-10-07T16:00:00Z'),
      endsAt: new Date('2026-10-07T17:00:00Z'),
    })
    expect(moved.endsAt?.toISOString()).toBe('2026-10-07T17:00:00.000Z')

    const stub = await updateMeeting(db, actor, meeting.id, { startsAt: null })
    expect(stub.startsAt).toBeNull()
    expect(stub.endsAt).toBeNull()

    await expect(
      updateMeeting(db, actor, meeting.id, { endsAt: new Date('2026-10-07T17:00:00Z') }),
    ).rejects.toThrow('An end time requires a start time')
  })

  it('a meeting in progress is upcoming until it is over', async () => {
    const { parish } = await makeWorld()
    const now = new Date('2026-10-07T14:30:00Z')
    const running = await createMeeting(db, actor, {
      contextId: parish.id,
      title: 'Running',
      startsAt: new Date('2026-10-07T14:00:00Z'),
      endsAt: new Date('2026-10-07T15:00:00Z'),
    })
    // No end: taken to run an hour.
    const open = await createMeeting(db, actor, {
      contextId: parish.id,
      title: 'Open-ended',
      startsAt: new Date('2026-10-07T13:45:00Z'),
    })
    const done = await createMeeting(db, actor, {
      contextId: parish.id,
      title: 'Done',
      startsAt: new Date('2026-10-07T13:00:00Z'),
      endsAt: new Date('2026-10-07T13:20:00Z'),
    })

    const titles = async (when: 'upcoming' | 'past') =>
      (await listMeetings(db, { contextId: parish.id, when, now })).map((m) => m.title)
    expect(await titles('upcoming')).toEqual(['Open-ended', 'Running'])
    expect(await titles('past')).toEqual(['Done'])

    expect(isOver(running, now)).toBe(false)
    expect(isOver(open, now)).toBe(false)
    expect(isOver(done, now)).toBe(true)
    expect(isOver({ startsAt: null, endsAt: null }, now)).toBe(false)
  })

  it('a listed meeting carries its sessions, as a single read does', async () => {
    const { parish } = await makeWorld()
    const retreat = await createMeeting(db, actor, { contextId: parish.id, title: 'Retreat' })
    await createMeeting(db, actor, {
      contextId: parish.id,
      title: 'Day one',
      parentMeetingId: retreat.id,
      startsAt: new Date('2026-10-07T14:00:00Z'),
    })

    const [listed] = await listMeetings(db, { contextId: parish.id, topLevelOnly: true })
    expect(listed!.sessions.map((session) => session.title)).toEqual(['Day one'])
    expect(listed!.sessions).toEqual((await getMeeting(db, retreat.id)).sessions)
  })

  it('a meeting with sessions keeps its own start and end, whatever its sessions do', async () => {
    const { parish } = await makeWorld()
    const retreat = await createMeeting(db, actor, {
      contextId: parish.id,
      title: 'Planning retreat',
      startsAt: new Date('2026-10-07T13:00:00Z'),
      endsAt: new Date('2026-10-09T22:00:00Z'),
    })
    const day = await createMeeting(db, actor, {
      contextId: parish.id,
      title: 'Day one',
      parentMeetingId: retreat.id,
      startsAt: new Date('2026-10-07T14:00:00Z'),
      endsAt: new Date('2026-10-07T22:00:00Z'),
    })
    await updateMeeting(db, actor, day.id, { endsAt: new Date('2026-10-07T23:00:00Z') })
    await updateMeeting(db, actor, retreat.id, { endsAt: new Date('2026-10-10T18:00:00Z') })

    const after = await getMeeting(db, retreat.id)
    expect(after.startsAt).toEqual(new Date('2026-10-07T13:00:00Z'))
    expect(after.endsAt).toEqual(new Date('2026-10-10T18:00:00Z'))
    // Listed as the whole event.
    const upcoming = await listMeetings(db, {
      contextId: parish.id,
      when: 'upcoming',
      topLevelOnly: true,
      now: new Date('2026-10-01T00:00:00Z'),
    })
    expect(upcoming.map((m) => m.title)).toEqual(['Planning retreat'])
  })
})
