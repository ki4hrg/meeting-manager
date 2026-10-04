/*
 * Prepping a meeting: the step that turns a calendar event, a person or a
 * series into a meeting row with its agenda started (docs/SPEC.md, "Meetings
 * are light and created lazily").
 *
 * Nothing here runs on its own. The calendar is a read-only feed, and a meeting
 * exists only once John asks for one.
 */

import { applySkeleton } from '../agenda/lines'
import { placeAutomatic, placeRaiseWith } from '../agenda/candidates'
import { eventsHere, listEventsIn, type CalendarEvent } from '../calendar/feed'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { ValidationError, inTransaction, type ActorContext, type Executor } from '../core/types'
import { groups, meetings, projects, series } from '../db/schema'
import { onShelf } from '../db/shelf'
import { groupsByEmail } from '../directory/groups'
import { findSelf } from '../directory/people'
import {
  attachToEvent,
  createMeeting,
  findMeetingByEvent,
  getMeeting,
  listMeetings,
  type MeetingView,
} from './meetings'
import { joinRoster } from './roster'
import { createSeries, findSeriesByCalendar, getSeries, listSeries, updateSeries, type SeriesView } from './series'

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
 * since. Asking is what places the batch; opening the stub only suggests it.
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
  return inTransaction(exec, async (tx) => {
    const stub =
      existing ?? (await prepMeeting(tx, actor, { contextId: input.contextId, personIds: [input.personId] }, now))
    if (existing) await placeAutomatic(tx, actor, stub.id, now)
    await placeRaiseWith(tx, actor, stub.id, input.personId, now)
    return stub
  })
}

/**
 * The same for a group: an undated stub with the group on it, standing for
 * its members. Nothing places itself by group alone; what is waiting for the group
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

/**
 * The one meeting John does not ask for: a note arrived and no meeting here is
 * the conversation it records (docs/SPEC.md, "Drop-ins"). The caller has
 * already decided the context; this never looks for one.
 *
 * Not prepped. It has already happened, so no skeleton is laid down and
 * nothing is placed: an agenda nobody saw in the room would put items in the
 * recap that were never raised.
 */
export async function meetingFromNote(
  exec: Executor,
  actor: ActorContext,
  input: {
    contextId: string
    title?: string | null
    startsAt: Date
    endsAt?: Date | null
    personIds: string[]
    /** The calendar event the note names, when no meeting holds it yet. */
    calendarEventId?: string
    /** The series that event recurs in, when it is in this context. */
    seriesId?: string
  },
): Promise<MeetingView> {
  return createMeeting(exec, actor, {
    contextId: input.contextId,
    title: input.title,
    startsAt: input.startsAt,
    endsAt: input.endsAt ?? null,
    calendarEventId: input.calendarEventId,
    seriesId: input.seriesId,
    /* With a series and nobody recognised, its roster stands in, as it does
       for an event with no invitees. */
    ...(input.personIds.length > 0 || !input.seriesId ? { personIds: input.personIds } : {}),
  })
}

/* The addresses on an invite nobody in the directory has: a group's list, perhaps. */
function unmatchedEmails(event: CalendarEvent): string[] {
  return event.attendees
    .filter((attendee) => !attendee.personId && !attendee.declined)
    .map((attendee) => attendee.email)
}

function matchedPeople(event: CalendarEvent): string[] {
  const ids = event.attendees
    .filter((attendee) => attendee.personId && !attendee.declined)
    .map((attendee) => attendee.personId!)
  return [...new Set(ids)]
}

/**
 * The project, series or group the event's calendar is bound to, while it is
 * still on the shelf in this context; otherwise nothing.
 */
