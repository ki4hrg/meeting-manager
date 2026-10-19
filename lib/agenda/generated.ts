/*
 * The generated blocks of an agenda (docs/SPEC.md, "Workflow"): computed when
 * the agenda is rendered, never stored.
 *
 * The leak rule lives here. "Follow-ups due" and "Since last time" are drawn
 * only from items that were put on an agenda or came out of the meeting, never
 * from everything an attendee happens to owe: what someone owes John in private
 * must not surface in a room it was never raised in. What "Since last time"
 * adds from between meetings is held to the same circle: items raised at its
 * series', groups' or projects' meetings, aimed at them, or carrying the
 * project or the group, as the agenda's suggestions are.
 */

import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, or } from 'drizzle-orm'
import { addDays } from '../core/dates'
import { notDeleted, onShelf } from '../db/shelf'
import { NotFoundError, type Executor } from '../core/types'
import { ancestorIds, descendantIds, listProjects } from '../projects/projects'
import {
  agendaLines,
  itemEvents,
  items,
  meetingGroups,
  meetingProjects,
  meetings,
  milestones,
  projects,
  series,
  type BlockSettings,
} from '../db/schema'
import { isOpen, listItems, type ItemView } from '../items/items'
import type {
  BlockParty,
  FollowUpsBlock,
  GeneratedBlocks,
  LookaheadBlock,
  SinceLastBlock,
} from './types'

type Meeting = typeof meetings.$inferSelect

const OFF: BlockSettings = { followUps: false, sinceLast: false, lookahead: false }

/** How far ahead the lookahead looks, and how many meetings it lists. */
const LOOKAHEAD_DAYS = 60
const LOOKAHEAD_MEETINGS = 5

export type ComputeBlocksOpts = {
  /** 'YYYY-MM-DD' in the user's time zone. */
  today: string
  now?: Date
  /** Switch blocks on or off for this render, whatever the meeting and series say. */
  force?: Partial<BlockSettings>
}

export async function computeBlocks(
  exec: Executor,
  meetingId: string,
  opts: ComputeBlocksOpts,
): Promise<GeneratedBlocks> {
  const [meeting] = await exec.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1)
  if (!meeting) throw new NotFoundError('Meeting', meetingId)

  let settings = meeting.blocks
  if (!settings && meeting.seriesId) {
    const [row] = await exec
      .select({ blocks: series.blocks })
      .from(series)
      .where(eq(series.id, meeting.seriesId))
      .limit(1)
    settings = row?.blocks ?? null
  }
  /* A meeting of no series reports since last time on its group's or its
     projects' meetings; it has none to report on without them. */
  if (!settings && !meeting.seriesId) settings = { ...OFF, sinceLast: true }
  const on = { ...(settings ?? OFF), ...opts.force }
  const now = opts.now ?? new Date()

  const [followUps, sinceLast, lookahead] = await Promise.all([
    on.followUps ? followUpsFor(exec, meeting, opts.today) : null,
    on.sinceLast ? sinceLastFor(exec, meeting, now) : null,
    on.lookahead ? lookaheadFor(exec, meeting, opts.today, now) : null,
  ])
  return { followUps, sinceLast, lookahead }
}

/* The only items a meeting may speak about: those on its agenda and those that
   came out of it. A meeting with sessions is their rollup, so theirs count as
   its own; a session speaks only for itself. Bound to the meeting's context as
   well, so a stray reference could not carry anything across. The recap reads
   through here too. */
export async function itemsOf(exec: Executor, meeting: Meeting): Promise<ItemView[]> {
  const sessions = await exec
    .select({ id: meetings.id })
    .from(meetings)
    .where(
      and(eq(meetings.parentMeetingId, meeting.id), eq(meetings.contextId, meeting.contextId), onShelf(meetings)),
    )
  const covered = [meeting.id, ...sessions.map((row) => row.id)]

  const placed = await exec
    .select({ itemId: agendaLines.itemId })
    .from(agendaLines)
    .where(and(inArray(agendaLines.meetingId, covered), isNotNull(agendaLines.itemId)))

  const [onAgenda, ...cameOut] = await Promise.all([
    listItems(exec, { contextId: meeting.contextId, ids: [...new Set(placed.map((row) => row.itemId!))] }),
    ...covered.map((id) => listItems(exec, { contextId: meeting.contextId, originMeetingId: id })),
  ])
  const seen = new Set(onAgenda.map((item) => item.id))
  const rest: ItemView[] = []
  for (const item of cameOut.flat()) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    rest.push(item)
  }
  return [...onAgenda, ...rest]
}

