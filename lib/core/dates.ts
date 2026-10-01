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
