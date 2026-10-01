/*
 * The calendar feed: Google Calendar events from every calendar bound to a
 * context, as single occurrences, with attendees matched to people.
 *
 * Read-only and never stored. A meeting row exists only once John preps one
 * (docs/SPEC.md, "Meetings are light and created lazily").
 */

import {
  clearConnectionError,
  listBindings,
  recordConnectionError,
  withAccessToken,
} from '../connect/connections'
import { fetchGoogleCalendarEvents, type GoogleCalendarEvent } from '../connect/google/calendar'
import { fromLocalInput } from '../core/dates'
import { isNull } from 'drizzle-orm'
import type { Executor } from '../core/types'
import { personEmails, users } from '../db/schema'
import { findSelf } from '../directory/people'

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
}

interface CacheEntry {
  events: CalendarEvent[]
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

/**
 * The events of a context's bound calendars in a range, soonest first.
 *
 * One calendar failing does not fail the feed: the failure is recorded on its
 * connection, the other calendars are still listed, and the partial answer is
 * not cached.
 */
export async function listEvents(
  exec: Executor,
  {
    contextId,
    from,
    to,
    timeZone,
  }: {
    contextId: string
    from: Date
    to: Date
    /** Where all-day events begin. John's own zone when not given. */
    timeZone?: string | null
  },
  /* `fetchEvents` stands in for Google, for tests; no token is asked for then. */
  deps?: { fetchEvents?: FetchEvents },
): Promise<CalendarEvent[]> {
  const cacheKey = `${contextId}|${from.toISOString()}|${to.toISOString()}`
  const cached = feedCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.events

  const binds = await listBindings(exec, { contextId })
  if (binds.length === 0) return []

  const zone = timeZone === undefined ? await userTimeZone(exec) : timeZone

  const emailToPersonId = new Map<string, string>()
  for (const row of await exec.select().from(personEmails)) {
    emailToPersonId.set(row.email.toLowerCase(), row.personId)
  }

  /* Keyed by event id: an event on two bound calendars (John's own and a
     shared one he is invited from) is one event, and one meeting. */
  const byId = new Map<string, CalendarEvent>()
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
        if (byId.has(event.id)) continue

        const startsAt = moment(event.start, zone)
        if (!startsAt) continue

        const attendees = event.attendees ?? []
        // What John has declined is not on his calendar as far as prep goes.
        if (attendees.some((att) => att.self && att.responseStatus === 'declined')) continue

        byId.set(event.id, {
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

  const events = [...byId.values()].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
  if (failed.size === 0) feedCache.set(cacheKey, { events, expiresAt: Date.now() + CACHE_TTL_MS })
  return events
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
  const emails = await exec.select().from(personEmails)

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
