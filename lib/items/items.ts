/*
 * Items: one record type in four kinds (docs/SPEC.md, "Core model").
 *
 * The rules this file holds:
 *
 *   - Topic, question and action convert in place. A decision is always its own
 *     record with its own wording, linked to what it settled.
 *   - A question closes with its answer; a topic or an action closes by being
 *     done. Anything open can be dropped. A decision is never open: it stands
 *     until another supersedes it.
 *   - A context is a hard boundary. An item's project, groups and parent must
 *     sit in the item's own context.
 *   - Every step is logged to item_events, in the same commit as the step.
 */

import { and, asc, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm'
import { parseDay } from '../core/dates'
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
  itemEvents,
  itemParties,
  items,
  meetings,
  people,
  projects,
  series,
} from '../db/schema'
import { notDeleted } from '../db/shelf'
import { getProject } from '../projects/projects'
import { getContext } from '../directory/contexts'

export type ItemKind = (typeof items.$inferSelect)['kind']
export type ItemStatus = (typeof items.$inferSelect)['status']
export type PartyRole = (typeof itemParties.$inferSelect)['role']

export const ITEM_KINDS: ItemKind[] = ['topic', 'question', 'action', 'decision']

/** Still waiting on someone. needs_answer is an open question by another name. */
export const OPEN_STATUSES: ItemStatus[] = ['open', 'needs_answer']

export type PartyRef = { personId: string; groupId?: undefined } | { groupId: string; personId?: undefined }
export type PartyInput = PartyRef & { role: PartyRole }

export type ItemParty = {
  type: 'person' | 'group'
  id: string
  name: string
  role: PartyRole
  isSelf: boolean
}

export type ItemView = {
  id: string
  contextId: string
  kind: ItemKind
  status: ItemStatus
  text: string
  detail: string | null
  resolution: string | null
  project: { id: string; name: string } | null
  dueOn: string | null
  parentItemId: string | null
  supersededByItemId: string | null
  closedAt: Date | null
  originMeetingId: string | null
  targetMeetingId: string | null
  targetSeriesId: string | null
  targetProjectId: string | null
  /** Parked for later, and the day it comes back (none: until brought back). */
  parkedAt: Date | null
  laterOn: string | null
  /** Parked until this item closes, too: whichever comes first brings it back. */
  laterUntilItemId: string | null
  createdAt: Date
  updatedAt: Date
  parties: ItemParty[]
}

export type ItemEventType =
  | 'created'
  | 'edited'
  | 'parties'
  | 'role'
  | 'note'
  | 'converted'
  | 'answered'
  | 'completed'
  | 'dropped'
  | 'reopened'
  | 'spawned'
  | 'superseded'
  | 'targeted'
  | 'discussed'
  | 'parked'
  | 'unparked'

export type ItemEvent = {
  id: string
  itemId: string
  type: ItemEventType
  data: Record<string, unknown>
  source: string
  createdAt: Date
}

export function isOpen(item: { status: ItemStatus }): boolean {
  return OPEN_STATUSES.includes(item.status)
}

/** A question closed with its answer. */
export function isAnswered(item: { kind: ItemKind; status: ItemStatus; resolution: string | null }): boolean {
  return item.kind === 'question' && item.status === 'done' && item.resolution !== null
}

/** Answered questions, latest answer first. */
export function answered<T extends ItemView>(list: T[]): T[] {
  return list
    .filter(isAnswered)
    .sort((a, b) => (b.closedAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? 0))
}

// ─── reading ─────────────────────────────────────────────────────────────────

async function loadViews(exec: Executor, where: SQL | undefined, limit?: number): Promise<ItemView[]> {
  const query = exec
    .select({ item: items, projectName: projects.name })
    .from(items)
    .leftJoin(projects, eq(projects.id, items.projectId))
    .where(where)
    // Deadlines first, soonest first; then newest.
    .orderBy(sql`${items.dueOn} asc nulls last`, sql`${items.createdAt} desc`)
  const rows = await (limit ? query.limit(limit) : query)
  if (rows.length === 0) return []

  const parties = await exec
    .select({
      itemId: itemParties.itemId,
      role: itemParties.role,
      personId: itemParties.personId,
      groupId: itemParties.groupId,
      personName: people.name,
      isSelf: people.isSelf,
      groupName: groups.name,
    })
    .from(itemParties)
    .leftJoin(people, eq(people.id, itemParties.personId))
    .leftJoin(groups, eq(groups.id, itemParties.groupId))
    .where(
      inArray(
        itemParties.itemId,
        rows.map((row) => row.item.id),
      ),
    )
    .orderBy(asc(itemParties.createdAt))

  const byItem = new Map<string, ItemParty[]>()
  for (const party of parties) {
    const list = byItem.get(party.itemId) ?? []
    list.push(
      party.personId
        ? {
            type: 'person',
            id: party.personId,
            name: party.personName ?? '',
            role: party.role,
            isSelf: party.isSelf ?? false,
          }
        : {
            type: 'group',
            id: party.groupId!,
            name: party.groupName ?? '',
            role: party.role,
            isSelf: false,
          },
    )
    byItem.set(party.itemId, list)
  }

  return rows.map(({ item, projectName }) => ({
    id: item.id,
    contextId: item.contextId,
    kind: item.kind,
    status: item.status,
    text: item.text,
    detail: item.detail,
    resolution: item.resolution,
    project: item.projectId ? { id: item.projectId, name: projectName ?? '' } : null,
    dueOn: item.dueOn,
    parentItemId: item.parentItemId,
    supersededByItemId: item.supersededByItemId,
    closedAt: item.closedAt,
    originMeetingId: item.originMeetingId,
    targetMeetingId: item.targetMeetingId,
    targetSeriesId: item.targetSeriesId,
    targetProjectId: item.targetProjectId,
    parkedAt: item.parkedAt,
    laterOn: item.laterOn,
    laterUntilItemId: item.laterUntilItemId,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    parties: byItem.get(item.id) ?? [],
  }))
}

