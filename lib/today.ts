/*
 * Home: what needs attention today, whichever context it lives in (docs/SPEC.md,
 * build order 6). The one deliberate exception to "nothing is listed across
 * contexts": it only reads, every row keeps its context, and opening a row
 * selects that context first. Archived contexts are left out.
 */

import type { Executor } from './core/types'
import type { Context } from './directory/contexts'
import { splitLater } from './items/horizon'
import { listItems, type ItemView } from './items/items'
import type { CalendarEvent } from './calendar/feed'
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

/* What I owe, and what others owe that I am waiting on, in one context. */
async function owedIn(exec: Executor, contextId: string, selfId: string) {
  const mine = await listItems(exec, {
    contextId,
    open: true,
    party: { personId: selfId, role: 'owner' },
  })
  // Owed by someone, and not by me: what I am waiting on.
  const waiting = (await listItems(exec, { contextId, open: true, kinds: ['question', 'action'] })).filter(
    (item) =>
      item.parties.some((party) => party.role === 'owner') &&
      !item.parties.some((party) => party.role === 'owner' && party.isSelf),
  )
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

/** The next meetings and unprepped events of every context, soonest first, each with its context. */
export async function upcomingEverywhere(
  exec: Executor,
  contexts: Pick<Context, 'id'>[],
  /* `events` stands in for every calendar, for tests. */
  opts: { now?: Date; limit?: number; events?: CalendarEvent[] } = {},
): Promise<Array<UpcomingEntry & { contextId: string }>> {
  const lists = await Promise.all(
    contexts.map(async (context) =>
      (await listUpcoming(exec, context.id, { now: opts.now, events: opts.events })).entries.map((entry) => ({
        ...entry,
        contextId: context.id,
      })),
    ),
  )
  return lists
    .flat()
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .slice(0, opts.limit ?? 12)
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
