/* Wall-clock times in the user's zone, whatever zone the server runs in. */

import { describe, expect, it } from 'vitest'
import { clockIn, dateRelativeDays, formatClock, fromLocalInput, toLocalInput, todayIn } from '../lib/core/dates'

const CHICAGO = 'America/Chicago'

describe('fromLocalInput', () => {
  it('reads a datetime-local value on the zone\'s clock', () => {
    // CDT is UTC-5 in October, CST is UTC-6 in January.
    expect(fromLocalInput('2026-10-07T09:00', CHICAGO).toISOString()).toBe('2026-10-07T14:00:00.000Z')
    expect(fromLocalInput('2026-01-15T09:00', CHICAGO).toISOString()).toBe('2026-01-15T15:00:00.000Z')
    expect(fromLocalInput('2026-10-07T09:00', 'Asia/Kolkata').toISOString()).toBe('2026-10-07T03:30:00.000Z')
    expect(fromLocalInput('2026-10-07T09:00', 'UTC').toISOString()).toBe('2026-10-07T09:00:00.000Z')
  })

  it('crosses the date line of UTC', () => {
    expect(fromLocalInput('2026-10-07T22:30', CHICAGO).toISOString()).toBe('2026-10-08T03:30:00.000Z')
    expect(todayIn(CHICAGO, fromLocalInput('2026-10-07T22:30', CHICAGO))).toBe('2026-10-07')
  })

  it('is right on either side of the spring change', () => {
    // 2026-03-08: 2:00 CST becomes 3:00 CDT.
    expect(fromLocalInput('2026-03-08T01:30', CHICAGO).toISOString()).toBe('2026-03-08T07:30:00.000Z')
    expect(fromLocalInput('2026-03-08T03:30', CHICAGO).toISOString()).toBe('2026-03-08T08:30:00.000Z')
  })

  it('moves a time inside the skipped hour forward', () => {
    const moment = fromLocalInput('2026-03-08T02:30', CHICAGO)
    expect(moment.toISOString()).toBe('2026-03-08T08:30:00.000Z')
    expect(toLocalInput(moment, CHICAGO)).toBe('2026-03-08T03:30')
  })

  it('takes the first of a repeated hour in autumn', () => {
    // 2026-11-01: 2:00 CDT becomes 1:00 CST, so 1:30 happens twice.
    expect(fromLocalInput('2026-11-01T01:30', CHICAGO).toISOString()).toBe('2026-11-01T06:30:00.000Z')
    expect(fromLocalInput('2026-11-01T02:30', CHICAGO).toISOString()).toBe('2026-11-01T08:30:00.000Z')
  })

  it('refuses what is not a date and time', () => {
    expect(() => fromLocalInput('tomorrow', CHICAGO)).toThrow('not a date and time')
    expect(() => fromLocalInput('2026-02-31T09:00', CHICAGO)).toThrow('not a date and time')
  })
})

describe('toLocalInput', () => {
  it('round-trips', () => {
    for (const value of ['2026-10-07T09:00', '2026-12-31T23:59', '2026-07-01T00:00']) {
      expect(toLocalInput(fromLocalInput(value, CHICAGO), CHICAGO)).toBe(value)
    }
  })

  it('never shows midnight as 24:00', () => {
    expect(toLocalInput(new Date('2026-10-07T05:00:00Z'), CHICAGO)).toBe('2026-10-07T00:00')
    expect(clockIn(new Date('2026-10-07T05:00:00Z'), CHICAGO)).toBe('00:00')
  })
})

describe('formatClock', () => {
  it('reads as a twelve-hour clock', () => {
    expect(formatClock('00:05')).toBe('12:05 AM')
    expect(formatClock('09:00')).toBe('9:00 AM')
    expect(formatClock('12:00')).toBe('12:00 PM')
    expect(formatClock('15:05')).toBe('3:05 PM')
  })
})

describe('dateRelativeDays', () => {
  it('dates the words that name one day, once', () => {
    // 2026-10-26 is a Monday.
    expect(dateRelativeDays('Meet tomorrow, not yesterday; today is busy.', '2026-10-26', '2026-10-27')).toBe(
      'Meet tomorrow (October 27), not yesterday (October 25); today (October 26) is busy.',
    )
    expect(dateRelativeDays('Due this Friday.', '2026-10-26', '2026-10-27')).toBe('Due this Friday (October 30).')
    expect(dateRelativeDays('Tomorrow (October 27) it is.', '2026-10-26', '2026-10-27')).toBe('Tomorrow (October 27) it is.')
    expect(dateRelativeDays('On Friday, or next week.', '2026-10-26', '2026-10-27')).toBe('On Friday, or next week.')
    expect(dateRelativeDays('Tomorrow', '2026-12-31', '2027-01-02')).toBe('Tomorrow (January 1)')
    expect(dateRelativeDays('Tomorrow', '2024-12-31', '2026-10-27')).toBe('Tomorrow (January 1, 2025)')
  })
})
