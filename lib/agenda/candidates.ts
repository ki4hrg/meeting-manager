/*
 * Which items an agenda pulls in (docs/SPEC.md, "Agendas pull candidates").
 *
 * This is where a leak would happen, so the rules are deliberately narrow:
 *
 *   - Only open items in the meeting's own context are ever looked at.
 *   - Placed without asking: items aimed at this meeting or at its series, and,
 *     in a 1:1, what John wants to raise with the other person.
 *   - A meeting with sessions has no agenda of its own to fill: nothing is
 *     placed on it, and what is aimed at it goes to its next session, the
 *     first one that is not over.
 *   - Suggested: items matched through one of the meeting's projects (or a
 *     project within one of them, grouped by that sub-project) or its group.
 *     A person match alone is not enough in a larger meeting; those sit under
 *     "more" and are never placed for him, as do the items of a project the
 *     meeting's projects sit within.
 *   - John is at every meeting, so nothing is a candidate through him.
 *
 * John is never a row in meeting_people: a 1:1 is a meeting with one row.
 */

import { and, asc, eq, gte, isNull, sql } from 'drizzle-orm'
import { isOver } from '../meetings/meetings'
import {
  NotFoundError,
  ValidationError,
  inTransaction,
  type ActorContext,
  type Executor,
} from '../core/types'
import {
  agendaLines,
  groups,
  meetingDismissals,
  meetingPeople,
  meetingProjects,
  meetings,
  people,
} from '../db/schema'
import { getItem, isOpen, listItems, type ItemView } from '../items/items'
import { ancestorIds, descendantIds, listProjects } from '../projects/projects'

export type CandidateGroup = {
  by: { type: 'person' | 'group' | 'project'; id: string; name: string }
  items: ItemView[]
}

export type Candidates = {
  /** Qualify for automatic placement, not yet on the agenda, not dismissed. */
  toPlace: ItemView[]
  /** One click to place. Each item appears once, under its strongest reason. */
  suggested: CandidateGroup[]
  /** Person-only items in a larger meeting: reachable, never offered. */
  more: CandidateGroup[]
  /** Turned away for this meeting and still open, so they can be brought back. */
  dismissed: ItemView[]
}

async function loadMeeting(exec: Executor, meetingId: string) {
  const [meeting] = await exec.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1)
  if (!meeting) throw new NotFoundError('Meeting', meetingId)
  return meeting
}

/* An item aimed at a series goes to its next occurrence only: an undated stub,
   or the earliest meeting of the series still to come. */
async function isNextOccurrence(
  exec: Executor,
  meeting: typeof meetings.$inferSelect,
  now: Date,
): Promise<boolean> {
  if (!meeting.seriesId) return false
  if (meeting.startsAt === null) return true
  const [next] = await exec
    .select({ id: meetings.id })
    .from(meetings)
    .where(and(eq(meetings.seriesId, meeting.seriesId), gte(meetings.startsAt, now)))
    .orderBy(asc(meetings.startsAt))
    .limit(1)
  return next?.id === meeting.id
}

/* A meeting's sessions, in the order they run; the undated last. */
async function sessionsOf(exec: Executor, meetingId: string) {
  return exec
    .select({ id: meetings.id, startsAt: meetings.startsAt, endsAt: meetings.endsAt })
    .from(meetings)
    .where(eq(meetings.parentMeetingId, meetingId))
    .orderBy(sql`${meetings.startsAt} asc nulls last`, asc(meetings.createdAt))
}

/** The session of a multi-day meeting that what is aimed at the whole meeting goes to. */
export async function nextSession(exec: Executor, meetingId: string, now: Date): Promise<string | null> {
  return (await sessionsOf(exec, meetingId)).find((session) => !isOver(session, now))?.id ?? null
}

const GROUP_ORDER = { project: 0, group: 1, person: 2 } as const

function sorted(map: Map<string, CandidateGroup>): CandidateGroup[] {
  return [...map.values()].sort(
    (a, b) =>
      GROUP_ORDER[a.by.type] - GROUP_ORDER[b.by.type] || a.by.name.localeCompare(b.by.name),
  )
}

function push(map: Map<string, CandidateGroup>, by: CandidateGroup['by'], item: ItemView) {
  const key = `${by.type}:${by.id}`
  const entry = map.get(key) ?? { by, items: [] }
  entry.items.push(item)
  map.set(key, entry)
}