export async function getItem(exec: Executor, id: string): Promise<ItemView> {
  const [view] = await loadViews(exec, and(eq(items.id, id), notDeleted(items)))
  if (!view) throw new NotFoundError('Item', id)
  return view
}

export type ItemFilter = {
  /** Always required: nothing is ever listed across contexts. */
  contextId: string
  kinds?: ItemKind[]
  statuses?: ItemStatus[]
  /** Only these, still within the context. An empty list matches nothing. */
  ids?: string[]
  /** Came out of, or was captured in, this meeting. */
  originMeetingId?: string
  /** Shorthand for the open statuses, or for everything else. */
  open?: boolean
  projectId?: string
  /** Raised at one of this series' meetings (or their sessions), or aimed at its next one. */
  seriesId?: string
  /** Items naming this party, in any role unless one is given. */
  party?: PartyRef & { role?: PartyRole }
  /** Open, with no party and no project: nothing says where it belongs yet. */
  inbox?: boolean
  /** Parked until this item closes; or, with `true`, until any item does. */
  waitingOn?: string | true
  search?: string
  limit?: number
}

function partyExists(party: PartyRef & { role?: PartyRole }): SQL {
  const who = party.personId
    ? sql`${itemParties.personId} = ${party.personId}`
    : sql`${itemParties.groupId} = ${party.groupId}`
  const role = party.role ? sql` and ${itemParties.role} = ${party.role}` : sql``
  return sql`exists (select 1 from ${itemParties}
    where ${itemParties.itemId} = ${items.id} and ${who}${role})`
}

export async function listItems(exec: Executor, filter: ItemFilter): Promise<ItemView[]> {
  const conditions: SQL[] = [eq(items.contextId, filter.contextId), notDeleted(items)]

  if (filter.ids) {
    if (filter.ids.length === 0) return []
    conditions.push(inArray(items.id, filter.ids))
  }
  if (filter.originMeetingId) conditions.push(eq(items.originMeetingId, filter.originMeetingId))
  if (filter.kinds?.length) conditions.push(inArray(items.kind, filter.kinds))
  if (filter.statuses?.length) conditions.push(inArray(items.status, filter.statuses))
  if (filter.open === true) conditions.push(inArray(items.status, OPEN_STATUSES))
  if (filter.open === false) conditions.push(sql`${items.status} not in ('open', 'needs_answer')`)
  if (filter.projectId) conditions.push(eq(items.projectId, filter.projectId))
  if (filter.seriesId) {
    conditions.push(
      // A session's series is its parent meeting's.
      sql`(${items.targetSeriesId} = ${filter.seriesId} or exists (select 1 from meetings m
        left join meetings parent on parent.id = m.parent_meeting_id
        where m.id = ${items.originMeetingId}
          and (m.series_id = ${filter.seriesId} or parent.series_id = ${filter.seriesId})))`,
    )
  }
  if (filter.party) conditions.push(partyExists(filter.party))
  if (filter.inbox) {
    conditions.push(
      inArray(items.status, OPEN_STATUSES),
      sql`${items.projectId} is null`,
      sql`not exists (select 1 from ${itemParties} where ${itemParties.itemId} = ${items.id})`,
    )
  }
  if (filter.waitingOn === true) conditions.push(sql`${items.laterUntilItemId} is not null`)
  else if (filter.waitingOn) conditions.push(eq(items.laterUntilItemId, filter.waitingOn))
  if (filter.search?.trim()) {
    const pattern = `%${filter.search.trim().replace(/[\\%_]/g, '\\$&')}%`
    conditions.push(
      sql`(${items.text} ilike ${pattern} or ${items.detail} ilike ${pattern}
        or ${items.resolution} ilike ${pattern})`,
    )
  }

  return loadViews(exec, and(...conditions), filter.limit)
}

export type OpenCounts = {
  inbox: number
  byProject: Map<string, number>
  byPerson: Map<string, number>
  byGroup: Map<string, number>
}

/** Open items in a context with no project and no party: what waits in the Inbox. */
export async function inboxCount(exec: Executor, contextId: string): Promise<number> {
  const [row] = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(items)
    .where(
      and(
        eq(items.contextId, contextId),
        notDeleted(items),
        inArray(items.status, OPEN_STATUSES),
        sql`${items.projectId} is null`,
        sql`not exists (select 1 from ${itemParties} where ${itemParties.itemId} = ${items.id})`,
      ),
    )
  return row?.n ?? 0
}

/** How much is open in a context, for the tiles and list pages. */
export async function openCounts(exec: Executor, contextId: string): Promise<OpenCounts> {
  const open = and(eq(items.contextId, contextId), notDeleted(items), inArray(items.status, OPEN_STATUSES))

  const projectRows = await exec
    .select({ id: items.projectId, n: sql<number>`count(*)::int` })
    .from(items)
    .where(and(open, sql`${items.projectId} is not null`))
    .groupBy(items.projectId)

  const partyRows = await exec
    .select({
      personId: itemParties.personId,
      groupId: itemParties.groupId,
      n: sql<number>`count(*)::int`,
    })
    .from(itemParties)
    .innerJoin(items, eq(items.id, itemParties.itemId))
    .where(open)
    .groupBy(itemParties.personId, itemParties.groupId)

  const counts: OpenCounts = {
    inbox: await inboxCount(exec, contextId),
    byProject: new Map(projectRows.map((row) => [row.id!, row.n])),
    byPerson: new Map(),
    byGroup: new Map(),
  }
  for (const row of partyRows) {
    if (row.personId) counts.byPerson.set(row.personId, row.n)
    else if (row.groupId) counts.byGroup.set(row.groupId, row.n)
  }
  return counts
}

