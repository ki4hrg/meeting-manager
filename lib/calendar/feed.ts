/*
 * The calendar feed: Google Calendar events from every bound calendar, as
 * single occurrences, with attendees matched to people, and each shown in the
 * one context it belongs to.
 *
 * Read-only and never stored. A meeting row exists only once John preps one
 * (docs/SPEC.md, "Meetings are light and created lazily"); once it does, it
 * follows its event when the calendar moves it.
 */

import {
  clearConnectionError,
  listBindings,
  recordConnectionError,
  scopeOf,
  withAccessToken,
  type BindingScope,
} from '../connect/connections'
import { fetchGoogleCalendarEvents, type GoogleCalendarEvent } from '../connect/google/calendar'
import { fromLocalInput } from '../core/dates'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { Executor } from '../core/types'
import { meetings, series, users } from '../db/schema'
import { notDeleted } from '../db/shelf'
import { findSelf, liveEmails } from '../directory/people'

export interface CalendarEvent {
  calendarId: string
  eventId: string
  seriesId: string | null
  title: string
  startsAt: Date
  endsAt: Date | null
  allDay: boolean
  attendees: { personId?: string; email: string; name: string | null; declined: boolean }[]
  location: string | null
  htmlLink: string | null
  /** The project, series or group its calendar is bound to, which a meeting prepped from it takes. */
  scope?: BindingScope
}

interface CacheEntry {
  events: BoundEvent[]
  expiresAt: number
}

const CACHE_TTL_MS = 2 * 60 * 1000 // 2 minutes

/* On globalThis for the reason the database pool is (lib/db/index.ts): Next
   compiles a module once per server layer, and a cache per copy would leave a
   page reading entries that a route handler or an action had just cleared. */
const globalForFeed = globalThis as unknown as { mmFeedCache?: Map<string, CacheEntry> }
const feedCache = (globalForFeed.mmFeedCache ??= new Map<string, CacheEntry>())

/** Forget what was fetched: after a binding or a connection changes, and in tests. */
export function clearFeedCache(): void {
  feedCache.clear()
}

/* Things Google keeps on a calendar that are not meetings. */
const NOT_MEETINGS = new Set(['workingLocation', 'focusTime', 'outOfOffice', 'birthday'])

type FetchEvents = (
  token: string,
  calendarId: string,
  range: { from: Date; to: Date },
) => Promise<GoogleCalendarEvent[]>

/* An all-day event is a day, not an instant: it starts at midnight where John
   is. `new Date('2026-10-05')` would be midnight UTC, the evening before for
   anyone west of Greenwich. */
function moment(
  at: { dateTime?: string; date?: string } | undefined,
  timeZone: string | null,
): Date | null {
  if (at?.dateTime) {
    const value = new Date(at.dateTime)
    return Number.isNaN(value.getTime()) ? null : value
  }
  if (at?.date) {
    try {
      return fromLocalInput(`${at.date}T00:00`, timeZone)
    } catch {
      return null
    }
  }
  return null
}

/* John's zone, for a caller that did not say. One user, one row. */
async function userTimeZone(exec: Executor): Promise<string | null> {
  const [row] = await exec
    .select({ timeZone: users.timeZone })
    .from(users)
    .where(isNull(users.deletedAt))
    .limit(1)
  return row?.timeZone ?? null
}

/* An event as a bound calendar holds it, with the context that calendar is bound to. */
export type BoundEvent = { event: CalendarEvent; contextId: string }

type Range = {
  from: Date
  to: Date
  /** Where all-day events begin. John's own zone when not given. */
  timeZone?: string | null
}

/*
 * Every bound calendar in a range, whichever context it is bound to: a meeting
 * can be moved out of its calendar's context, so one context's list can need
 * another's calendar.
 *
 * One calendar failing does not fail the feed: the failure is recorded on its
 * connection, the other calendars are still listed, and the partial answer is
 * not cached.
 */
