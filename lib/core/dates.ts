/*
 * Calendar days, as 'YYYY-MM-DD' strings.
 *
 * A deadline is a day, not an instant, and which day "today" is depends on
 * where John is. Everything here takes his time zone rather than using UTC.
 */

import { ValidationError } from './types'

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

export function isDay(value: string): boolean {
  const match = DAY.exec(value)
  if (!match) return false
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  // Rejects 2026-02-31, which Date would roll into March.
  return date.toISOString().slice(0, 10) === value
}

/** A day from input, or null when the input is empty. */
export function parseDay(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  if (trimmed === '') return null
  if (!isDay(trimmed)) throw new ValidationError(`${trimmed} is not a date (use YYYY-MM-DD).`)
  return trimmed
}

/** A day so many days on (or back). Calendar days: no time zone enters into it. */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** An IANA zone this runtime knows ("America/Chicago"). */
export function isTimeZone(value: string): boolean {
  if (value.trim() === '') return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

/** Today in the given zone; null means the instance's own. */
export function todayIn(timeZone: string | null | undefined, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone ?? undefined,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/** "Oct 9", with the year only when it is not this one. */
export function formatDay(day: string, today: string): string {
  const [year, month, date] = day.split('-').map(Number)
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: day.slice(0, 4) === today.slice(0, 4) ? undefined : 'numeric',
  }).format(new Date(Date.UTC(year!, month! - 1, date!)))
}

/** "October 9", with the year only when it is not this one: for prose. */
export function formatLongDay(day: string, today: string): string {
  const [year, month, date] = day.split('-').map(Number)
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    year: day.slice(0, 4) === today.slice(0, 4) ? undefined : 'numeric',
  }).format(new Date(Date.UTC(year!, month! - 1, date!)))
}

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

/**
 * Prose written on `day` read on any other: each "tomorrow", "yesterday",
 * "today", "tonight" and "this Friday" gets its date after it, "tomorrow
 * (October 27)". Only the words that name one day for certain; one already
 * followed by a bracket is left as it is.
 */
export function dateRelativeDays(text: string, day: string, today: string): string {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay()
  return text.replace(
    /\b(today|tonight|tomorrow|yesterday|this (?:coming )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday))\b(?!\s*\()/gi,
    (words: string, whole: string, named: string | undefined) => {
      const lower = whole.toLowerCase()
      const offset = named
        ? (WEEKDAY_NAMES.indexOf(named.toLowerCase()) - weekday + 7) % 7
        : lower === 'tomorrow'
          ? 1
          : lower === 'yesterday'
            ? -1
            : 0
      return `${words} (${formatLongDay(addDays(day, offset), today)})`
    },
  )
}

/** "Oct 9, 3:40 PM" in the given zone. */
export function formatMoment(moment: Date, timeZone: string | null | undefined): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone ?? undefined,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(moment)
}

// ─── moments ─────────────────────────────────────────────────────────────────

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/

function wallParts(moment: Date, timeZone: string | null | undefined) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone ?? undefined,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(moment)
  const get = (type: string) => parts.find((part) => part.type === type)!.value
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') }
}

/** The value a `datetime-local` input shows for a moment: 'YYYY-MM-DDTHH:MM' on the zone's clock. */
export function toLocalInput(moment: Date, timeZone: string | null | undefined): string {
  const { year, month, day, hour, minute } = wallParts(moment, timeZone)
  return `${year}-${month}-${day}T${hour}:${minute}`
}

/**
 * The moment a `datetime-local` value names in the given zone. The server's
 * own zone never enters into it.
 *
 * Around a clock change a wall time can name two moments or none: the first
 * is taken when the hour repeats, and a time inside the skipped hour moves
 * forward by the gap (2:30 becomes 3:30), as a calendar would do.
 */
export function fromLocalInput(value: string, timeZone: string | null | undefined): Date {
  const match = LOCAL.exec(value.trim())
  if (!match) throw new ValidationError(`${value} is not a date and time.`)
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ]
  const wall = Date.UTC(year, month - 1, day, hour, minute)
  if (!isDay(value.trim().slice(0, 10)) || hour > 23 || minute > 59) {
    throw new ValidationError(`${value} is not a date and time.`)
  }

  /* How far the zone's clock is ahead of UTC at a given moment. */
  const offsetAt = (instant: number) => {
    const shown = toLocalInput(new Date(instant), timeZone)
    const parts = LOCAL.exec(shown)!.slice(1).map(Number) as [number, number, number, number, number]
    return Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4]) - instant
  }

  const first = wall - offsetAt(wall)
  const settled = wall - offsetAt(first)
  // Inside a skipped hour nothing reads back as what was typed; the first guess is the later reading.
  const exact = toLocalInput(new Date(settled), timeZone) === toLocalInput(new Date(wall), 'UTC')
  return new Date(exact ? settled : first)
}

/** 'HH:MM' on the zone's 24-hour clock. */
export function clockIn(moment: Date, timeZone: string | null | undefined): string {
  const { hour, minute } = wallParts(moment, timeZone)
  return `${hour}:${minute}`
}

/** '15:05' as "3:05 PM". */
export function formatClock(clock: string): string {
  const [hour, minute] = clock.split(':').map(Number)
  const h = ((hour! % 24) + 24) % 24
  return `${h % 12 === 0 ? 12 : h % 12}:${String(minute).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

/** "3:05 PM" in the given zone. */
export function formatTime(moment: Date, timeZone: string | null | undefined): string {
  return formatClock(clockIn(moment, timeZone))
}

/** "Thu, Oct 9", with the year only when it is not this one. */
export function formatWeekday(day: string, today: string): string {
  const [year, month, date] = day.split('-').map(Number)
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: day.slice(0, 4) === today.slice(0, 4) ? undefined : 'numeric',
  }).format(new Date(Date.UTC(year!, month! - 1, date!)))
}

/**
 * When a meeting runs, on the zone's clock: "Thu, Oct 9 · 9:00 AM – 5:00 PM",
 * or with both days when it runs past midnight: "Thu, Oct 9, 9:00 AM – Sat,
 * Oct 11, 5:00 PM".
 */
export function formatSpan(
  startsAt: Date,
  endsAt: Date | null,
  timeZone: string | null | undefined,
  today: string,
): string {
  const day = todayIn(timeZone, startsAt)
  const from = formatTime(startsAt, timeZone)
  if (!endsAt) return `${formatWeekday(day, today)} · ${from}`
  const lastDay = todayIn(timeZone, endsAt)
  const to = formatTime(endsAt, timeZone)
  if (lastDay === day) return `${formatWeekday(day, today)} · ${from === to ? from : `${from} – ${to}`}`
  return `${formatWeekday(day, today)}, ${from} – ${formatWeekday(lastDay, today)}, ${to}`
}
