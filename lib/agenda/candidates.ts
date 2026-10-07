/*
 * Which items an agenda pulls in (docs/SPEC.md, "Agendas pull candidates").
 *
 * This is where a leak would happen, so the rules are deliberately narrow:
 *
 *   - Only open items in the meeting's own context are ever looked at.
 *   - Placed without asking: only items aimed at a meeting, which is this one,
 *     its series (the next occurrence), or the next meeting for a project (the
 *     next one not over that carries it or a project within it). Anything
 *     tagged with a person, group or project is at most suggested, even in a
 *     1:1, so it stays there, meeting after meeting, until it is placed.
 *   - A meeting with sessions has no agenda of its own to fill: nothing is
 *     placed on it, and what is aimed at it goes to its next session, the
 *     first one that is not over.
 *   - Suggested: items matched through one of the meeting's projects (or a
 *     project within one of them, grouped by that sub-project) or its group.
 *     A person match alone is not enough in a larger meeting; those sit under
 *     "more" and are never placed for him, as do the items of a project the
 *     meeting's projects sit within.
 *   - An item aimed at another meeting, series or project is on its way there
 *     and is not offered here at all. An aim at a meeting that is over (or
 *     gone) is spent, and the item is matched as if it had none.
 *   - John is at every meeting, so nothing is a candidate through him.
 *   - What came out of a meeting is not a candidate for that same meeting.
 *   - What waits in Later until another item closes is not offered anywhere,
 *     aimed or not, until that item closes or its own deadline comes close.
 *
 * John is never a row in meeting_people: a 1:1 is a meeting with one row.
 */

import { and, asc, eq, gte, inArray, isNull, sql } from 'drizzle-orm'
import { onShelf } from '../db/shelf'
import { getMeeting, isOver } from '../meetings/meetings'
import {
  NotFoundError,
  ValidationError,
  inTransaction,
  type ActorContext,
  type Executor,
} from '../core/types'
import { agendaLines, meetingDismissals, meetingProjects, meetings, users } from '../db/schema'
import { todayIn } from '../core/dates'
import { isLater } from '../items/horizon'
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
    .where(and(eq(meetings.seriesId, meeting.seriesId), onShelf(meetings), gte(meetings.startsAt, now)))
    .orderBy(asc(meetings.startsAt))
    .limit(1)
  return next?.id === meeting.id
}

/* A meeting's sessions, in the order they run; the undated last. */
async function sessionsOf(exec: Executor, meetingId: string) {
  return exec
    .select({ id: meetings.id, startsAt: meetings.startsAt, endsAt: meetings.endsAt })
    .from(meetings)
    .where(and(eq(meetings.parentMeetingId, meetingId), onShelf(meetings)))
    .orderBy(sql`${meetings.startsAt} asc nulls last`, asc(meetings.createdAt))
}

/** The session of a multi-day meeting that what is aimed at the whole meeting goes to. */
export async function nextSession(exec: Executor, meetingId: string, now: Date): Promise<string | null> {
  return (await sessionsOf(exec, meetingId)).find((session) => !isOver(session, now))?.id ?? null
}

/**
 * The meeting an item aimed at "the next meeting for a project" goes to: the
 * earliest top-level meeting not over that carries the project or one within
 * it, else the oldest undated one that does; a meeting with sessions hands it
 * to its next session. Null while there is none: the item waits.
 */