export async function eventScope(
  exec: Executor,
  event: CalendarEvent,
  contextId: string,
): Promise<{ projectId?: string; seriesId?: string; groupId?: string }> {
  const scope = event.scope
  if (!scope) return {}
  const table = { project: projects, series, group: groups }[scope.kind]
  const [row] = await exec
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, scope.id), eq(table.contextId, contextId), onShelf(table)))
    .limit(1)
  if (!row) return {}
  return { [`${scope.kind}Id`]: row.id }
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

  /* An occurrence of a recurring event belongs to its series, wherever that
     is: the series may have been moved out of the calendar's context. Failing
     that, a calendar bound to a series puts every event on it in that series. */
  const recurring = event.seriesId ? await findSeriesByCalendar(exec, event.seriesId) : null
  const scoped = await eventScope(exec, event, recurring?.contextId ?? contextId)
  const series = recurring ?? (scoped.seriesId ? await getSeries(exec, scoped.seriesId) : null)
  const people = matchedPeople(event)
  const home = series?.contextId ?? contextId
  /* A list address on the invite brings its group, and so does a calendar
     bound to one, alongside the series' own. */
  const extra = [
    ...(await groupsByEmail(exec, home, unmatchedEmails(event))),
    ...(scoped.groupId ? [scoped.groupId] : []),
  ]
  return prepMeeting(
    exec,
    actor,
    {
      contextId: home,
      ...(extra.length > 0 ? { groupIds: [...new Set([...(series?.groups.map((g) => g.id) ?? []), ...extra])] } : {}),
      ...(scoped.projectId
        ? { projectIds: [...new Set([...(series?.projects.map((p) => p.id) ?? []), scoped.projectId])] }
        : {}),
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
    /* The stub stays in its context, so it joins the event's series only when
       that series is there too. */
    const mapped =
      stub.series || !event.seriesId ? null : await findSeriesByCalendar(tx, event.seriesId)
    const scoped = stub.series || mapped ? {} : await eventScope(tx, event, stub.contextId)
    const series =
      mapped?.contextId === stub.contextId
        ? mapped
        : scoped.seriesId
          ? await getSeries(tx, scoped.seriesId)
          : null
    await attachToEvent(tx, actor, meetingId, {
      calendarId: event.calendarId,
      calendarEventId: event.eventId,
      startsAt: event.startsAt,
      endsAt: event.endsAt ?? undefined,
      seriesId: series?.id,
    })
    // Newly in a series, it takes the roster, as one put in a series by hand does.
    if (series) await joinRoster(tx, actor, meetingId, now)
    await placeAutomatic(tx, actor, meetingId, now)
    return getMeeting(tx, meetingId)
  })
}

/**
 * Turn a recurring calendar event into a series, so each occurrence starts
 * from its roster and skeleton.
 *
 * `occurrences` are the other events of the same recurring event still on the
 * feed. One of them may have been prepped before there was a series to belong
 * to; its meeting joins the series now, as it is: its agenda is already under
 * way, so no roster or skeleton is laid over it. A meeting row does not hold
 * the recurring id, which is why the feed has to say which events are siblings.
 */
export async function seriesFromEvent(
  exec: Executor,
  input: { contextId: string; event: CalendarEvent; occurrences?: CalendarEvent[] },
): Promise<SeriesView> {
  const { contextId, event } = input
  const calendarSeriesId = event.seriesId
  if (!calendarSeriesId) throw new ValidationError('That event does not repeat.')

  return inTransaction(exec, async (tx) => {
    // Wherever it is: a recurring event has one series, and it may have been moved.
    const series =
      (await findSeriesByCalendar(tx, calendarSeriesId)) ??
      (await createSeries(tx, {
        contextId,
        name: event.title,
        personIds: matchedPeople(event),
        groupIds: await groupsByEmail(tx, contextId, unmatchedEmails(event)),
        calendarSeriesId,
      }))

    const eventIds = [event, ...(input.occurrences ?? [])]
      .filter((occurrence) => occurrence.seriesId === calendarSeriesId)
      .map((occurrence) => occurrence.eventId)
    /* Only a meeting with no series, in the series' own context: one that was
       put in another series, or lives elsewhere, is left as it is. */
    await tx
      .update(meetings)
      .set({ seriesId: series.id, updatedAt: new Date() })
      .where(
        and(
          inArray(meetings.calendarEventId, eventIds),
          isNull(meetings.seriesId),
          eq(meetings.contextId, series.contextId),
        ),
      )
    return series
  })
}

export type UpcomingEntry = {
  startsAt: Date
  /** Null for a meeting made by hand. */
  event: CalendarEvent | null
  /** Null until the event is prepped. */
  meeting: MeetingView | null
  series: { id: string; name: string } | null
  /**
   * Meetings that could be this event's, to attach: undated stubs whose people
   * are all at it, and meetings made by hand that overlap it with someone in
   * common or the same title.
   */
  stubs: MeetingView[]
}

/* A meeting made by hand at the time of an event, for the same thing. */
function sameMeeting(meeting: MeetingView, event: CalendarEvent, present: Set<string>): boolean {
  if (meeting.calendarEventId || !meeting.startsAt) return false
  const end = event.endsAt ?? new Date(event.startsAt.getTime() + 3_600_000)
  const meetingEnd = meeting.endsAt ?? new Date(meeting.startsAt.getTime() + 3_600_000)
  if (meeting.startsAt >= end || meetingEnd <= event.startsAt) return false
  return (
    meeting.title.trim().toLowerCase() === event.title.trim().toLowerCase() ||
    meeting.people.some((person) => present.has(person.id))
  )
}

/* Rounded so that every page load in the same hour asks the feed for the same
   range and its cache can answer. */
function feedRange(now: Date, days: number): { from: Date; to: Date } {
  const from = new Date(now)
  from.setMinutes(0, 0, 0)
  return { from, to: new Date(from.getTime() + days * 86_400_000) }
}