async function followUpsFor(
  exec: Executor,
  meeting: Meeting,
  today: string,
): Promise<FollowUpsBlock | null> {
  const owed = (await itemsOf(exec, meeting)).filter(
    (item) => isOpen(item) && (item.kind === 'question' || item.kind === 'action'),
  )

  const byParty = new Map<string, FollowUpsBlock[number]>()
  // listItems orders by deadline, then newest: that order is kept within a party.
  for (const item of owed) {
    for (const owner of item.parties.filter((party) => party.role === 'owner')) {
      const key = `${owner.type}:${owner.id}`
      const party: BlockParty = { type: owner.type, id: owner.id, name: owner.name }
      const entry = byParty.get(key) ?? { party, items: [] }
      entry.items.push({
        itemId: item.id,
        kind: item.kind,
        text: item.text,
        dueOn: item.dueOn,
        overdue: item.dueOn !== null && item.dueOn < today,
      })
      byParty.set(key, entry)
    }
  }

  const block = [...byParty.values()].sort((a, b) => a.party.name.localeCompare(b.party.name))
  return block.length > 0 ? block : null
}

/* A meeting's circle: its series, its groups and its projects, these read up
   and down the project tree as the lookahead reads them. */
type Circle = {
  seriesId: string | null
  groupIds: Set<string>
  projectIds: Set<string>
  /** Every meeting in the context that shares any of these. */
  meetingIds: Set<string>
}

async function circleOf(exec: Executor, meeting: Meeting): Promise<Circle | null> {
  const [ownProjects, ownGroups] = await Promise.all([
    exec
      .select({ id: meetingProjects.projectId })
      .from(meetingProjects)
      .where(eq(meetingProjects.meetingId, meeting.id)),
    exec.select({ id: meetingGroups.groupId }).from(meetingGroups).where(eq(meetingGroups.meetingId, meeting.id)),
  ])
  const own = ownProjects.map((row) => row.id)
  const tree = own.length > 0 ? await listProjects(exec, meeting.contextId, 'all') : []
  const projectIds = new Set([...own, ...ancestorIds(tree, own), ...descendantIds(tree, own)])
  const groupIds = new Set(ownGroups.map((row) => row.id))
  if (!meeting.seriesId && projectIds.size === 0 && groupIds.size === 0) return null

  const rows = await exec
    .select({ id: meetings.id })
    .from(meetings)
    .where(
      and(
        eq(meetings.contextId, meeting.contextId),
        onShelf(meetings),
        or(
          meeting.seriesId ? eq(meetings.seriesId, meeting.seriesId) : undefined,
          projectIds.size > 0
            ? inArray(
                meetings.id,
                exec
                  .select({ id: meetingProjects.meetingId })
                  .from(meetingProjects)
                  .where(inArray(meetingProjects.projectId, [...projectIds])),
              )
            : undefined,
          groupIds.size > 0
            ? inArray(
                meetings.id,
                exec
                  .select({ id: meetingGroups.meetingId })
                  .from(meetingGroups)
                  .where(inArray(meetingGroups.groupId, [...groupIds])),
              )
            : undefined,
        ),
      ),
    )
  return { seriesId: meeting.seriesId, groupIds, projectIds, meetingIds: new Set(rows.map((row) => row.id)) }
}

/*
 * Since last time: what happened at the previous meeting of the circle (its
 * decisions, what closed and what is still open), and what was settled since
 * on anything the circle raised: questions answered and decisions recorded
 * between that meeting and this one. An answer the circle already heard (given
 * in one of its meetings) or that John has passed on himself is not repeated,
 * and a decision stands in for the answer it was recorded from.
 */