export async function nextForProject(
  exec: Executor,
  contextId: string,
  projectId: string,
  now: Date,
): Promise<string | null> {
  const tree = await listProjects(exec, contextId, 'all')
  const family = [projectId, ...descendantIds(tree, [projectId])]
  const carrying = await exec
    .select({ id: meetings.id, startsAt: meetings.startsAt, endsAt: meetings.endsAt, createdAt: meetings.createdAt })
    .from(meetings)
    .where(
      and(
        eq(meetings.contextId, contextId),
        isNull(meetings.parentMeetingId),
        onShelf(meetings),
        inArray(
          meetings.id,
          exec
            .select({ id: meetingProjects.meetingId })
            .from(meetingProjects)
            .where(inArray(meetingProjects.projectId, family)),
        ),
      ),
    )
  const ahead = carrying.filter((meeting) => !isOver(meeting, now))
  const dated = ahead
    .filter((meeting) => meeting.startsAt)
    .sort((a, b) => a.startsAt!.getTime() - b.startsAt!.getTime())
  const undated = ahead.filter((meeting) => !meeting.startsAt).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  const next = dated[0] ?? undated[0]
  if (!next) return null
  return (await sessionsOf(exec, next.id)).length > 0 ? nextSession(exec, next.id, now) : next.id
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

  const [placed, dismissals, view, projectRows] = await Promise.all([
    exec
      .select({ itemId: agendaLines.itemId })
      .from(agendaLines)
      .where(eq(agendaLines.meetingId, meetingId)),
    exec
      .select({ itemId: meetingDismissals.itemId })
      .from(meetingDismissals)
      .where(eq(meetingDismissals.meetingId, meetingId)),
    // Who is at it: its people and, while they are live, its groups' members.
    getMeeting(exec, meetingId),
    exec
      .select({ projectId: meetingProjects.projectId })
      .from(meetingProjects)
      .where(eq(meetingProjects.meetingId, meetingId)),
  ])

  const placedIds = new Set(placed.map((row) => row.itemId))
  const dismissedIds = new Set(dismissals.map((row) => row.itemId))
  // John is never among them, and must never count as a match.
  const attendeeIds = new Set(view.attendees.map((row) => row.id))
  const meetingGroupIds = new Set(view.groups.map((group) => group.id))
  const projectIds = new Set(projectRows.map((row) => row.projectId))
  /* Projects within the meeting's are suggested too; projects they sit within
     are reachable under "more". Neither is ever placed. */
  const tree = projectIds.size > 0 ? await listProjects(exec, meeting.contextId, 'all') : []
  const below = descendantIds(tree, projectIds)
  const above = ancestorIds(tree, projectIds)
  const projectName = new Map(tree.map((project) => [project.id, project.name]))
  /* A meeting with a group is the group's, however few have joined it so far:
     never a 1:1, and what is for one member alone waits under "more". */
  const solo = attendeeIds.size === 1 && meetingGroupIds.size === 0 ? [...attendeeIds][0]! : null
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

  // Which meeting takes what is aimed at each project's next meeting: asked once per project.
  const projectAims = new Map<string, string | null>()
  for (const item of open) {
    if (item.targetProjectId && !projectAims.has(item.targetProjectId)) {
      projectAims.set(item.targetProjectId, await nextForProject(exec, meeting.contextId, item.targetProjectId, now))
    }
  }

  // Meetings items are aimed at: one that is over, put away or gone no longer holds its item.
  const aimedAt = [...new Set(open.flatMap((item) => (item.targetMeetingId ? [item.targetMeetingId] : [])))]
  const live = new Set(
    aimedAt.length === 0
      ? []
      : (
          await exec
            .select({ id: meetings.id, startsAt: meetings.startsAt, endsAt: meetings.endsAt })
            .from(meetings)
            .where(and(inArray(meetings.id, aimedAt), onShelf(meetings)))
        )
          .filter((one) => !isOver(one, now))
          .map((one) => one.id),
  )

  // One user; a deadline coming close is judged on their clock.
  const [owner] = await exec.select({ timeZone: users.timeZone }).from(users).limit(1)
  const today = todayIn(owner?.timeZone, now)
  const toPlace: ItemView[] = []
  const dismissed: ItemView[] = []
  const suggested = new Map<string, CandidateGroup>()
  const more = new Map<string, CandidateGroup>()

  for (const item of open) {
    // A decision is a record, not something to raise.
    if (item.kind === 'decision' || placedIds.has(item.id)) continue
    // What came out of this meeting is its outcome, not something to raise at it.
    if (item.originMeetingId === meeting.id) continue
    // Waiting on another item: not ready to raise.
    if (item.laterUntilItemId && isLater(item, today)) continue

    const attendee = item.parties.find(
      (party) => party.type === 'person' && !party.isSelf && attendeeIds.has(party.id),
    )
    const aimedHere =
      (item.targetMeetingId === meeting.id && !rollup) ||
      (parentAim !== null && item.targetMeetingId === parentAim) ||
      (next && item.targetSeriesId !== null && item.targetSeriesId === meeting.seriesId) ||
      (item.targetProjectId !== null && projectAims.get(item.targetProjectId) === meeting.id)
    // On its way to somewhere else: not offered here, under any reason.
    const aimedElsewhere =
      !aimedHere &&
      ((item.targetMeetingId !== null && live.has(item.targetMeetingId)) ||
        item.targetSeriesId !== null ||
        item.targetProjectId !== null)
    if (aimedElsewhere) continue
    const viaProject = item.project !== null && projectIds.has(item.project.id)
    const viaChild = item.project !== null && !viaProject && below.has(item.project.id)
    const viaParent = item.project !== null && !viaProject && !viaChild && above.has(item.project.id)
    // Through any of its groups: the first of them the item names.
    const viaGroup = item.parties.find((party) => party.type === 'group' && meetingGroupIds.has(party.id))

    if (dismissedIds.has(item.id)) {
      if (aimedHere || viaProject || viaChild || viaGroup || attendee || viaParent) {
        dismissed.push(item)
      }
      continue
    }

    if (aimedHere) {
      // Its sessions take these; the meeting over them places nothing.
      if (!rollup) toPlace.push(item)
    } else if (viaProject || viaChild) {
      push(suggested, { type: 'project', id: item.project!.id, name: item.project!.name }, item)
    } else if (viaGroup) {
      push(suggested, { type: 'group', id: viaGroup.id, name: viaGroup.name }, item)
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
    // Put away: nothing more is placed on it.
    const meeting = await loadMeeting(tx, meetingId)
    if (meeting.archivedAt || meeting.deletedAt) return 0
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

/**
 * "Prep a meeting with…" asks for the batch: everything waiting to be raised
 * with that person, placed at once. What was taken off the agenda stays off.
 */
export async function placeRaiseWith(
  exec: Executor,
  _actor: ActorContext,
  meetingId: string,
  personId: string,
  now: Date = new Date(),
): Promise<number> {
  return inTransaction(exec, async (tx) => {
    const { suggested } = await getCandidates(tx, meetingId, now)
    const batch = suggested
      .flatMap((group) => group.items)
      .filter((item) =>
        item.parties.some((party) => party.type === 'person' && party.id === personId && party.role === 'with'),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    await appendItemLines(
      tx,
      meetingId,
      batch.map((item) => item.id),
    )
    return batch.length
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
