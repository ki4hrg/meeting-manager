/*
 * The generated blocks of an agenda (docs/SPEC.md, "Workflow"): computed when
 * the agenda is rendered, never stored.
 *
 * The leak rule lives here. "Follow-ups due" and "Since last time" are drawn
 * only from items that were put on an agenda or came out of the meeting, never
 * from everything an attendee happens to owe: what someone owes John in private
 * must not surface in a room it was never raised in.
 */

import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, or } from 'drizzle-orm'
import { NotFoundError, type Executor } from '../core/types'
import {
  agendaLines,
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
   came out of it. Bound to the meeting's context as well, so a stray reference
   could not carry anything across. */
async function itemsOf(exec: Executor, meeting: Meeting): Promise<ItemView[]> {
  const placed = await exec
    .select({ itemId: agendaLines.itemId })
    .from(agendaLines)
    .where(and(eq(agendaLines.meetingId, meeting.id), isNotNull(agendaLines.itemId)))

  const [onAgenda, cameOut] = await Promise.all([
    listItems(exec, { contextId: meeting.contextId, ids: placed.map((row) => row.itemId!) }),
    listItems(exec, { contextId: meeting.contextId, originMeetingId: meeting.id }),
  ])
  const seen = new Set(onAgenda.map((item) => item.id))
  return [...onAgenda, ...cameOut.filter((item) => !seen.has(item.id))]
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

async function sinceLastFor(
  exec: Executor,
  meeting: Meeting,
  now: Date,
): Promise<SinceLastBlock | null> {
  if (!meeting.seriesId) return null

  const [previous] = await exec
    .select()
    .from(meetings)
    .where(
      and(
        eq(meetings.seriesId, meeting.seriesId),
        eq(meetings.contextId, meeting.contextId),
        ne(meetings.id, meeting.id),
        lt(meetings.startsAt, meeting.startsAt ?? now),
      ),
    )
    .orderBy(desc(meetings.startsAt))
    .limit(1)
  if (!previous) return null

  const then = await itemsOf(exec, previous)
  const thenIds = new Set(then.map((item) => item.id))
  // A decision recorded afterwards on something raised there belongs to it too.
  const settled = (await listItems(exec, { contextId: meeting.contextId, kinds: ['decision'] })).filter(
    (item) => item.parentItemId !== null && thenIds.has(item.parentItemId) && !thenIds.has(item.id),
  )

  const decisions = [...then.filter((item) => item.kind === 'decision'), ...settled]
  const rest = then.filter((item) => item.kind !== 'decision')
  const closed = rest.filter((item) => !isOpen(item))
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

/* Calendar days, so plain date arithmetic: no time zone enters into it. */
function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

async function lookaheadFor(
  exec: Executor,
  meeting: Meeting,
  today: string,
  now: Date,
): Promise<LookaheadBlock | null> {
  const projectIds = (
    await exec
      .select({ projectId: meetingProjects.projectId })
      .from(meetingProjects)
      .where(eq(meetingProjects.meetingId, meeting.id))
  ).map((row) => row.projectId)
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
              isNull(milestones.doneAt),
              gte(milestones.dueOn, today),
              lte(milestones.dueOn, until),
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
            ne(meetings.id, meeting.id),
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