async function fetchBound(
  exec: Executor,
  { from, to, timeZone }: Range,
  deps?: { fetchEvents?: FetchEvents },
): Promise<BoundEvent[]> {
  const cacheKey = `${from.toISOString()}|${to.toISOString()}`
  const cached = feedCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.events

  const binds = await listBindings(exec)
  if (binds.length === 0) return []

  const zone = timeZone === undefined ? await userTimeZone(exec) : timeZone

  const emailToPersonId = new Map<string, string>()
  for (const row of await liveEmails(exec)) {
    emailToPersonId.set(row.email.toLowerCase(), row.personId)
  }

  /* Keyed by context and event id: an event on two calendars bound to one
     context (John's own and a shared one he is invited from) is one event
     there, and one meeting. */
  const seen = new Map<string, BoundEvent>()
  /* By connection, since several calendars share one: a calendar that worked
     must not clear the error another calendar of the same account just set. */
  const failed = new Set<string>()

  for (const binding of binds) {
    try {
      const fetched = deps?.fetchEvents
        ? await deps.fetchEvents('', binding.externalId, { from, to })
        : await withAccessToken(exec, binding.connectionId, (token) =>
            fetchGoogleCalendarEvents(token, binding.externalId, { from, to }),
          )

      for (const event of fetched) {
        if (!event.id || event.status === 'cancelled') continue
        if (event.eventType && NOT_MEETINGS.has(event.eventType)) continue
        const key = `${binding.contextId}|${event.id}`
        const already = seen.get(key)
        if (already) {
          // A calendar bound to something narrower says more about the event.
          already.event.scope ??= scopeOf(binding)
          continue
        }

        const startsAt = moment(event.start, zone)
        if (!startsAt) continue

        const attendees = [...(event.attendees ?? [])]
        // What John has declined is not on his calendar as far as prep goes.
        if (attendees.some((att) => att.self && att.responseStatus === 'declined')) continue
        /* Whoever sent the invitation is at the meeting, listed or not. */
        const organizer = event.organizer
        if (
          organizer?.email &&
          !organizer.self &&
          !attendees.some((att) => att.email?.toLowerCase() === organizer.email!.toLowerCase())
        ) {
          attendees.push({ email: organizer.email, displayName: organizer.displayName })
        }

        seen.set(key, {
          contextId: binding.contextId,
          event: {
            calendarId: binding.externalId,
            eventId: event.id,
            seriesId: event.recurringEventId || null,
            title: event.summary || '(Untitled)',
            startsAt,
            endsAt: moment(event.end, zone),
            allDay: !event.start?.dateTime,
            attendees: attendees
              // Not John, and not the room.
              .filter((att) => !att.self && !att.resource)
              .map((att) => ({
                personId: att.email ? emailToPersonId.get(att.email.toLowerCase()) : undefined,
                email: att.email || '',
                name: att.displayName || null,
                declined: att.responseStatus === 'declined',
              })),
            location: event.location || null,
            htmlLink: event.htmlLink || null,
            scope: scopeOf(binding),
          },
        })
      }
    } catch (err) {
      failed.add(binding.connectionId)
      await recordConnectionError(exec, binding.connectionId, err)
    }
  }
  for (const connectionId of new Set(binds.map((binding) => binding.connectionId))) {
    if (!failed.has(connectionId)) await clearConnectionError(exec, connectionId)
  }

  const events = [...seen.values()].sort(
    (a, b) => a.event.startsAt.getTime() - b.event.startsAt.getTime(),
  )
  await followMoves(exec, events)
  if (failed.size === 0) feedCache.set(cacheKey, { events, expiresAt: Date.now() + CACHE_TTL_MS })
  return events
}

function sameMoment(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null)
}

/*
 * A meeting whose event the calendar has moved takes the event's new time.
 * Compared with where the calendar last had the event, not with the meeting's
 * own time, so a meeting moved by hand stays where it was put until the
 * calendar moves the event again.
 */
async function followMoves(exec: Executor, bound: BoundEvent[]): Promise<void> {
  if (bound.length === 0) return
  const byId = new Map(bound.map(({ event }) => [event.eventId, event]))
  const rows = await exec
    .select({
      id: meetings.id,
      eventId: meetings.calendarEventId,
      startsAt: meetings.calendarStartsAt,
      endsAt: meetings.calendarEndsAt,
    })
    .from(meetings)
    .where(and(inArray(meetings.calendarEventId, [...byId.keys()]), notDeleted(meetings)))
  for (const row of rows) {
    const event = byId.get(row.eventId!)
    if (!event || (sameMoment(row.startsAt, event.startsAt) && sameMoment(row.endsAt, event.endsAt))) continue
    await exec
      .update(meetings)
      .set({
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        calendarStartsAt: event.startsAt,
        calendarEndsAt: event.endsAt,
        updatedAt: new Date(),
      })
      .where(eq(meetings.id, row.id))
  }
}