async function sinceLastFor(
  exec: Executor,
  meeting: Meeting,
  now: Date,
): Promise<SinceLastBlock | null> {
  const circle = await circleOf(exec, meeting)
  if (!circle) return null
  const before = meeting.startsAt ?? now

  const [previous] = await exec
    .select()
    .from(meetings)
    .where(
      and(
        inArray(meetings.id, [...circle.meetingIds, meeting.id]),
        ne(meetings.id, meeting.id),
        // Not its own sessions, nor the meeting it is a session of.
        or(isNull(meetings.parentMeetingId), ne(meetings.parentMeetingId, meeting.id)),
        meeting.parentMeetingId ? ne(meetings.id, meeting.parentMeetingId) : undefined,
        lt(meetings.startsAt, before),
      ),
    )
    .orderBy(desc(meetings.startsAt))
    .limit(1)
  if (!previous) return null

  const then = await itemsOf(exec, previous)
  const thenIds = new Set(then.map((item) => item.id))
  // A decision recorded afterwards on something raised there belongs to it too.
  const decisionsInContext = await listItems(exec, { contextId: meeting.contextId, kinds: ['decision'] })
  const settled = decisionsInContext.filter(
    (item) => item.parentItemId !== null && thenIds.has(item.parentItemId) && !thenIds.has(item.id),
  )

  /* Settled since, on anything the circle raised. */
  const windowStart = previous.startsAt!
  const inWindow = (at: Date) => at >= windowStart && at < before
  const answeredRows = await exec
    .select({ itemId: itemEvents.itemId, data: itemEvents.data, createdAt: itemEvents.createdAt })
    .from(itemEvents)
    .innerJoin(items, eq(items.id, itemEvents.itemId))
    .where(
      and(
        eq(items.contextId, meeting.contextId),
        eq(itemEvents.type, 'answered'),
        gte(itemEvents.createdAt, windowStart),
        lt(itemEvents.createdAt, before),
      ),
    )
  const heard = new Set(
    answeredRows
      .filter((row) => {
        const data = row.data as { meetingId?: string; told?: boolean }
        return data.told === true || (data.meetingId !== undefined && circle.meetingIds.has(data.meetingId))
      })
      .map((row) => row.itemId),
  )
  const answeredSince = (
    await listItems(exec, {
      contextId: meeting.contextId,
      ids: [...new Set(answeredRows.map((row) => row.itemId))],
    })
  ).filter((item) => !isOpen(item) && !heard.has(item.id))
  const decidedSince = decisionsInContext.filter((item) => inWindow(item.createdAt))

  const placedRows =
    circle.meetingIds.size === 0
      ? []
      : await exec
          .select({ itemId: agendaLines.itemId })
          .from(agendaLines)
          .where(and(inArray(agendaLines.meetingId, [...circle.meetingIds]), isNotNull(agendaLines.itemId)))
  const placed = new Set(placedRows.map((row) => row.itemId!))
  const byId = new Map<string, ItemView>()
  const belongs = async (item: ItemView, depth = 0): Promise<boolean> => {
    if (
      (item.originMeetingId !== null && circle.meetingIds.has(item.originMeetingId)) ||
      placed.has(item.id) ||
      (circle.seriesId !== null && item.targetSeriesId === circle.seriesId) ||
      (item.targetProjectId !== null && circle.projectIds.has(item.targetProjectId)) ||
      (item.project !== null && circle.projectIds.has(item.project.id)) ||
      item.parties.some((party) => party.type === 'group' && circle.groupIds.has(party.id))
    ) {
      return true
    }
    if (!item.parentItemId || depth > 20) return false
    const parent =
      byId.get(item.parentItemId) ??
      (await listItems(exec, { contextId: meeting.contextId, ids: [item.parentItemId] }))[0]
    if (!parent) return false
    byId.set(parent.id, parent)
    return belongs(parent, depth + 1)
  }
  const sinceAnswers: ItemView[] = []
  for (const item of answeredSince) if (!thenIds.has(item.id) && (await belongs(item))) sinceAnswers.push(item)
  const sinceDecisions: ItemView[] = []
  for (const item of decidedSince) if (!thenIds.has(item.id) && (await belongs(item))) sinceDecisions.push(item)

  const decisions = unique([...then.filter((item) => item.kind === 'decision'), ...settled, ...sinceDecisions])
  // A decision recorded from an answer is what is reported, in its own words.
  const decidedFrom = new Set(decisions.flatMap((item) => (item.parentItemId ? [item.parentItemId] : [])))
  const rest = then.filter((item) => item.kind !== 'decision')
  const closed = unique([...rest.filter((item) => !isOpen(item)), ...sinceAnswers]).filter(
    (item) => !decidedFrom.has(item.id),
  )
  const stillOpen = rest.filter(isOpen)
  if (decisions.length + closed.length + stillOpen.length === 0) return null

  return {
    meeting: { id: previous.id, title: previous.title, startsAt: previous.startsAt },
    decisions: decisions.map((item) => ({ itemId: item.id, text: item.text })),
    closed: closed.map((item) => ({
      itemId: item.id,
      kind: item.kind,
      text: item.text,
      resolution: item.resolution,
    })),
    stillOpen: stillOpen.map((item) => ({ itemId: item.id, kind: item.kind, text: item.text })),
  }
}

