/*
 * When each agenda line starts.
 *
 * One clock walks the agenda in the order it is written. It starts at the
 * meeting's start, on the user's wall clock; a line moves it on by its minutes;
 * a pinned start ('HH:MM') sets it, whatever came before.
 *
 * A section with minutes of its own is a timebox: that is its length. Its
 * lines with minutes use them up in order, and those without share what is
 * left equally (`shareMinutes`, computed, never stored). What follows starts
 * at the section's end, however its lines ran. A section with no minutes of
 * its own lasts as long as its lines.
 *
 * Three things can go wrong with a timed agenda and all are reported: what
 * precedes a pinned start runs past it, a section's lines ask for more than
 * its timebox (`overBudgetMinutes`), and the whole runs past the meeting's
 * end.
 *
 * Pure: no database. `lines.ts` hands it the nodes it has built.
 */

import { clockIn } from '../core/dates'

type Slot = {
  minutes: number | null
  pinnedStart: string | null
  start: string | null
  overrunMinutes?: number
}

type LineSlot = Slot & {
  /** In a timebox, a line with no minutes of its own gets an equal share of what is left. */
  shareMinutes?: number
}

type SectionSlot = Slot & {
  /** Its lines' own minutes, when it is a timebox: "30 / 45 min". */
  usedMinutes?: number
  /** By how much its lines' own minutes exceed its timebox. */
  overBudgetMinutes?: number
}

export type SchedulableNode =
  | (LineSlot & { type: 'line' })
  | (SectionSlot & { type: 'section'; lines: LineSlot[] })

export type Schedule = {
  /** Planned minutes, whether or not the meeting has a start to count from. */
  totalMinutes: number
  /** When the agenda finishes; the meeting's own end when nothing is timed. */
  end: string | null
  /** Minutes lost to pinned starts that came too soon, plus minutes past the meeting's end. */
  overflowMinutes: number
}

const CLOCK = /^(\d{1,2}):(\d{2})$/

/** Minutes since midnight, or null for anything that is not a time of day. */
export function parseClock(value: string | null | undefined): number | null {
  const match = CLOCK.exec(value ?? '')
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

/* An agenda that runs past midnight wraps round rather than reading 25:10. */
function toClock(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`
}

/**
 * Fill in `start` on every node (and `minutes` on each section), in place.
 * With no meeting start and no pinned start there is nothing to count from, and
 * every start stays null.
 */
export function scheduleAgenda(
  nodes: SchedulableNode[],
  meeting: { startsAt: Date | null; endsAt: Date | null; timeZone?: string | null },
): Schedule {
  const startsAt = meeting.startsAt
  const opening = startsAt ? parseClock(clockIn(startsAt, meeting.timeZone)) : null

  let clock = opening
  let totalMinutes = 0
  let overflowMinutes = 0

  const arrive = (slot: Slot) => {
    delete slot.overrunMinutes
    const pinned = parseClock(slot.pinnedStart)
    if (pinned !== null) {
      if (clock !== null && clock > pinned) {
        slot.overrunMinutes = clock - pinned
        overflowMinutes += clock - pinned
      }
      clock = pinned
    }
    slot.start = clock === null ? null : toClock(clock)
  }
  const spend = (minutes: number) => {
    totalMinutes += minutes
    if (clock !== null) clock += minutes
  }

  for (const node of nodes) {
    arrive(node)
    if (node.type === 'line') {
      spend(node.minutes ?? 0)
      continue
    }

    delete node.usedMinutes
    delete node.overBudgetMinutes
    const ofLines = node.lines.reduce((sum, line) => sum + (line.minutes ?? 0), 0)
    const box = node.minutes ?? 0
    if (box === 0) {
      // No timebox: as long as its lines.
      for (const line of node.lines) {
        delete line.shareMinutes
        arrive(line)
        spend(line.minutes ?? 0)
      }
      node.minutes = ofLines > 0 ? ofLines : node.minutes
      continue
    }

    const opensAt = clock
    const unset = node.lines.filter((line) => line.minutes === null || line.minutes === 0)
    const left = Math.max(0, box - ofLines)
    const share = unset.length > 0 ? Math.floor(left / unset.length) : 0
    let extra = unset.length > 0 ? left - share * unset.length : 0
    for (const line of node.lines) {
      delete line.shareMinutes
      arrive(line)
      let minutes = line.minutes ?? 0
      if (unset.includes(line)) {
        // The odd minutes go to the first lines.
        minutes = share + (extra > 0 ? 1 : 0)
        if (extra > 0) extra--
        line.shareMinutes = minutes
      }
      if (clock !== null) clock += minutes
    }
    node.usedMinutes = ofLines
    if (ofLines > box) {
      node.overBudgetMinutes = ofLines - box
      overflowMinutes += ofLines - box
    }
    // The next row starts at the timebox's end, whatever its lines did.
    totalMinutes += box
    if (opensAt !== null) clock = opensAt + box
  }

  let end: string | null = null
  if (clock !== null && totalMinutes > 0) end = toClock(clock)
  else if (meeting.endsAt) end = clockIn(meeting.endsAt, meeting.timeZone)

  if (startsAt && meeting.endsAt && opening !== null && clock !== null) {
    const closing = opening + Math.round((meeting.endsAt.getTime() - startsAt.getTime()) / 60_000)
    overflowMinutes += Math.max(0, clock - closing)
  }

  return { totalMinutes, end, overflowMinutes }
}
