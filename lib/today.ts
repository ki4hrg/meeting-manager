/*
 * Home: what needs attention today, whichever context it lives in (docs/SPEC.md,
 * build order 6). The one deliberate exception to "nothing is listed across
 * contexts": it only reads, every row keeps its context, and opening a row
 * selects that context first. Archived contexts are left out.
 */

import { inArray } from 'drizzle-orm'
import type { Executor } from './core/types'
import { addDays, fromLocalInput, todayIn } from './core/dates'
import { notes } from './db/schema'
import type { Context } from './directory/contexts'
import { isWaitingOn, splitLater } from './items/horizon'
import { listItems, type ItemView } from './items/items'
import type { CalendarEvent } from './calendar/feed'
import { getMeeting, isOver } from './meetings/meetings'
import { listUpcoming, type UpcomingEntry } from './meetings/prep'
import { pendingByMeeting } from './processing/proposals'

export type Owed = {
  /** Overdue or due today, mine and others' together. */
  due: ItemView[]
  /** Due within the horizon (after today), or parked and back. */
  mine: ItemView[]
  waiting: ItemView[]
  /** Everything else, each list's apart. */
  later: { mine: ItemView[]; waiting: ItemView[] }
}

/* What I owe, and what I am waiting on, in one context. */
async function owedIn(exec: Executor, contextId: string, selfId: string) {
  // An ongoing question is pursued, not owed.
  const mine = (
    await listItems(exec, {
      contextId,
      open: true,
      party: { personId: selfId, role: 'owner' },
    })
  ).filter((item) => !item.ongoing)
  const waiting = (await listItems(exec, { contextId, open: true, kinds: ['question', 'action'] })).filter(isWaitingOn)
  return { mine, waiting }
}

/** I owe and Waiting on across every context given, by horizon, with what is due by today pulled ahead. */
export async function owedEverywhere(
  exec: Executor,
  contexts: Pick<Context, 'id'>[],
  selfId: string,
  today: string,
): Promise<Owed> {
  const lists = await Promise.all(contexts.map((context) => owedIn(exec, context.id, selfId)))
  const mine = splitLater(lists.flatMap((list) => list.mine), today)
  const waiting = splitLater(lists.flatMap((list) => list.waiting), today)
  const byToday = (item: ItemView) => item.dueOn !== null && item.dueOn <= today
  const due = [...mine.now, ...waiting.now]
    .filter(byToday)
    .sort((a, b) => a.dueOn!.localeCompare(b.dueOn!))
  return {
    due,
    mine: mine.now.filter((item) => !byToday(item)),
    waiting: waiting.now.filter((item) => !byToday(item)),
    later: { mine: mine.later, waiting: waiting.later },
  }
}

export type TodayEntry = UpcomingEntry & {
  contextId: string
  /** Over, under way, or still to come. */
  phase: 'done' | 'now' | 'later'
  /** Proposals waiting for review. */
  pending: number
  /** Where a meeting that is over goes next: its proposals, its notes to log, or its recap. */
  step: 'review' | 'log' | 'recap' | null
}

/**
 * Home's meetings, from every context: those of today on the user's clock
 * (the sessions of a meeting rather than the meeting over them), in time
 * order, each marked over, under way or to come; and Next up, what comes
 * after today. No meeting is in both.
 */
export async function meetingsEverywhere(
  exec: Executor,
  contexts: Pick<Context, 'id'>[],
  /* `events` stands in for every calendar, for tests. */
  opts: { timeZone: string | null; now?: Date; limit?: number; events?: CalendarEvent[] },
): Promise<{ today: TodayEntry[]; next: Array<UpcomingEntry & { contextId: string }> }> {
  const now = opts.now ?? new Date()
  const day = todayIn(opts.timeZone, now)
  const from = fromLocalInput(`${day}T00:00`, opts.timeZone)
  const to = fromLocalInput(`${addDays(day, 1)}T00:00`, opts.timeZone)

  // From the start of the day, so what is over since then is still listed.
  const lists = await Promise.all(
    contexts.map(async (context) =>
      (await listUpcoming(exec, context.id, { now: from, events: opts.events })).entries.map((entry) => ({
        ...entry,
        contextId: context.id,
      })),
    ),
  )
  const all = lists.flat().sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
  const next = all.filter((entry) => entry.startsAt >= to).slice(0, opts.limit ?? 12)

  const ended = (entry: UpcomingEntry) =>
    entry.meeting ? isOver(entry.meeting, now) : isOver({ startsAt: entry.startsAt, endsAt: entry.event!.endsAt }, now)
  const todays: Array<UpcomingEntry & { contextId: string }> = []
  for (const entry of all) {
    if (entry.startsAt >= to) continue
    const sessions = (entry.meeting?.sessions ?? []).filter(
      (session) => session.startsAt && session.startsAt >= from && session.startsAt < to,
    )
    if (entry.meeting && sessions.length > 0) {
      // A session reads as its meeting's: "Annual Conference · Day one".
      for (const session of sessions) {
        const view = await getMeeting(exec, session.id)
        todays.push({
          ...entry,
          startsAt: session.startsAt!,
          event: null,
          stubs: [],
          meeting: {
            ...view,
            title: `${entry.meeting.title} · ${view.title}`,
            people: view.people.length > 0 ? view.people : entry.meeting.people,
          },
        })
      }
      continue
    }
    // Begun before today: only while it is still under way.
    if (entry.startsAt < from && ended(entry)) continue
    todays.push(entry)
  }
  todays.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())

  const ids = todays.flatMap((entry) => (entry.meeting ? [entry.meeting.id] : []))
  const pending = new Map<string, number>()
  for (const contextId of new Set(todays.map((entry) => entry.contextId))) {
    for (const [id, count] of await pendingByMeeting(exec, contextId)) pending.set(id, count)
  }
  const noted = new Set(
    ids.length === 0
      ? []
      : (
          await exec
            .selectDistinct({ meetingId: notes.meetingId })
            .from(notes)
            .where(inArray(notes.meetingId, ids))
        ).map((row) => row.meetingId),
  )

  const today = todays.map((entry): TodayEntry => {
    const over = ended(entry)
    const phase = over ? 'done' : entry.startsAt <= now ? 'now' : 'later'
    const count = entry.meeting ? (pending.get(entry.meeting.id) ?? 0) : 0
    const step =
      !over || !entry.meeting ? null : count > 0 ? 'review' : noted.has(entry.meeting.id) ? 'recap' : 'log'
    return { ...entry, phase, pending: count, step }
  })
  return { today, next }
}

/** Meetings and sessions with proposals waiting, in every context: meeting id to its context and count. */
export async function reviewEverywhere(
  exec: Executor,
  contexts: Pick<Context, 'id'>[],
): Promise<Map<string, { contextId: string; count: number }>> {
  const found = new Map<string, { contextId: string; count: number }>()
  for (const context of contexts) {
    for (const [meetingId, count] of await pendingByMeeting(exec, context.id)) {
      found.set(meetingId, { contextId: context.id, count })
    }
  }
  return found
}