/**
 * What a context's own bound calendars hold in a range, soonest first. This is
 * the calendars as they are; `listEventsIn` is where each event belongs.
 */
export async function listEvents(
  exec: Executor,
  { contextId, ...range }: Range & { contextId: string },
  /* `fetchEvents` stands in for Google, for tests; no token is asked for then. */
  deps?: { fetchEvents?: FetchEvents },
): Promise<CalendarEvent[]> {
  const bound = await fetchBound(exec, range, deps)
  return bound.filter((one) => one.contextId === contextId).map((one) => one.event)
}

/**
 * The events that belong in a context, out of everything the calendars hold.
 *
 * An event lives where its meeting does; with no meeting yet, where the series
 * its recurring event maps to does; failing both, in the context its calendar
 * is bound to. So a meeting moved out of its calendar's context takes its
 * event with it, the next occurrences of a moved series follow the series, and
 * neither is offered a second time where it came from.
 */
export async function eventsHere(
  exec: Executor,
  contextId: string,
  bound: BoundEvent[],
): Promise<CalendarEvent[]> {
  if (bound.length === 0) return []
  const eventIds = [...new Set(bound.map((one) => one.event.eventId))]
  const seriesIds = [...new Set(bound.flatMap((one) => (one.event.seriesId ? [one.event.seriesId] : [])))]

  const [prepped, mapped] = await Promise.all([
    exec
      .select({ eventId: meetings.calendarEventId, contextId: meetings.contextId, archivedAt: meetings.archivedAt })
      .from(meetings)
      .where(and(inArray(meetings.calendarEventId, eventIds), notDeleted(meetings))),
    seriesIds.length === 0
      ? []
      : exec
          .select({ seriesId: series.calendarSeriesId, contextId: series.contextId })
          .from(series)
          .where(and(inArray(series.calendarSeriesId, seriesIds), notDeleted(series))),
  ])
  const meetingHome = new Map(prepped.map((row) => [row.eventId!, row.contextId]))
  // An archived meeting puts its event away: it shows nowhere.
  const putAway = new Set(prepped.filter((row) => row.archivedAt).map((row) => row.eventId!))
  const seriesHome = new Map(mapped.map((row) => [row.seriesId!, row.contextId]))

  const here = new Map<string, CalendarEvent>()
  for (const { event, contextId: boundTo } of bound) {
    if (putAway.has(event.eventId)) continue
    const home =
      meetingHome.get(event.eventId) ??
      (event.seriesId ? seriesHome.get(event.seriesId) : undefined) ??
      boundTo
    if (home === contextId && !here.has(event.eventId)) here.set(event.eventId, event)
  }
  return [...here.values()].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
}

/** The feed as one context sees it: every event that belongs there, soonest first. */
export async function listEventsIn(
  exec: Executor,
  { contextId, ...range }: Range & { contextId: string },
  deps?: { fetchEvents?: FetchEvents },
): Promise<CalendarEvent[]> {
  return eventsHere(exec, contextId, await fetchBound(exec, range, deps))
}

/**
 * Match attendee emails to local people (case-insensitive, skip John).
 */
export async function matchPeople(
  exec: Executor,
  attendees: Array<{
    email: string
    name: string | null
    declined: boolean
  }>,
): Promise<Array<{ personId: string; name: string }>> {
  const self = await findSelf(exec)

  // Fetch all email records
  const emails = await liveEmails(exec)

  const result: Array<{ personId: string; name: string }> = []
  const seen = new Set<string>()

  for (const attendee of attendees) {
    if (!attendee.email) continue
    const lowerEmail = attendee.email.toLowerCase()

    // Skip John's email
    if (self) {
      const selfEmails = emails.filter((e) => e.personId === self.id)
      if (selfEmails.some((e) => e.email.toLowerCase() === lowerEmail)) {
        continue
      }
    }

    // Find matching person
    const email = emails.find((e) => e.email.toLowerCase() === lowerEmail)
    if (email) {
      if (!seen.has(email.personId)) {
        result.push({
          personId: email.personId,
          name: attendee.name || attendee.email,
        })
        seen.add(email.personId)
      }
    }
  }

  return result
}
