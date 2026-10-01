/*
 * Google Calendar over REST, not the googleapis package, to keep dependencies
 * minimal. Read-only: the calendar is a feed.
 *
 * Lifted and trimmed from ../Meeter/lib/connect/google/calendar.ts.
 */

import { GoogleUnauthorized, googleErrorDetail } from '../connections'

export interface GoogleCalendarEvent {
  id?: string
  recurringEventId?: string
  /* 'default' for a meeting; Google also files working locations, focus time,
     out-of-office blocks and birthdays as events. */
  eventType?: string
  summary?: string
  description?: string
  location?: string
  /* `dateTime` for a timed event; `date` ('YYYY-MM-DD') for an all-day one,
     whose end date is the day after its last. */
  start?: { dateTime?: string; date?: string; timeZone?: string }
  end?: { dateTime?: string; date?: string; timeZone?: string }
  status?: string
  htmlLink?: string
  attendees?: Array<{
    email?: string
    displayName?: string
    self?: boolean
    /* A room or a piece of equipment. */
    resource?: boolean
    responseStatus?: string
  }>
}

/* A runaway guard, not a limit anyone should meet: 20 pages is 50,000 events. */
const MAX_PAGES = 20

/**
 * A calendar's events in a range, with each recurring event expanded into its
 * occurrences. Follows `nextPageToken` to the end: one page is not the range.
 */
export async function fetchGoogleCalendarEvents(
  token: string,
  calendarId: string,
  { from, to }: { from: Date; to: Date },
): Promise<GoogleCalendarEvent[]> {
  const events: GoogleCalendarEvent[] = []
  let pageToken: string | undefined

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      singleEvents: 'true',
      orderBy: 'startTime',
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      maxResults: '2500',
    })
    if (pageToken) params.set('pageToken', pageToken)

    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
      { headers: { authorization: `Bearer ${token}` } },
    )
    if (response.status === 401) throw new GoogleUnauthorized()
    if (!response.ok) {
      throw new Error(`Google Calendar refused ${calendarId}: ${await googleErrorDetail(response)}`)
    }

    const data = (await response.json()) as {
      items?: GoogleCalendarEvent[]
      nextPageToken?: string
    }
    events.push(...(data.items ?? []))
    pageToken = data.nextPageToken
    if (!pageToken) break
  }

  return events
}