export async function getCandidates(
  exec: Executor,
  meetingId: string,
  now: Date = new Date(),
): Promise<Candidates> {
  const meeting = await loadMeeting(exec, meetingId)

  const [placed, dismissals, attendees, projectRows, groupRow] = await Promise.all([
    exec
      .select({ itemId: agendaLines.itemId })
      .from(agendaLines)
      .where(eq(agendaLines.meetingId, meetingId)),
    exec
      .select({ itemId: meetingDismissals.itemId })
      .from(meetingDismissals)
      .where(eq(meetingDismissals.meetingId, meetingId)),
    exec
      .select({ id: people.id, isSelf: people.isSelf })
      .from(meetingPeople)
      .innerJoin(people, eq(people.id, meetingPeople.personId))
      .where(eq(meetingPeople.meetingId, meetingId)),
    exec
      .select({ projectId: meetingProjects.projectId })
      .from(meetingProjects)
      .where(eq(meetingProjects.meetingId, meetingId)),
    meeting.groupId
      ? exec.select({ name: groups.name }).from(groups).where(eq(groups.id, meeting.groupId))
      : Promise.resolve([]),
  ])

  const placedIds = new Set(placed.map((row) => row.itemId))
  const dismissedIds = new Set(dismissals.map((row) => row.itemId))
  // Defensive: John should never be a row, and must never count as a match.
  const attendeeIds = new Set(attendees.filter((row) => !row.isSelf).map((row) => row.id))
  const projectIds = new Set(projectRows.map((row) => row.projectId))
  /* Projects within the meeting's are suggested too; projects they sit within
     are reachable under "more". Neither is ever placed. */
  const tree = projectIds.size > 0 ? await listProjects(exec, meeting.contextId) : []
  const below = descendantIds(tree, projectIds)
  const above = ancestorIds(tree, projectIds)
  const projectName = new Map(tree.map((project) => [project.id, project.name]))
  const solo = attendeeIds.size === 1 ? [...attendeeIds][0]! : null
  const groupName = groupRow[0]?.name ?? ''
  const next = await isNextOccurrence(exec, meeting, now)
  /* What is aimed at the whole of a multi-day meeting comes here when this is
     its next session; the meeting itself, having sessions, takes none of it. */
  const rollup = (await sessionsOf(exec, meeting.id)).length > 0
  const parentAim =
    meeting.parentMeetingId && (await nextSession(exec, meeting.parentMeetingId, now)) === meeting.id
      ? meeting.parentMeetingId
      : null

  // The one query for items, and it is bound to the meeting's context.
  const open = await listItems(exec, { contextId: meeting.contextId, open: true })

  const toPlace: ItemView[] = []
  const dismissed: ItemView[] = []
  const suggested = new Map<string, CandidateGroup>()
  const more = new Map<string, CandidateGroup>()

  for (const item of open) {
    // A decision is a record, not something to raise.
    if (item.kind === 'decision' || placedIds.has(item.id)) continue

    const attendee = item.parties.find(
      (party) => party.type === 'person' && !party.isSelf && attendeeIds.has(party.id),
    )
    const aimedHere =
      (item.targetMeetingId === meeting.id && !rollup) ||
      (parentAim !== null && item.targetMeetingId === parentAim) ||
      (next && item.targetSeriesId !== null && item.targetSeriesId === meeting.seriesId)
    const raiseWithSolo =
      solo !== null &&
      item.parties.some(
        (party) => party.type === 'person' && party.id === solo && party.role === 'with',
      )
    const viaProject = item.project !== null && projectIds.has(item.project.id)
    const viaChild = item.project !== null && !viaProject && below.has(item.project.id)
    const viaParent = item.project !== null && !viaProject && !viaChild && above.has(item.project.id)
    const viaGroup =
      meeting.groupId !== null &&
      item.parties.some((party) => party.type === 'group' && party.id === meeting.groupId)

    if (dismissedIds.has(item.id)) {
      if (aimedHere || raiseWithSolo || viaProject || viaChild || viaGroup || attendee || viaParent) {
        dismissed.push(item)
      }
      continue
    }

    if (aimedHere || raiseWithSolo) {
      // Its sessions take these; the meeting over them places nothing.
      if (!rollup) toPlace.push(item)
    } else if (viaProject || viaChild) {
      push(suggested, { type: 'project', id: item.project!.id, name: item.project!.name }, item)
    } else if (viaGroup) {
      push(suggested, { type: 'group', id: meeting.groupId!, name: groupName }, item)
    } else if (attendee) {
      /* Matched by the person alone. In a 1:1 that is what they owe, worth
         chasing; in anything larger it could be private, so it waits under
         "more". */
      const by = { type: 'person' as const, id: attendee.id, name: attendee.name }
      push(solo ? suggested : more, by, item)
    } else if (viaParent) {
      const id = item.project!.id
      push(more, { type: 'project', id, name: projectName.get(id) ?? item.project!.name }, item)
    }
  }

  return {
    toPlace: toPlace.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    suggested: sorted(suggested),
    more: sorted(more),
    dismissed,
  }
}