/** The events of one recurring event that a context's feed still holds. */
export async function findOccurrences(
  exec: Executor,
  contextId: string,
  calendarSeriesId: string,
  now: Date = new Date(),
  days = 60,
): Promise<CalendarEvent[]> {
  const events = await listEventsIn(exec, { contextId, ...feedRange(now, days) })
  return events.filter((candidate) => candidate.seriesId === calendarSeriesId)
}

/**
 * One event of a context's feed, looked up again at the moment it is acted on.
 * `around` is when the card said it starts, so an event in the past (or far
 * ahead) is looked for there rather than in the coming weeks.
 */
export async function findEvent(
  exec: Executor,
  contextId: string,
  eventId: string,
  now: Date = new Date(),
  days = 60,
  around?: Date,
): Promise<CalendarEvent> {
  const range =
    around && !Number.isNaN(around.getTime())
      ? { from: new Date(around.getTime() - 86_400_000), to: new Date(around.getTime() + 86_400_000) }
      : feedRange(now, days)
  const events = await listEventsIn(exec, { contextId, ...range })
  const event = events.find((candidate) => candidate.eventId === eventId)
  if (!event) throw new ValidationError('That event is no longer on the calendar.')
  return event
}

/**
 * What is coming up in a context: calendar events and hand-made meetings in one
 * list, each event carrying its meeting if it has one. An event is listed in
 * the one context it belongs to (see `eventsHere`), which is its calendar's
 * only until its meeting or its series is moved.
 */