function unique(list: ItemView[]): ItemView[] {
  const seen = new Set<string>()
  return list.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)))
}

async function lookaheadFor(
  exec: Executor,
  meeting: Meeting,
  today: string,
  now: Date,
): Promise<LookaheadBlock | null> {
  const own = (
    await exec
      .select({ projectId: meetingProjects.projectId })
      .from(meetingProjects)
      .where(eq(meetingProjects.meetingId, meeting.id))
  ).map((row) => row.projectId)
  /* The lookahead reads up and down the project tree: what the projects the
     meeting's sit within, and the ones within them, have coming. Not sideways:
     a sibling's dates are its own. Each row names its project. */
  const tree = own.length > 0 ? await listProjects(exec, meeting.contextId, 'all') : []
  const projectIds = [...new Set([...own, ...ancestorIds(tree, own), ...descendantIds(tree, own)])]
  const until = addDays(today, LOOKAHEAD_DAYS)

  const dueMilestones =
    projectIds.length === 0
      ? []
      : await exec
          .select({
            id: milestones.id,
            projectName: projects.name,
            title: milestones.title,
            dueOn: milestones.dueOn,
          })
          .from(milestones)
          .innerJoin(projects, eq(projects.id, milestones.projectId))
          .where(
            and(
              inArray(milestones.projectId, projectIds),
              eq(projects.contextId, meeting.contextId),
              gte(milestones.dueOn, today),
              lte(milestones.dueOn, until),
              notDeleted(milestones),
            ),
          )
          .orderBy(asc(milestones.dueOn))

  const deadlines = (
    await Promise.all(
      projectIds.map((projectId) =>
        listItems(exec, { contextId: meeting.contextId, projectId, open: true }),
      ),
    )
  )
    .flat()
    .filter((item) => item.dueOn !== null && item.dueOn >= today && item.dueOn <= until)
    .sort((a, b) => a.dueOn!.localeCompare(b.dueOn!))

  const sharesProject =
    projectIds.length === 0
      ? undefined
      : inArray(
          meetings.id,
          exec
            .select({ id: meetingProjects.meetingId })
            .from(meetingProjects)
            .where(inArray(meetingProjects.projectId, projectIds)),
        )
  const linked = or(
    meeting.seriesId ? eq(meetings.seriesId, meeting.seriesId) : undefined,
    sharesProject,
  )
  const next = linked
    ? await exec
        .select({ id: meetings.id, title: meetings.title, startsAt: meetings.startsAt })
        .from(meetings)
        .where(
          and(
            eq(meetings.contextId, meeting.contextId),
            onShelf(meetings),
            ne(meetings.id, meeting.id),
            // A multi-day meeting's own sessions are not what comes next.
            or(isNull(meetings.parentMeetingId), ne(meetings.parentMeetingId, meeting.id)),
            gt(meetings.startsAt, meeting.startsAt ?? now),
            linked,
          ),
        )
        .orderBy(asc(meetings.startsAt))
        .limit(LOOKAHEAD_MEETINGS)
    : []

  if (dueMilestones.length + deadlines.length + next.length === 0) return null
  return {
    milestones: dueMilestones.map((row) => ({ ...row, dueOn: row.dueOn! })),
    deadlines: deadlines.map((item) => ({
      itemId: item.id,
      kind: item.kind,
      text: item.text,
      dueOn: item.dueOn!,
      projectName: item.project?.name ?? '',
    })),
    meetings: next.map((row) => ({ ...row, startsAt: row.startsAt! })),
  }
}