export type ThreadEntry = { item: ItemView; depth: number }

/**
 * The whole thread an item belongs to: up to the root, then everything that
 * came out of it, in the order a reader would follow.
 */
export async function getThread(
  exec: Executor,
  id: string,
): Promise<{ entries: ThreadEntry[]; events: ItemEvent[] }> {
  const rows = await exec.execute(sql`
    with recursive up as (
      select id, parent_item_id from items where id = ${id}
      union all
      select i.id, i.parent_item_id from items i join up on i.id = up.parent_item_id
    ),
    down as (
      select id from up where parent_item_id is null
      union all
      select i.id from items i join down on i.parent_item_id = down.id
    )
    select id from down`)

  const ids = [...rows].map((row) => (row as { id: string }).id)
  if (ids.length === 0) throw new NotFoundError('Item', id)

  const views = await loadViews(exec, inArray(items.id, ids))
  const oldestFirst = [...views].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())

  const children = new Map<string | null, ItemView[]>()
  for (const view of oldestFirst) {
    const list = children.get(view.parentItemId) ?? []
    list.push(view)
    children.set(view.parentItemId, list)
  }

  const entries: ThreadEntry[] = []
  const walk = (parentId: string | null, depth: number) => {
    for (const item of children.get(parentId) ?? []) {
      entries.push({ item, depth })
      walk(item.id, depth + 1)
    }
  }
  walk(null, 0)

  const events = await exec
    .select()
    .from(itemEvents)
    .where(inArray(itemEvents.itemId, ids))
    .orderBy(asc(itemEvents.createdAt))

  return {
    entries,
    events: events.map((event) => ({
      id: event.id,
      itemId: event.itemId,
      type: event.type as ItemEventType,
      data: event.data as Record<string, unknown>,
      source: event.source,
      createdAt: event.createdAt,
    })),
  }
}

// ─── writing ─────────────────────────────────────────────────────────────────

async function logEvent(
  exec: Executor,
  actor: ActorContext,
  itemId: string,
  type: ItemEventType,
  data: Record<string, unknown> = {},
) {
  await exec
    .insert(itemEvents)
    .values({ itemId, type, data, source: actor.source, requestId: actor.requestId })
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}

