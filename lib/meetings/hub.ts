/*
 * The meetings on a project, series or group hub (docs/SPEC.md, build order 7):
 * its own meetings, and the calendar events not yet prepped whose meeting would
 * be its own, a window at a time ahead and a page at a time back.
 *
 * An event belongs to a hub by what prepping it would give its meeting
 * (`eventTakes`): the series, groups and projects. Nothing looser.
 */

import type { CalendarEvent } from '../calendar/feed'
import type { Executor } from '../core/types'
import { listMeetings, type MeetingView } from './meetings'
import { eventTakes, listUpcoming, type UpcomingEntry } from './prep'

export type Hub =
  /** A project and, when rolled up, its sub-projects. */
  | { kind: 'project'; ids: string[] }
  | { kind: 'series'; id: string }
  | { kind: 'group'; id: string }

function meetingIsOf(meeting: MeetingView, hub: Hub): boolean {
  if (hub.kind === 'series') return meeting.series?.id === hub.id
  if (hub.kind === 'group') return meeting.groups.some((group) => group.id === hub.id)
  return meeting.projects.some((project) => hub.ids.includes(project.id))
}

async function eventIsOf(exec: Executor, contextId: string, event: CalendarEvent, hub: Hub): Promise<boolean> {
  const takes = await eventTakes(exec, contextId, event)
  // Prepped, it would live in another context (its series was moved): not this hub's to show.
  if (takes.home !== contextId) return false
  if (hub.kind === 'series') return takes.series?.id === hub.id
  if (hub.kind === 'group') return takes.groupIds.includes(hub.id)
  return takes.projectIds.some((id) => hub.ids.includes(id))
}

async function hubMeetings(
  exec: Executor,
  contextId: string,
  hub: Hub,
  when: 'upcoming' | 'past' | 'stubs',
  now: Date,
): Promise<MeetingView[]> {
  const base = { contextId, when, now, topLevelOnly: true } as const
  if (hub.kind === 'series') return listMeetings(exec, { ...base, seriesId: hub.id })
  if (hub.kind === 'group') return listMeetings(exec, { ...base, groupId: hub.id })
  const seen = new Set<string>()
  return (await Promise.all(hub.ids.map((projectId) => listMeetings(exec, { ...base, projectId }))))
    .flat()
    .filter((meeting) => !seen.has(meeting.id) && Boolean(seen.add(meeting.id)))
}

/**
 * What is coming: the hub's meetings and its unprepped events within `days`
 * (each as `listUpcoming` gives it, soonest first), then its meetings dated
 * beyond that, then its undated stubs.
 */
export async function hubUpcoming(
  exec: Executor,
  contextId: string,
  hub: Hub,
  /* `events` stands in for the context's calendars, for tests. */
  opts: { now?: Date; days?: number; events?: CalendarEvent[] } = {},
): Promise<{ entries: UpcomingEntry[]; later: MeetingView[]; stubs: MeetingView[] }> {
  const now = opts.now ?? new Date()
  const days = opts.days ?? 14
  const { entries } = await listUpcoming(exec, contextId, { now, days, events: opts.events })

  const mine: UpcomingEntry[] = []
  for (const entry of entries) {
    const ours = entry.meeting
      ? meetingIsOf(entry.meeting, hub)
      : await eventIsOf(exec, contextId, entry.event!, hub)
    if (ours) mine.push(entry)
  }

  const listed = new Set(mine.flatMap((entry) => (entry.meeting ? [entry.meeting.id] : [])))
  const windowEnd = now.getTime() + days * 86_400_000
  const later = (await hubMeetings(exec, contextId, hub, 'upcoming', now))
    .filter((meeting) => !listed.has(meeting.id) && meeting.startsAt && meeting.startsAt.getTime() >= windowEnd)
    .sort((a, b) => a.startsAt!.getTime() - b.startsAt!.getTime())
  const stubs = await hubMeetings(exec, contextId, hub, 'stubs', now)
  return { entries: mine, later, stubs }
}

/** What was held, latest first, `limit` at a time; `more` says whether there is earlier. */
export async function hubPast(
  exec: Executor,
  contextId: string,
  hub: Hub,
  opts: { now?: Date; limit: number },
): Promise<{ meetings: MeetingView[]; more: boolean }> {
  const all = (await hubMeetings(exec, contextId, hub, 'past', opts.now ?? new Date())).sort(
    (a, b) => (b.startsAt?.getTime() ?? 0) - (a.startsAt?.getTime() ?? 0),
  )
  return { meetings: all.slice(0, opts.limit), more: all.length > opts.limit }
}
