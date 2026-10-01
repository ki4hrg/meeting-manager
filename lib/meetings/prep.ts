/*
 * Prepping a meeting: the step that turns a calendar event, a person or a
 * series into a meeting row with its agenda started (docs/SPEC.md, "Meetings
 * are light and created lazily").
 *
 * Nothing here runs on its own. The calendar is a read-only feed, and a meeting
 * exists only once John asks for one.
 */

import { applySkeleton } from '../agenda/lines'
import { placeAutomatic } from '../agenda/candidates'
import { listEvents, type CalendarEvent } from '../calendar/feed'
import { ValidationError, inTransaction, type ActorContext, type Executor } from '../core/types'
import { findSelf } from '../directory/people'
import {
  attachToEvent,
  createMeeting,
  findMeetingByEvent,
  getMeeting,
  listMeetings,
  type MeetingView,
} from './meetings'
import { createSeries, findSeriesByCalendar, getSeries, listSeries, type SeriesView } from './series'

type CreateMeetingInput = Parameters<typeof createMeeting>[2]

/** Create a meeting with its standing agenda laid down and everything that places itself placed. */
export async function prepMeeting(
  exec: Executor,
  actor: ActorContext,
  input: CreateMeetingInput,
  now: Date = new Date(),
): Promise<MeetingView> {
  return inTransaction(exec, async (tx) => {
    const meeting = await createMeeting(tx, actor, input)
    if (meeting.series) {
      const series = await getSeries(tx, meeting.series.id)
      if (series.skeleton.length > 0) await applySkeleton(tx, actor, meeting.id, series.skeleton)
    }
    await placeAutomatic(tx, actor, meeting.id, now)
    return meeting
  })
}

/**
 * "Prep a meeting with…": an undated stub holding everything saved up for one
 * person. Asking twice returns the same stub, topped up with what was captured
 * since.
 */
export async function prepWithPerson(
  exec: Executor,
  actor: ActorContext,
  input: { contextId: string; personId: string },
  now: Date = new Date(),
): Promise<MeetingView> {
  const self = await findSelf(exec)
  if (self?.id === input.personId) throw new ValidationError('Pick someone other than yourself.')

  const stubs = await listMeetings(exec, {
    contextId: input.contextId,
    when: 'stubs',
    personId: input.personId,
    topLevelOnly: true,
  })
  const existing = stubs.find((stub) => stub.people.length === 1 && !stub.series)
  if (existing) {
    await placeAutomatic(exec, actor, existing.id, now)
    return existing
  }
  return prepMeeting(exec, actor, { contextId: input.contextId, personIds: [input.personId] }, now)
}

/**
 * The same for a group: an undated stub with the group's members as its
 * roster. Nothing places itself by group alone; what is waiting for the group
 * is suggested on the stub. Asking twice returns the same stub.
 */
export async function prepWithGroup(
  exec: Executor,
  actor: ActorContext,
  input: { contextId: string; groupId: string },
  now: Date = new Date(),
): Promise<MeetingView> {
  const stubs = await listMeetings(exec, {
    contextId: input.contextId,
    when: 'stubs',
    groupId: input.groupId,
    topLevelOnly: true,
  })
  const existing = stubs.find((stub) => !stub.series)
  if (existing) {
    await placeAutomatic(exec, actor, existing.id, now)
    return existing
  }
  return prepMeeting(exec, actor, { contextId: input.contextId, groupId: input.groupId }, now)
}

/** The next occurrence of a series, created if nobody has prepped one yet. */
export async function prepNextInSeries(
  exec: Executor,
  actor: ActorContext,
  seriesId: string,
  now: Date = new Date(),
): Promise<MeetingView> {
  const series = await getSeries(exec, seriesId)
  const waiting = await listMeetings(exec, { contextId: series.contextId, seriesId, now })
  const next = waiting.find((meeting) => meeting.startsAt === null || meeting.startsAt >= now)
  if (next) {
    await placeAutomatic(exec, actor, next.id, now)
    return next
  }
  return prepMeeting(exec, actor, { contextId: series.contextId, seriesId }, now)
}

function matchedPeople(event: CalendarEvent): string[] {
  const ids = event.attendees
    .filter((attendee) => attendee.personId && !attendee.declined)
    .map((attendee) => attendee.personId!)
  return [...new Set(ids)]
}

async function seriesFor(
  exec: Executor,
  contextId: string,
  event: CalendarEvent,
): Promise<SeriesView | null> {
  if (!event.seriesId) return null
  const series = await findSeriesByCalendar(exec, event.seriesId)
  // A series in another context is not this event's series.
  return series?.contextId === contextId ? series : null
}

/** The meeting for a calendar event: the one it already has, or a new one. */
export async function prepFromEvent(
  exec: Executor,
  actor: ActorContext,
  input: { contextId: string; event: CalendarEvent },
  now: Date = new Date(),
): Promise<MeetingView> {
  const { contextId, event } = input
  const existing = await findMeetingByEvent(exec, event.eventId)
  if (existing) {
    await placeAutomatic(exec, actor, existing.id, now)
    return existing
  }

  const series = await seriesFor(exec, contextId, event)
  const people = matchedPeople(event)
  return prepMeeting(
    exec,
    actor,
    {
      contextId,
      title: event.title,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      calendarId: event.calendarId,
      calendarEventId: event.eventId,
      seriesId: series?.id,
      /* An in-person 1:1 often has no invitees: the series' roster stands in
         when the event names nobody we know. */
      ...(people.length > 0 || !series ? { personIds: people } : {}),
    },
    now,
  )
}