async function assertProjectIn(exec: Executor, projectId: string, contextId: string) {
  const [project] = await exec
    .select({ contextId: projects.contextId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
  if (!project) throw new NotFoundError('Project', projectId)
  if (project.contextId !== contextId) {
    throw new ValidationError('That project belongs to another context.')
  }
}

/** Where an item is to be raised: one meeting, or the next occurrence of a series. */
export type ItemTarget = { meetingId: string } | { seriesId: string } | { projectId: string } | null

async function assertMeetingIn(exec: Executor, meetingId: string, contextId: string) {
  const [meeting] = await exec
    .select({ contextId: meetings.contextId })
    .from(meetings)
    .where(eq(meetings.id, meetingId))
    .limit(1)
  if (!meeting) throw new NotFoundError('Meeting', meetingId)
  if (meeting.contextId !== contextId) {
    throw new ValidationError('That meeting belongs to another context.')
  }
}

async function assertSeriesIn(exec: Executor, seriesId: string, contextId: string) {
  const [row] = await exec
    .select({ contextId: series.contextId })
    .from(series)
    .where(eq(series.id, seriesId))
    .limit(1)
  if (!row) throw new NotFoundError('Series', seriesId)
  if (row.contextId !== contextId) {
    throw new ValidationError('That series belongs to another context.')
  }
}

async function targetColumns(exec: Executor, target: ItemTarget | undefined, contextId: string) {
  const none = { targetMeetingId: null, targetSeriesId: null, targetProjectId: null }
  if (!target) return none
  if ('meetingId' in target) {
    await assertMeetingIn(exec, target.meetingId, contextId)
    return { ...none, targetMeetingId: target.meetingId }
  }
  if ('projectId' in target) {
    const project = await getProject(exec, target.projectId)
    if (project.contextId !== contextId) throw new ValidationError('That project belongs to another context.')
    return { ...none, targetProjectId: target.projectId }
  }
  await assertSeriesIn(exec, target.seriesId, contextId)
  return { ...none, targetSeriesId: target.seriesId }
}

/* Replaces an item's parties. Validated here rather than left to the foreign
   keys so the refusal can say what was wrong. */
async function writeParties(
  exec: Executor,
  itemId: string,
  contextId: string,
  parties: PartyInput[],
): Promise<void> {
  const seen = new Set<string>()
  for (const party of parties) {
    const key = party.personId ? `p:${party.personId}` : `g:${party.groupId}`
    if (seen.has(key)) throw new ValidationError('The same party is listed twice.')
    seen.add(key)

    if (party.personId) {
      const [person] = await exec
        .select({ id: people.id })
        .from(people)
        .where(eq(people.id, party.personId))
        .limit(1)
      if (!person) throw new NotFoundError('Person', party.personId)
    } else {
      const [group] = await exec
        .select({ contextId: groups.contextId })
        .from(groups)
        .where(eq(groups.id, party.groupId!))
        .limit(1)
      if (!group) throw new NotFoundError('Group', party.groupId!)
      if (group.contextId !== contextId) {
        throw new ValidationError('That group belongs to another context.')
      }
    }
  }

  await exec.delete(itemParties).where(eq(itemParties.itemId, itemId))
  if (parties.length > 0) {
    await exec.insert(itemParties).values(
      parties.map((party, index) => ({
        itemId,
        personId: party.personId ?? null,
        groupId: party.groupId ?? null,
        role: party.role,
        // Keeps the order given: rows inserted together share a timestamp.
        createdAt: new Date(Date.now() + index),
      })),
    )
  }
}

export type CreateItemInput = {
  contextId: string
  text: string
  kind?: ItemKind
  detail?: string | null
  projectId?: string | null
  dueOn?: string | null
  parties?: PartyInput[]
  /** The item this one came out of. */
  parentItemId?: string | null
  /** The meeting it was captured in. */
  originMeetingId?: string | null
  target?: ItemTarget
}

export async function createItem(
  exec: Executor,
  actor: ActorContext,
  input: CreateItemInput,
): Promise<ItemView> {
  const text = input.text.trim()
  if (text === '') throw new ValidationError('Enter some text.')
  const kind = input.kind ?? 'topic'
  const dueOn = parseDay(input.dueOn)

  return inTransaction(exec, async (tx) => {
    await getContext(tx, input.contextId)
    if (input.projectId) await assertProjectIn(tx, input.projectId, input.contextId)

    if (input.parentItemId) {
      const parent = await getItem(tx, input.parentItemId)
      if (parent.contextId !== input.contextId) {
        throw new ValidationError('A follow-up stays in the context of the item it came from.')
      }
    }

    if (input.originMeetingId) await assertMeetingIn(tx, input.originMeetingId, input.contextId)
    const target = await targetColumns(tx, input.target, input.contextId)

    const [row] = await tx
      .insert(items)
      .values({
        ...target,
        originMeetingId: input.originMeetingId ?? null,
        contextId: input.contextId,
        kind,
        // A decision is a record of something settled; it is never open.
        status: kind === 'decision' ? 'decided' : 'open',
        text,
        detail: blankToNull(input.detail),
        projectId: input.projectId ?? null,
        dueOn,
        parentItemId: input.parentItemId ?? null,
      })
      .returning()

    await writeParties(tx, row!.id, input.contextId, input.parties ?? [])
    await logEvent(tx, actor, row!.id, 'created', { kind })
    if (input.parentItemId) {
      await logEvent(tx, actor, input.parentItemId, 'spawned', { itemId: row!.id, kind, text })
    }

    return getItem(tx, row!.id)
  })
}

export type UpdateItemInput = {
  text?: string
  detail?: string | null
  projectId?: string | null
  dueOn?: string | null
}

export async function updateItem(
  exec: Executor,
  actor: ActorContext,
  id: string,
  input: UpdateItemInput,
): Promise<ItemView> {
  return inTransaction(exec, async (tx) => {
    const item = await getItem(tx, id)
    const patch: Partial<typeof items.$inferInsert> = {}

    if (input.text !== undefined) {
      const text = input.text.trim()
      if (text === '') throw new ValidationError('Enter some text.')
      if (text !== item.text) patch.text = text
    }
    if (input.detail !== undefined) {
      const detail = blankToNull(input.detail)
      if (detail !== item.detail) patch.detail = detail
    }
    if (input.projectId !== undefined) {
      const projectId = input.projectId || null
      if (projectId) await assertProjectIn(tx, projectId, item.contextId)
      if (projectId !== (item.project?.id ?? null)) patch.projectId = projectId
    }
    if (input.dueOn !== undefined) {
      const dueOn = parseDay(input.dueOn)
      if (dueOn !== item.dueOn) patch.dueOn = dueOn
    }

    const changed = Object.keys(patch)
    if (changed.length === 0) return item

    await tx
      .update(items)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(items.id, id))
    await logEvent(tx, actor, id, 'edited', { fields: changed })
    return getItem(tx, id)
  })
}

/** Point an item at a meeting or a series, or clear that. */
export async function setItemTarget(
  exec: Executor,
  actor: ActorContext,
  id: string,
  target: ItemTarget,
): Promise<ItemView> {
  return inTransaction(exec, async (tx) => {
    const item = await getItem(tx, id)
    const columns = await targetColumns(tx, target, item.contextId)
    if (
      columns.targetMeetingId === item.targetMeetingId &&
      columns.targetSeriesId === item.targetSeriesId &&
      columns.targetProjectId === item.targetProjectId
    ) {
      return item
    }
    await tx
      .update(items)
      .set({ ...columns, updatedAt: new Date() })
      .where(eq(items.id, id))
    await logEvent(tx, actor, id, 'targeted', {
      meetingId: columns.targetMeetingId,
      seriesId: columns.targetSeriesId,
      projectId: columns.targetProjectId,
    })
    return getItem(tx, id)
  })
}

/* Closing an item ends its parking: reopened, it is back on the lists. */
const NOT_PARKED = { parkedAt: null, laterOn: null, laterUntilItemId: null }

/**
 * Park an open item for later: it leaves "I owe" and "Waiting on" until
 * `until` (the day it comes back on its own), until `untilItem` closes, or,
 * with neither, until brought back; with both, whichever comes first. A
 * deadline coming close brings it back regardless (`lib/items/horizon.ts`).
 * Parking again moves the day, and keeps the item it waits on unless
 * `untilItem` is given (null or empty: none). A due date before the day it
 * comes back moves to that day, so it is not overdue while it waits.
 */
export async function parkItem(
  exec: Executor,
  actor: ActorContext,
  id: string,
  input: { until?: string | null; untilItem?: string | null } = {},
): Promise<ItemView> {
  const until = parseDay(input.until)
  return inTransaction(exec, async (tx) => {
    const item = await getItem(tx, id)
    if (!isOpen(item)) throw new ValidationError('Only an open item can wait for later.')
    const untilItem = input.untilItem === undefined ? item.laterUntilItemId : blankToNull(input.untilItem)
    if (untilItem) {
      if (untilItem === id) throw new ValidationError('An item cannot wait on itself.')
      const blocker = await getItem(tx, untilItem)
      if (blocker.contextId !== item.contextId) {
        throw new ValidationError('That item belongs to another context.')
      }
      if (!isOpen(blocker)) throw new ValidationError('That item is already closed.')
    }
    const dueOn = until && item.dueOn && item.dueOn < until ? until : item.dueOn
    if (item.parkedAt && item.laterOn === until && item.laterUntilItemId === untilItem && dueOn === item.dueOn) {
      return item
    }
    await tx
      .update(items)
      .set({
        parkedAt: item.parkedAt ?? new Date(),
        laterOn: until,
        laterUntilItemId: untilItem,
        dueOn,
        updatedAt: new Date(),
      })
      .where(eq(items.id, id))
    await logEvent(tx, actor, id, 'parked', {
      ...(until ? { until } : {}),
      ...(untilItem ? { untilItem } : {}),
    })
    if (dueOn !== item.dueOn) await logEvent(tx, actor, id, 'edited', { fields: ['dueOn'] })
    return getItem(tx, id)
  })
}

/* An item has closed: whatever was parked until it is back on the lists, in
   the same commit, each saying what brought it back. What the closing step
   logs names them, so both histories tell it. */
async function release(
  tx: Executor,
  actor: ActorContext,
  blocker: ItemView,
): Promise<{ released?: { id: string; text: string }[] }> {
  const waiting = await tx
    .update(items)
    .set({ ...NOT_PARKED, updatedAt: new Date() })
    .where(and(eq(items.laterUntilItemId, blocker.id), inArray(items.status, OPEN_STATUSES)))
    .returning({ id: items.id, text: items.text })
  for (const one of waiting) {
    await logEvent(tx, actor, one.id, 'unparked', { itemId: blocker.id, text: blocker.text })
  }
  return waiting.length > 0 ? { released: waiting } : {}
}

/** Back from later, onto the lists now. */
export async function unparkItem(exec: Executor, actor: ActorContext, id: string): Promise<ItemView> {
  return inTransaction(exec, async (tx) => {
    const item = await getItem(tx, id)
    if (!item.parkedAt) return item
    await tx
      .update(items)
      .set({ ...NOT_PARKED, updatedAt: new Date() })
      .where(eq(items.id, id))
    await logEvent(tx, actor, id, 'unparked')
    return getItem(tx, id)
  })
}

/** Raised in a meeting but not finished: the item stays open and the history says so. */
export async function markDiscussed(
  exec: Executor,
  actor: ActorContext,
  id: string,
  meetingId: string,
): Promise<void> {
  await inTransaction(exec, async (tx) => {
    const item = await getItem(tx, id)
    await assertMeetingIn(tx, meetingId, item.contextId)
    /* Aimed at the next meeting for a project, it has now had that meeting. */
    await tx
      .update(items)
      .set({ updatedAt: new Date(), ...(item.targetProjectId ? { targetProjectId: null } : {}) })
      .where(eq(items.id, id))
    await logEvent(tx, actor, id, 'discussed', { meetingId })
  })
}

export async function setItemParties(
  exec: Executor,
  actor: ActorContext,
  id: string,
  parties: PartyInput[],
): Promise<ItemView> {
  return inTransaction(exec, async (tx) => {
    const item = await getItem(tx, id)
    await writeParties(tx, id, item.contextId, parties)
    await tx.update(items).set({ updatedAt: new Date() }).where(eq(items.id, id))

    const updated = await getItem(tx, id)
    await logEvent(tx, actor, id, 'parties', {
      owners: updated.parties.filter((party) => party.role === 'owner').map((party) => party.name),
      with: updated.parties.filter((party) => party.role === 'with').map((party) => party.name),
    })
    return updated
  })
}

const partyKey = (party: PartyInput) => `${party.personId ?? party.groupId}:${party.role}`

function toInputs(parties: ItemParty[]): PartyInput[] {
  return parties.map((party) =>
    party.type === 'person'
      ? { personId: party.id, role: party.role }
      : { groupId: party.id, role: party.role },
  )
}

/**
 * Add one party, or change the role of one already there. A party added or
 * moved goes after the owners already there, so on an action or a topic it
 * becomes a collaborator; `lead` puts it first instead, and `lead: false`
 * moves one already there to the end. A change of role is recorded as that,
 * not as a new list of people.
 */
export async function addItemParty(
  exec: Executor,
  actor: ActorContext,
  id: string,
  party: PartyInput,
  opts: { lead?: boolean } = {},
): Promise<ItemView> {
  return inTransaction(exec, async (tx) => {
    const item = await getItem(tx, id)
    const partyId = party.personId ?? party.groupId
    const existing = item.parties.find((one) => one.id === partyId)
    const others = toInputs(item.parties.filter((one) => one !== existing))
    const parties = opts.lead ? [party, ...others] : [...others, party]
    if (!existing) return setItemParties(tx, actor, id, parties)

    const same = (a: PartyInput[], b: PartyInput[]) =>
      a.map(partyKey).join() === b.map(partyKey).join()
    if (existing.role === party.role && opts.lead === undefined) return item
    if (same(parties, toInputs(item.parties))) return item
    await writeParties(tx, id, item.contextId, parties)
    await tx.update(items).set({ updatedAt: new Date() }).where(eq(items.id, id))
    const updated = await getItem(tx, id)
    const lead = updated.parties.find((one) => one.role === 'owner')
    await logEvent(tx, actor, id, 'role', {
      name: existing.name,
      role: party.role,
      // An owner after the first: a collaborator, on a kind that has them.
      collaborator: party.role === 'owner' && lead?.id !== partyId,
    })
    return updated
  })
}

export async function removeItemParty(
  exec: Executor,
  actor: ActorContext,
  id: string,
  party: PartyRef,
): Promise<ItemView> {
  const item = await getItem(exec, id)
  const partyId = party.personId ?? party.groupId
  return setItemParties(
    exec,
    actor,
    id,
    toInputs(item.parties.filter((existing) => existing.id !== partyId)),
  )
}

/** Topic, question and action change into one another, keeping the record and its history. */
export async function convertItem(
  exec: Executor,
  actor: ActorContext,
  id: string,
  kind: ItemKind,
): Promise<ItemView> {
  return inTransaction(exec, async (tx) => {
    const item = await getItem(tx, id)
    if (item.kind === kind) return item

    if (kind === 'decision') {
      throw new ValidationError(
        'A decision is its own record with its own wording. Record one from this item instead.',
      )
    }
    if (item.kind === 'decision') {
      throw new ValidationError('A decision cannot become something else. Supersede it instead.')
    }
    if (!isOpen(item)) throw new ValidationError('Reopen this item before converting it.')

    await tx
      .update(items)
      // needs_answer only means something on a question.
      .set({ kind, status: 'open', updatedAt: new Date() })
      .where(eq(items.id, id))
    await logEvent(tx, actor, id, 'converted', { from: item.kind, to: kind })
    return getItem(tx, id)
  })
}

/* Report back: the resolution, raised with another party as a topic of its
   own. This is how an answer from one meeting reaches another. */
async function reportBack(
  exec: Executor,
  actor: ActorContext,
  source: ItemView,
  to: PartyRef,
  resolution: string | null,
): Promise<ItemView> {
  return createItem(exec, actor, {
    contextId: source.contextId,
    kind: 'topic',
    text: source.text,
    detail: resolution,
    projectId: source.project?.id ?? null,
    parentItemId: source.id,
    parties: [{ ...to, role: 'with' }],
  })
}

/** A topic or an action, finished. */
export async function completeItem(
  exec: Executor,
  actor: ActorContext,
  id: string,
  input: { resolution?: string | null } = {},
): Promise<ItemView> {
  return inTransaction(exec, async (tx) => {
    const item = await getItem(tx, id)
    if (item.kind === 'decision') throw new ValidationError('A decision is already settled.')
    if (item.kind === 'question') {
      throw new ValidationError('A question closes with its answer. Record the answer.')
    }
    if (!isOpen(item)) throw new ValidationError('This item is already closed.')

    const resolution = blankToNull(input.resolution)
    await tx
      .update(items)
      .set({
        status: 'done',
        closedAt: new Date(),
        updatedAt: new Date(),
        ...NOT_PARKED,
        ...(resolution ? { resolution } : {}),
      })
      .where(eq(items.id, id))
    await logEvent(tx, actor, id, 'completed', {
      ...(resolution ? { resolution } : {}),
      ...(await release(tx, actor, item)),
    })
    return getItem(tx, id)
  })
}

/**
 * Close a question with its answer. It stays a question; a decision, if the
 * answer amounts to one, is recorded separately with wording of its own.
 */
export async function answerItem(
  exec: Executor,
  actor: ActorContext,
  id: string,
  input: { answer: string; reportTo?: PartyRef | null },
): Promise<{ item: ItemView; report: ItemView | null }> {
  const answer = input.answer.trim()
  if (answer === '') throw new ValidationError('Enter the answer.')

  return inTransaction(exec, async (tx) => {
    const item = await getItem(tx, id)
    if (item.kind !== 'question') throw new ValidationError('Only a question takes an answer.')
    if (!isOpen(item)) throw new ValidationError('This question is already closed.')

    await tx
      .update(items)
      .set({ status: 'done', resolution: answer, closedAt: new Date(), updatedAt: new Date(), ...NOT_PARKED })
      .where(eq(items.id, id))
    await logEvent(tx, actor, id, 'answered', { answer, ...(await release(tx, actor, item)) })

    const report = input.reportTo ? await reportBack(tx, actor, item, input.reportTo, answer) : null
    return { item: await getItem(tx, id), report }
  })
}

/**
 * A question recorded already answered: asked and settled somewhere this app
 * did not see, kept with its answer on the project, group or series it belongs to.
 */
export async function recordAnswered(
  exec: Executor,
  actor: ActorContext,
  input: Omit<CreateItemInput, 'kind'> & { answer: string },
): Promise<ItemView> {
  const { answer, ...question } = input
  if (answer.trim() === '') throw new ValidationError('Enter the answer.')
  return inTransaction(exec, async (tx) => {
    const item = await createItem(tx, actor, { ...question, kind: 'question' })
    return (await answerItem(tx, actor, item.id, { answer })).item
  })
}

export async function dropItem(exec: Executor, actor: ActorContext, id: string): Promise<ItemView> {
  return inTransaction(exec, async (tx) => {
    const item = await getItem(tx, id)
    if (item.kind === 'decision') {
      throw new ValidationError('A decision cannot be dropped. Supersede it instead.')
    }
    if (!isOpen(item)) throw new ValidationError('This item is already closed.')

    // What `undropItem` puts back.
    const [row] = await tx
      .select({
        status: items.status,
        parkedAt: items.parkedAt,
        laterOn: items.laterOn,
        laterUntilItemId: items.laterUntilItemId,
      })
      .from(items)
      .where(eq(items.id, id))
    await tx
      .update(items)
      .set({ status: 'dropped', closedAt: new Date(), updatedAt: new Date(), ...NOT_PARKED })
      .where(eq(items.id, id))
    await logEvent(tx, actor, id, 'dropped', {
      before: {
        status: row!.status,
        parkedAt: row!.parkedAt?.toISOString() ?? null,
        laterOn: row!.laterOn,
        laterUntilItemId: row!.laterUntilItemId,
      },
      ...(await release(tx, actor, item)),
    })
    return getItem(tx, id)
  })
}

/**
 * Undo a drop: the item stands exactly as it did, parking included, and the
 * drop leaves its history. Only while the drop is the last thing that
 * happened to it; after that, it is reopened from its own page.
 */
export async function undropItem(exec: Executor, _actor: ActorContext, id: string): Promise<ItemView> {
  return inTransaction(exec, async (tx) => {
    const item = await getItem(tx, id)
    const [last] = await tx
      .select()
      .from(itemEvents)
      .where(eq(itemEvents.itemId, id))
      .orderBy(desc(itemEvents.createdAt))
      .limit(1)
    if (item.status !== 'dropped' || last?.type !== 'dropped') {
      throw new ValidationError('This item has changed since it was dropped. Reopen it from its own page.')
    }

    const before = (
      last.data as {
        before?: {
          status: ItemStatus
          parkedAt: string | null
          laterOn: string | null
          laterUntilItemId?: string | null
        }
      }
    ).before
    /* Waiting on an item that has closed since, it would have come back:
       it stands as it would have. */
    const blocker = before?.laterUntilItemId
      ? await getItem(tx, before.laterUntilItemId).catch(() => null)
      : null
    const stillWaits = blocker !== null && isOpen(blocker)
    const parked = before?.parkedAt && (stillWaits || !before.laterUntilItemId || before.laterOn)
    await tx
      .update(items)
      .set({
        status: before?.status ?? 'open',
        parkedAt: parked ? new Date(before.parkedAt!) : null,
        laterOn: parked ? (before?.laterOn ?? null) : null,
        laterUntilItemId: parked && stillWaits ? before!.laterUntilItemId! : null,
        closedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(items.id, id))
    await tx.delete(itemEvents).where(eq(itemEvents.id, last.id))
    return getItem(tx, id)
  })
}

/**
 * Deleted, for what was captured by mistake ("test"): kept 30 days for Restore
 * on Settings, then gone (lib/archive). Done or dropped is an item's archive,
 * so an open item is closed first. Only an item that stands alone: one that
 * came out of a meeting, is part of a thread or sits on an agenda is part of
 * the record, and stays closed instead.
 */
export async function deleteItem(exec: Executor, _actor: ActorContext, id: string): Promise<void> {
  await inTransaction(exec, async (tx) => {
    const item = await getItem(tx, id)
    if (isOpen(item)) throw new ValidationError('Mark it done or drop it first.')
    const [linked] = await tx
      .select({ id: items.id })
      .from(items)
      .where(or(eq(items.parentItemId, id), eq(items.supersededByItemId, id)))
      .limit(1)
    const [placed] = await tx
      .select({ id: agendaLines.id })
      .from(agendaLines)
      .where(eq(agendaLines.itemId, id))
      .limit(1)
    if (item.originMeetingId || item.parentItemId || item.supersededByItemId || linked || placed) {
      throw new ValidationError('This item is part of the record, so it stays closed.')
    }
    await tx.update(items).set({ deletedAt: new Date() }).where(eq(items.id, id))
  })
}

/** Whether Delete is on offer for an item: closed and standing alone. */
export async function canDeleteItem(exec: Executor, item: ItemView): Promise<boolean> {
  if (isOpen(item) || item.originMeetingId || item.parentItemId || item.supersededByItemId) return false
  const [linked] = await exec
    .select({ id: items.id })
    .from(items)
    .where(or(eq(items.parentItemId, item.id), eq(items.supersededByItemId, item.id)))
    .limit(1)
  const [placed] = await exec
    .select({ id: agendaLines.id })
    .from(agendaLines)
    .where(eq(agendaLines.itemId, item.id))
    .limit(1)
  return !linked && !placed
}

export async function reopenItem(
  exec: Executor,
  actor: ActorContext,
  id: string,
): Promise<ItemView> {
  return inTransaction(exec, async (tx) => {
    const item = await getItem(tx, id)
    if (item.kind === 'decision') throw new ValidationError('A decision is never open.')
    if (isOpen(item)) return item

    await tx
      .update(items)
      // The old answer stays in the history; the field is cleared for the next one.
      .set({ status: 'open', closedAt: null, resolution: null, updatedAt: new Date() })
      .where(eq(items.id, id))
    await logEvent(tx, actor, id, 'reopened')
    return getItem(tx, id)
  })
}

export type RecordDecisionInput = {
  text: string
  detail?: string | null
  /** What the decision settles. It supplies the context and, by default, the project. */
  fromItemId?: string | null
  /** Required when there is no source item. */
  contextId?: string
  projectId?: string | null
  parties?: PartyInput[]
  reportTo?: PartyRef | null
}

/** A decision as its own record, linked to the item it settled when there is one. */
export async function recordDecision(
  exec: Executor,
  actor: ActorContext,
  input: RecordDecisionInput,
): Promise<{ item: ItemView; report: ItemView | null }> {
  return inTransaction(exec, async (tx) => {
    const source = input.fromItemId ? await getItem(tx, input.fromItemId) : null
    const contextId = source?.contextId ?? input.contextId
    if (!contextId) throw new ValidationError('Say which context this decision belongs to.')

    const decision = await createItem(tx, actor, {
      contextId,
      kind: 'decision',
      text: input.text,
      detail: input.detail,
      projectId: input.projectId !== undefined ? input.projectId : (source?.project?.id ?? null),
      parties: input.parties,
      parentItemId: source?.id ?? null,
    })

    const report = input.reportTo
      ? await reportBack(tx, actor, decision, input.reportTo, decision.detail)
      : null
    return { item: decision, report }
  })
}

/** Replace a decision with a new one. The old record stays, marked and linked. */
export async function supersedeDecision(
  exec: Executor,
  actor: ActorContext,
  id: string,
  input: { text: string; detail?: string | null },
): Promise<ItemView> {
  return inTransaction(exec, async (tx) => {
    const old = await getItem(tx, id)
    if (old.kind !== 'decision') throw new ValidationError('Only a decision can be superseded.')
    if (old.status === 'superseded') {
      throw new ValidationError('This decision has already been superseded.')
    }

    const replacement = await createItem(tx, actor, {
      contextId: old.contextId,
      kind: 'decision',
      text: input.text,
      detail: input.detail,
      projectId: old.project?.id ?? null,
      parties: toInputs(old.parties),
      parentItemId: old.id,
    })

    await tx
      .update(items)
      .set({
        status: 'superseded',
        supersededByItemId: replacement.id,
        closedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(items.id, id))
    await logEvent(tx, actor, id, 'superseded', { itemId: replacement.id })
    return replacement
  })
}

export async function addNote(
  exec: Executor,
  actor: ActorContext,
  id: string,
  text: string,
): Promise<void> {
  const note = text.trim()
  if (note === '') throw new ValidationError('Enter a note.')

  await inTransaction(exec, async (tx) => {
    await getItem(tx, id)
    await tx.update(items).set({ updatedAt: new Date() }).where(eq(items.id, id))
    await logEvent(tx, actor, id, 'note', { text: note })
  })
}

// ─── taking a step back ──────────────────────────────────────────────────────

/* What undoing an accepted proposal needs (lib/processing/proposals.ts). They
   live here so every write to items and item_events stays in this file. */

/**
 * Remove an item that was made by mistake, as long as nothing has happened to
 * it since: its history is exactly `made`, nothing came out of it and it is on
 * no agenda. Otherwise it is refused, because the item has a life of its own
 * by now. A row that is already gone is not an error.
 */
export async function takeBackItem(
  exec: Executor,
  id: string,
  made: ItemEventType[],
): Promise<void> {
  await inTransaction(exec, async (tx) => {
    const [row] = await tx.select().from(items).where(eq(items.id, id)).for('update').limit(1)
    if (!row) return

    const events = await tx
      .select({ type: itemEvents.type })
      .from(itemEvents)
      .where(eq(itemEvents.itemId, id))
    const happened = events.map((event) => event.type).sort()
    if (happened.join() !== [...made].sort().join()) {
      throw new ValidationError(
        'This item has changed since it was accepted. Change it from its own page instead.',
      )
    }

    const [child] = await tx
      .select({ id: items.id })
      .from(items)
      .where(sql`${items.parentItemId} = ${id} or ${items.supersededByItemId} = ${id}`)
      .limit(1)
    if (child) {
      throw new ValidationError('Something has come out of this item since it was accepted.')
    }

    const [placed] = await tx
      .select({ id: agendaLines.id })
      .from(agendaLines)
      .where(eq(agendaLines.itemId, id))
      .limit(1)
    if (placed) {
      throw new ValidationError('This item is on an agenda. Take it off before undoing.')
    }

    if (row.parentItemId) {
      // The parent's history said it spawned this; it no longer did.
      await tx
        .delete(itemEvents)
        .where(
          and(
            eq(itemEvents.itemId, row.parentItemId),
            eq(itemEvents.type, 'spawned'),
            sql`${itemEvents.data}->>'itemId' = ${id}`,
          ),
        )
    }
    await tx.delete(items).where(eq(items.id, id))
  })
}

/** Take one entry (a note, a "discussed") back out of an item's history. */
export async function removeItemEvent(exec: Executor, itemId: string, eventId: string): Promise<void> {
  await exec
    .delete(itemEvents)
    .where(and(eq(itemEvents.id, eventId), eq(itemEvents.itemId, itemId)))
}

/**
 * Put a reopened item back exactly as it stood before it was closed, when that
 * was not simply "open" (a question waiting on its answer, say). `reopenItem`
 * has already written the history.
 */
export async function restoreItemState(
  exec: Executor,
  id: string,
  before: { status: ItemStatus; resolution: string | null; closedAt: Date | null },
): Promise<ItemView> {
  await exec
    .update(items)
    .set({ ...before, updatedAt: new Date() })
    .where(eq(items.id, id))
  return getItem(exec, id)
}