export async function listUpcoming(
  exec: Executor,
  contextId: string,
  /* `from` starts the window somewhere ahead (the date jump); `days` is how far it reaches.
     `events` stands in for what this context's calendars hold, for tests. */
  opts: { now?: Date; from?: Date; days?: number; events?: CalendarEvent[] } = {},
): Promise<{ entries: UpcomingEntry[]; stubs: MeetingView[] }> {
  const now = opts.now ?? new Date()
  const range = feedRange(opts.from && opts.from > now ? opts.from : now, opts.days ?? 14)

  const [events, dated, stubs, allSeries] = await Promise.all([
    opts.events
      ? eventsHere(
          exec,
          contextId,
          opts.events.map((event) => ({ event, contextId })),
        )
      : listEventsIn(exec, { contextId, ...range }),
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
  /* A meeting made by hand that is plainly this event's is shown on the event,
     offered to attach, rather than as a second card beside it. */
  const offered = new Set<string>()
  for (const event of events) {
    if (event.allDay) continue
    const meeting = byEvent.get(event.eventId) ?? null
    const series =
      (event.seriesId ? byCalendarSeries.get(event.seriesId) : undefined) ??
      (event.scope?.kind === 'series' ? allSeries.find((one) => one.id === event.scope!.id) : undefined) ??
      null

    const present = new Set([...matchedPeople(event), ...(series?.people.map((p) => p.id) ?? [])])
    const twins = meeting ? [] : dated.filter((one) => sameMeeting(one, event, present))
    for (const twin of twins) offered.add(twin.id)
    const fitting = meeting
      ? []
      : [
          ...twins,
          ...stubs.filter(
            (stub) => stub.people.length > 0 && stub.people.every((person) => present.has(person.id)),
          ),
        ]

    entries.push({
      startsAt: event.startsAt,
      event,
      meeting,
      /* A prepped meeting shows the series its row says, even where the
         calendar would say otherwise: it may have been taken out of it. */
      series: meeting ? meeting.series : series ? { id: series.id, name: series.name } : null,
      stubs: fitting,
    })
  }

  for (const meeting of dated) {
    if (offered.has(meeting.id)) continue
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

/**
 * What happened in a context in a window that has passed: the meetings held,
 * and the calendar events nobody prepped, so one can still be given a meeting
 * (to log its notes against). Latest first.
 */
export async function listPast(
  exec: Executor,
  contextId: string,
  opts: { now?: Date; before?: Date; days?: number; events?: CalendarEvent[] } = {},
): Promise<{ entries: UpcomingEntry[]; from: Date; to: Date }> {
  const now = opts.now ?? new Date()
  const to = opts.before && opts.before < now ? opts.before : now
  const from = new Date(to.getTime() - (opts.days ?? 14) * 86_400_000)

  const [events, held] = await Promise.all([
    opts.events
      ? eventsHere(
          exec,
          contextId,
          opts.events.map((event) => ({ event, contextId })),
        )
      : listEventsIn(exec, { contextId, from, to }),
    listMeetings(exec, { contextId, when: 'past', now, topLevelOnly: true, between: { from, to } }),
  ])

  /* An event whose meeting is still under way, or was moved off its time, is not "never prepped". */
  const prepped = new Set(
    (
      await exec
        .select({ eventId: meetings.calendarEventId })
        .from(meetings)
        .where(
          inArray(
            meetings.calendarEventId,
            events.length > 0 ? events.map((event) => event.eventId) : [''],
          ),
        )
    ).map((row) => row.eventId),
  )

  const entries: UpcomingEntry[] = [
    ...held.map((meeting) => ({
      startsAt: meeting.startsAt!,
      event: null,
      meeting,
      series: meeting.series,
      stubs: [],
    })),
    ...events
      .filter((event) => !event.allDay && !prepped.has(event.eventId) && event.startsAt < to)
      .map((event) => ({ startsAt: event.startsAt, event, meeting: null, series: null, stubs: [] })),
  ]
  entries.sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime())
  return { entries, from, to }
}

// ─── a series and its recurring event ────────────────────────────────────────

/** How often a recurring event comes round, read from its occurrences: "weekly", or null when they are irregular. */
export function cadenceOf(occurrences: CalendarEvent[]): string | null {
  const starts = occurrences.map((one) => one.startsAt.getTime()).sort((a, b) => a - b)
  if (starts.length < 2) return null
  const gaps = starts.slice(1).map((at, index) => Math.round((at - starts[index]!) / 86_400_000))
  const gap = gaps[0]!
  if (!gaps.every((one) => Math.abs(one - gap) <= (gap >= 28 ? 3 : 0))) return null
  if (gap === 1) return 'daily'
  if (gap === 7) return 'weekly'
  if (gap % 7 === 0 && gap <= 28) return `every ${gap / 7} weeks`
  if (gap >= 28 && gap <= 31) return 'monthly'
  return null
}

export type CalendarLink = {
  title: string
  /** The next occurrence on the feed, if any is within reach. */
  next: CalendarEvent | null
  cadence: string | null
  /** The meeting already made for that next occurrence. */
  nextMeetingId: string | null
}

/** What a series is linked to on the calendar, as the feed sees it now. */
export async function calendarLinkOf(
  exec: Executor,
  view: SeriesView,
  now: Date = new Date(),
): Promise<CalendarLink | null> {
  if (!view.calendarSeriesId) return null
  const occurrences = await findOccurrences(exec, view.contextId, view.calendarSeriesId, now)
  const next = occurrences[0] ?? null
  const meeting = next ? await findMeetingByEvent(exec, next.eventId) : null
  return {
    title: next?.title ?? view.name,
    next,
    cadence: cadenceOf(occurrences),
    nextMeetingId: meeting?.id ?? null,
  }
}

/** The recurring events on a context's calendars that no series has yet: one entry each, its next occurrence. */
export async function unlinkedRecurring(
  exec: Executor,
  contextId: string,
  now: Date = new Date(),
): Promise<Array<{ calendarSeriesId: string; next: CalendarEvent; cadence: string | null }>> {
  const events = await listEventsIn(exec, { contextId, ...feedRange(now, 60) })
  const bySeries = new Map<string, CalendarEvent[]>()
  for (const event of events) {
    if (!event.seriesId || event.allDay) continue
    bySeries.set(event.seriesId, [...(bySeries.get(event.seriesId) ?? []), event])
  }
  const linked = await exec
    .select({ id: series.calendarSeriesId })
    .from(series)
    .where(inArray(series.calendarSeriesId, bySeries.size > 0 ? [...bySeries.keys()] : ['']))
  const taken = new Set(linked.map((row) => row.id))
  return [...bySeries]
    .filter(([id]) => !taken.has(id))
    .map(([calendarSeriesId, occurrences]) => ({
      calendarSeriesId,
      next: occurrences[0]!,
      cadence: cadenceOf(occurrences),
    }))
}

/**
 * Link a series made by hand to a recurring event. Occurrences already prepped
 * with no series join it, as "make a series" would have them.
 */
export async function linkSeriesCalendar(
  exec: Executor,
  actor: ActorContext,
  seriesId: string,
  calendarSeriesId: string,
  now: Date = new Date(),
): Promise<SeriesView> {
  const view = await getSeries(exec, seriesId)
  const occurrences = await findOccurrences(exec, view.contextId, calendarSeriesId, now)
  return inTransaction(exec, async (tx) => {
    await updateSeries(tx, seriesId, { calendarSeriesId })
    const ids = occurrences.map((occurrence) => occurrence.eventId)
    if (ids.length > 0) {
      const adopted = await tx
        .update(meetings)
        .set({ seriesId, updatedAt: new Date() })
        .where(and(inArray(meetings.calendarEventId, ids), isNull(meetings.seriesId), eq(meetings.contextId, view.contextId)))
        .returning({ id: meetings.id })
      for (const { id } of adopted) await joinRoster(tx, actor, id, now)
    }
    return getSeries(tx, seriesId)
  })
}