/** Give a stub its date by attaching it to a calendar event. The stub stays the one meeting. */
export async function attachStub(
  exec: Executor,
  actor: ActorContext,
  meetingId: string,
  event: CalendarEvent,
  now: Date = new Date(),
): Promise<MeetingView> {
  return inTransaction(exec, async (tx) => {
    const stub = await getMeeting(tx, meetingId)
    const series = stub.series ? null : await seriesFor(tx, stub.contextId, event)
    await attachToEvent(tx, actor, meetingId, {
      calendarId: event.calendarId,
      calendarEventId: event.eventId,
      startsAt: event.startsAt,
      endsAt: event.endsAt ?? undefined,
      seriesId: series?.id,
    })
    await placeAutomatic(tx, actor, meetingId, now)
    return getMeeting(tx, meetingId)
  })
}

/** Turn a recurring calendar event into a series, so each occurrence starts from its roster and skeleton. */
export async function seriesFromEvent(
  exec: Executor,
  input: { contextId: string; event: CalendarEvent },
): Promise<SeriesView> {
  const { contextId, event } = input
  if (!event.seriesId) throw new ValidationError('That event does not repeat.')
  const existing = await findSeriesByCalendar(exec, event.seriesId)
  if (existing) return existing
  return createSeries(exec, {
    contextId,
    name: event.title,
    personIds: matchedPeople(event),
    calendarSeriesId: event.seriesId,
  })
}

export type UpcomingEntry = {
  startsAt: Date
  /** Null for a meeting made by hand. */
  event: CalendarEvent | null
  /** Null until the event is prepped. */
  meeting: MeetingView | null
  series: { id: string; name: string } | null
  /** Undated stubs whose people are all at this event: candidates to attach. */
  stubs: MeetingView[]
}

/* Rounded so that every page load in the same hour asks the feed for the same
   range and its cache can answer. */
function feedRange(now: Date, days: number): { from: Date; to: Date } {
  const from = new Date(now)
  from.setMinutes(0, 0, 0)
  return { from, to: new Date(from.getTime() + days * 86_400_000) }
}

/** One event from the feed, looked up again at the moment it is acted on. */
export async function findEvent(
  exec: Executor,
  contextId: string,
  eventId: string,
  now: Date = new Date(),
  days = 60,
): Promise<CalendarEvent> {
  const events = await listEvents(exec, { contextId, ...feedRange(now, days) })
  const event = events.find((candidate) => candidate.eventId === eventId)
  if (!event) throw new ValidationError('That event is no longer on the calendar.')
  return event
}

/**
 * What is coming up in a context: calendar events and hand-made meetings in one
 * list, each event carrying its meeting if it has one.
 */
export async function listUpcoming(
  exec: Executor,
  contextId: string,
  /* `events` stands in for the calendar feed, for tests. */
  opts: { now?: Date; days?: number; events?: CalendarEvent[] } = {},
): Promise<{ entries: UpcomingEntry[]; stubs: MeetingView[] }> {
  const now = opts.now ?? new Date()
  const range = feedRange(now, opts.days ?? 14)

  const [events, dated, stubs, allSeries] = await Promise.all([
    opts.events ?? listEvents(exec, { contextId, ...range }),
    listMeetings(exec, { contextId, when: 'upcoming', now: range.from, topLevelOnly: true }),
    listMeetings(exec, { contextId, when: 'stubs', topLevelOnly: true }),
    listSeries(exec, contextId),
  ])

  const byEvent = new Map(
    dated.filter((meeting) => meeting.calendarEventId).map((m) => [m.calendarEventId!, m]),
  )
  const byCalendarSeries = new Map(
    allSeries.filter((series) => series.calendarSeriesId).map((s) => [s.calendarSeriesId!, s]),
  )

  const entries: UpcomingEntry[] = []
  for (const event of events) {
    if (event.allDay) continue
    const meeting = byEvent.get(event.eventId) ?? null
    const series = event.seriesId ? (byCalendarSeries.get(event.seriesId) ?? null) : null

    const present = new Set([...matchedPeople(event), ...(series?.people.map((p) => p.id) ?? [])])
    const fitting = meeting
      ? []
      : stubs.filter(
          (stub) => stub.people.length > 0 && stub.people.every((person) => present.has(person.id)),
        )

    entries.push({
      startsAt: event.startsAt,
      event,
      meeting,
      series: meeting?.series ?? (series ? { id: series.id, name: series.name } : null),
      stubs: fitting,
    })
  }

  for (const meeting of dated) {
    if (meeting.calendarEventId && events.some((e) => e.eventId === meeting.calendarEventId)) continue
    if (!meeting.startsAt || meeting.startsAt >= range.to) continue
    entries.push({
      startsAt: meeting.startsAt,
      event: null,
      meeting,
      series: meeting.series,
      stubs: [],
    })
  }

  entries.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
  return { entries, stubs }
}