async function appendItemLines(exec: Executor, meetingId: string, itemIds: string[]) {
  if (itemIds.length === 0) return
  const [last] = await exec
    .select({ max: sql<number | null>`max(${agendaLines.position})::int` })
    .from(agendaLines)
    .where(and(eq(agendaLines.meetingId, meetingId), isNull(agendaLines.sectionId)))
  const from = (last?.max ?? -1) + 1
  await exec
    .insert(agendaLines)
    .values(itemIds.map((itemId, index) => ({ meetingId, itemId, position: from + index })))
}

/**
 * Put everything that places itself on the agenda. Running it again places
 * nothing, and neither does running it on a meeting with sessions.
 */
export async function placeAutomatic(
  exec: Executor,
  _actor: ActorContext,
  meetingId: string,
  now: Date = new Date(),
): Promise<number> {
  return inTransaction(exec, async (tx) => {
    if ((await sessionsOf(tx, meetingId)).length > 0) return 0
    const { toPlace } = await getCandidates(tx, meetingId, now)
    await appendItemLines(
      tx,
      meetingId,
      toPlace.map((item) => item.id),
    )
    return toPlace.length
  })
}

/** One click from a suggestion. Placing also takes back a "not this time". */
export async function placeItem(
  exec: Executor,
  _actor: ActorContext,
  meetingId: string,
  itemId: string,
): Promise<void> {
  await inTransaction(exec, async (tx) => {
    const meeting = await loadMeeting(tx, meetingId)
    const item = await getItem(tx, itemId)
    if (item.contextId !== meeting.contextId) {
      throw new ValidationError('That item belongs to another context.')
    }

    const [existing] = await tx
      .select({ id: agendaLines.id })
      .from(agendaLines)
      .where(and(eq(agendaLines.meetingId, meetingId), eq(agendaLines.itemId, itemId)))
      .limit(1)
    if (!existing) {
      if (!isOpen(item)) throw new ValidationError('That item is already closed.')
      await appendItemLines(tx, meetingId, [itemId])
    }

    await tx
      .delete(meetingDismissals)
      .where(and(eq(meetingDismissals.meetingId, meetingId), eq(meetingDismissals.itemId, itemId)))
  })
}

/** "Not this time": gone from this meeting's candidates until restored. */
export async function dismissCandidate(
  exec: Executor,
  _actor: ActorContext,
  meetingId: string,
  itemId: string,
): Promise<void> {
  const meeting = await loadMeeting(exec, meetingId)
  const item = await getItem(exec, itemId)
  if (item.contextId !== meeting.contextId) {
    throw new ValidationError('That item belongs to another context.')
  }
  const [placed] = await exec
    .select({ id: agendaLines.id })
    .from(agendaLines)
    .where(and(eq(agendaLines.meetingId, meetingId), eq(agendaLines.itemId, itemId)))
    .limit(1)
  if (placed) throw new ValidationError('That item is on the agenda. Remove its line instead.')

  await exec.insert(meetingDismissals).values({ meetingId, itemId }).onConflictDoNothing()
}

export async function restoreCandidate(
  exec: Executor,
  _actor: ActorContext,
  meetingId: string,
  itemId: string,
): Promise<void> {
  await exec
    .delete(meetingDismissals)
    .where(and(eq(meetingDismissals.meetingId, meetingId), eq(meetingDismissals.itemId, itemId)))
}
