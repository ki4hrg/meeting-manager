/*
 * Archive, then delete (docs/SPEC.md, item 9).
 *
 * An extra step is cheap and an accidental delete is expensive, so every kind
 * goes the same way:
 *
 *   - Archive sets `archived_at`. The row leaves every list, picker and name
 *     lookup (lib/db/shelf.ts), but what points at it still reads it.
 *   - Delete is offered only on an archived row, and refuses while something
 *     still depends on it, naming what. It sets `deleted_at`: the row is gone
 *     from every screen and query, Restore on Settings brings it back, and the
 *     purge job removes it for good 30 days later (`purgeExpired`).
 *
 * An item's done or dropped is its archive step. Milestones, links and
 * documents are small enough to have no archive step: deleted directly, they
 * can still be restored for 30 days.
 */

import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { NotFoundError, ValidationError, inTransaction, type Executor } from '../core/types'
import {
  bindings,
  contexts,
  documents,
  groups,
  itemParties,
  items,
  meetingPeople,
  meetingProjects,
  meetings,
  milestones,
  people,
  projectLinks,
  projects,
  series,
  seriesPeople,
} from '../db/schema'
import { notDeleted, onShelf } from '../db/shelf'
import { recheckHeldNotes } from '../notes/notes'
import { OPEN_STATUSES } from '../items/items'

/** What can be archived, then deleted. */
export type ArchiveKind = 'context' | 'person' | 'group' | 'project' | 'series' | 'meeting'

/** What can sit in the Deleted list: the archivable kinds, and those deleted directly. */
export type DeletedKind = ArchiveKind | 'item' | 'milestone' | 'link' | 'document'

/** How long a deleted row is kept for Restore. */
export const KEEP_DAYS = 30

const TABLES = {
  context: contexts,
  person: people,
  group: groups,
  project: projects,
  series,
  meeting: meetings,
} as const

const LABEL: Record<DeletedKind, string> = {
  context: 'Context',
  person: 'Person',
  group: 'Group',
  project: 'Project',
  series: 'Series',
  meeting: 'Meeting',
  item: 'Item',
  milestone: 'Milestone',
  link: 'Link',
  document: 'Document',
}

type Shelved = { id: string; archivedAt: Date | null; deletedAt: Date | null }

async function shelvedRow(exec: Executor, kind: ArchiveKind, id: string): Promise<Shelved> {
  const table = TABLES[kind]
  const [row] = await exec
    .select({ id: table.id, archivedAt: table.archivedAt, deletedAt: table.deletedAt })
    .from(table)
    .where(eq(table.id, id))
    .limit(1)
  if (!row || row.deletedAt) throw new NotFoundError(LABEL[kind], id)
  return row
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

async function count(query: Promise<Array<{ n: number }>>): Promise<number> {
  return (await query)[0]?.n ?? 0
}

const N = sql<number>`count(*)::int`

/* A meeting still to come: not over, or undated. Mirrors `isOver`. */
const NOT_OVER = sql`(${meetings.startsAt} is null or coalesce(${meetings.endsAt}, ${meetings.startsAt} + interval '60 minutes') >= now())`

// ─── archive ─────────────────────────────────────────────────────────────────

export async function archive(exec: Executor, kind: ArchiveKind, id: string): Promise<void> {
  await inTransaction(exec, async (tx) => {
    const row = await shelvedRow(tx, kind, id)
    if (row.archivedAt) return

    if (kind === 'person') {
      const [self] = await tx.select({ isSelf: people.isSelf }).from(people).where(eq(people.id, id))
      if (self?.isSelf) throw new ValidationError('You cannot archive yourself.')
    }
    if (kind === 'context') {
      const [others] = await tx
        .select({ n: N })
        .from(contexts)
        .where(and(onShelf(contexts), sql`${contexts.id} <> ${id}`))
      if (!others?.n) throw new ValidationError('This is the only context. Make another before archiving it.')
    }

    const table = TABLES[kind]
    await tx.update(table).set({ archivedAt: new Date() }).where(eq(table.id, id))
  })
}

export async function unarchive(exec: Executor, kind: ArchiveKind, id: string): Promise<void> {
  await shelvedRow(exec, kind, id)
  const table = TABLES[kind]
  await exec.update(table).set({ archivedAt: null }).where(eq(table.id, id))
  // Its Granola folders wake: what they held for the Inbox is filed on the next pass.
  if (kind === 'context') await recheckHeldNotes(exec)
}

// ─── what a delete would take, and what stops it ─────────────────────────────

export type DeletePreview = {
  /** Why it cannot go yet, each naming what depends on it. Empty when it can. */
  blockers: string[]
  /** What goes with it, for the confirm. */
  takes: string[]
}

export async function previewDelete(exec: Executor, kind: ArchiveKind, id: string): Promise<DeletePreview> {
  const blockers: string[] = []
  const takes: string[] = []

  if (kind === 'person') {
    const openItems = await count(
      exec
        .select({ n: N })
        .from(itemParties)
        .innerJoin(items, eq(items.id, itemParties.itemId))
        .where(and(eq(itemParties.personId, id), inArray(items.status, OPEN_STATUSES), notDeleted(items))),
    )
    if (openItems) blockers.push(`On ${plural(openItems, 'open item')}`)
    const rosters = await exec
      .select({ name: series.name })
      .from(seriesPeople)
      .innerJoin(series, eq(series.id, seriesPeople.seriesId))
      .where(and(eq(seriesPeople.personId, id), notDeleted(series)))
    for (const one of rosters) blockers.push(`On the ${one.name} roster`)
    const upcoming = await count(
      exec
        .select({ n: N })
        .from(meetingPeople)
        .innerJoin(meetings, eq(meetings.id, meetingPeople.meetingId))
        .where(and(eq(meetingPeople.personId, id), notDeleted(meetings), NOT_OVER)),
    )
    if (upcoming) blockers.push(`At ${plural(upcoming, 'meeting')} still to come`)
    const closed = await count(
      exec.select({ n: N }).from(itemParties).where(eq(itemParties.personId, id)),
    )
    if (closed && !openItems) takes.push(`Their name on ${plural(closed, 'closed item')}`)
  }

  if (kind === 'group') {
    const openItems = await count(
      exec
        .select({ n: N })
        .from(itemParties)
        .innerJoin(items, eq(items.id, itemParties.itemId))
        .where(and(eq(itemParties.groupId, id), inArray(items.status, OPEN_STATUSES), notDeleted(items))),
    )
    if (openItems) blockers.push(`On ${plural(openItems, 'open item')}`)
    const onSeries = await exec
      .select({ name: series.name })
      .from(series)
      .where(and(eq(series.groupId, id), notDeleted(series)))
    for (const one of onSeries) blockers.push(`The group of ${one.name}`)
    const upcoming = await count(
      exec.select({ n: N }).from(meetings).where(and(eq(meetings.groupId, id), notDeleted(meetings), NOT_OVER)),
    )
    if (upcoming) blockers.push(`The group of ${plural(upcoming, 'meeting')} still to come`)
  }

  if (kind === 'project') {
    const children = await exec
      .select({ name: projects.name })
      .from(projects)
      .where(and(eq(projects.parentId, id), notDeleted(projects)))
    for (const one of children) blockers.push(`${one.name} sits within it`)
    const withMeetings = await count(
      exec
        .select({ n: N })
        .from(meetingProjects)
        .innerJoin(meetings, eq(meetings.id, meetingProjects.meetingId))
        .where(and(eq(meetingProjects.projectId, id), notDeleted(meetings))),
    )
    if (withMeetings) blockers.push(`On ${plural(withMeetings, 'meeting')}`)
    const openItems = await count(
      exec
        .select({ n: N })
        .from(items)
        .where(and(eq(items.projectId, id), inArray(items.status, OPEN_STATUSES), notDeleted(items))),
    )
    if (openItems) blockers.push(`${plural(openItems, 'open item')}`)
    const folders = await count(
      exec.select({ n: N }).from(bindings).where(eq(bindings.projectId, id)),
    )
    if (folders) blockers.push(`Bound to ${plural(folders, 'Granola folder')}`)
    const closed = await count(
      exec.select({ n: N }).from(items).where(and(eq(items.projectId, id), notDeleted(items))),
    )
    if (closed && !openItems) takes.push(`The project on ${plural(closed, 'closed item')}`)
    const docs = await count(
      exec.select({ n: N }).from(documents).where(and(eq(documents.projectId, id), notDeleted(documents))),
    )
    if (docs) takes.push(`The project on ${plural(docs, 'document')}`)
  }

  if (kind === 'series') {
    const upcoming = await count(
      exec.select({ n: N }).from(meetings).where(and(eq(meetings.seriesId, id), notDeleted(meetings), NOT_OVER)),
    )
    if (upcoming) blockers.push(`${plural(upcoming, 'meeting')} still to come`)
    const past = await count(
      exec.select({ n: N }).from(meetings).where(and(eq(meetings.seriesId, id), notDeleted(meetings))),
    )
    if (past && !upcoming) takes.push(`The series on ${plural(past, 'past meeting')}, which stay`)
  }

  if (kind === 'meeting') {
    const sessions = await exec
      .select({ id: meetings.id })
      .from(meetings)
      .where(eq(meetings.parentMeetingId, id))
    const ids = [id, ...sessions.map((one) => one.id)]
    const cameOut = await count(
      exec.select({ n: N }).from(items).where(and(inArray(items.originMeetingId, ids), notDeleted(items))),
    )
    if (cameOut) blockers.push(`${plural(cameOut, 'item')} came out of it`)
    const docs = await count(
      exec.select({ n: N }).from(documents).where(and(inArray(documents.meetingId, ids), notDeleted(documents))),
    )
    if (docs) blockers.push(`${plural(docs, 'document')} came out of it`)
    if (sessions.length) takes.push(plural(sessions.length, 'session'))
    takes.push('Its agenda and notes')
  }

  if (kind === 'context') {
    const tally = async (table: typeof items | typeof meetings | typeof projects | typeof groups | typeof series, one: string, many?: string) => {
      const n = await count(
        exec.select({ n: N }).from(table).where(and(eq(table.contextId, id), notDeleted(table))),
      )
      if (n) takes.push(plural(n, one, many))
    }
    await tally(items, 'item')
    await tally(meetings, 'meeting')
    await tally(series, 'series', 'series')
    await tally(projects, 'project')
    await tally(groups, 'group')
    const bound = await count(exec.select({ n: N }).from(bindings).where(eq(bindings.contextId, id)))
    if (bound) takes.push(`${plural(bound, 'binding')} (the calendars and folders stay)`)
  }

  return { blockers, takes }
}

// ─── delete and restore ──────────────────────────────────────────────────────

/** Delete an archived row: gone from every screen, restorable for 30 days. */
export async function softDelete(exec: Executor, kind: ArchiveKind, id: string): Promise<void> {
  await inTransaction(exec, async (tx) => {
    const row = await shelvedRow(tx, kind, id)
    if (!row.archivedAt) throw new ValidationError('Archive it first.')
    const { blockers } = await previewDelete(tx, kind, id)
    if (blockers.length > 0) throw new ValidationError(`It cannot go yet: ${blockers.join('; ')}.`)

    const now = new Date()
    if (kind === 'meeting') {
      /* Its calendar event is let go, so the event can be prepped afresh. */
      await tx
        .update(meetings)
        .set({ deletedAt: now, calendarId: null, calendarEventId: null })
        .where(or(eq(meetings.id, id), eq(meetings.parentMeetingId, id)))
      return
    }
    if (kind === 'series') {
      await tx.update(series).set({ deletedAt: now, calendarSeriesId: null }).where(eq(series.id, id))
      return
    }
    const table = TABLES[kind]
    await tx.update(table).set({ deletedAt: now }).where(eq(table.id, id))
  })
}

const DIRECT = { item: items, milestone: milestones, link: projectLinks, document: documents } as const

export async function restoreDeleted(exec: Executor, kind: DeletedKind, id: string): Promise<void> {
  if (kind === 'meeting') {
    await exec
      .update(meetings)
      .set({ deletedAt: null })
      .where(and(or(eq(meetings.id, id), eq(meetings.parentMeetingId, id)), isNotNull(meetings.deletedAt)))
    return
  }
  const table = kind in DIRECT ? DIRECT[kind as keyof typeof DIRECT] : TABLES[kind as ArchiveKind]
  await exec.update(table).set({ deletedAt: null }).where(eq(table.id, id))
}

// ─── the Deleted list ────────────────────────────────────────────────────────

export type DeletedRow = {
  kind: DeletedKind
  id: string
  name: string
  deletedAt: Date
  /** Where it lived, for the kinds that have a context. */
  context: string | null
}

export async function listDeleted(exec: Executor): Promise<DeletedRow[]> {
  const contextNames = new Map(
    (await exec.select({ id: contexts.id, name: contexts.name }).from(contexts)).map((row) => [row.id, row.name]),
  )
  const rows: DeletedRow[] = []
  const add = (kind: DeletedKind, list: Array<{ id: string; name: string; deletedAt: Date | null; contextId?: string | null }>) => {
    for (const row of list) {
      rows.push({
        kind,
        id: row.id,
        name: row.name,
        deletedAt: row.deletedAt!,
        context: row.contextId ? (contextNames.get(row.contextId) ?? null) : null,
      })
    }
  }

  add(
    'context',
    await exec.select({ id: contexts.id, name: contexts.name, deletedAt: contexts.deletedAt }).from(contexts).where(isNotNull(contexts.deletedAt)),
  )
  add(
    'person',
    await exec.select({ id: people.id, name: people.name, deletedAt: people.deletedAt }).from(people).where(isNotNull(people.deletedAt)),
  )
  add(
    'group',
    await exec
      .select({ id: groups.id, name: groups.name, deletedAt: groups.deletedAt, contextId: groups.contextId })
      .from(groups)
      .where(isNotNull(groups.deletedAt)),
  )
  add(
    'project',
    await exec
      .select({ id: projects.id, name: projects.name, deletedAt: projects.deletedAt, contextId: projects.contextId })
      .from(projects)
      .where(isNotNull(projects.deletedAt)),
  )
  add(
    'series',
    await exec
      .select({ id: series.id, name: series.name, deletedAt: series.deletedAt, contextId: series.contextId })
      .from(series)
      .where(isNotNull(series.deletedAt)),
  )
  // A meeting's sessions go and come back with it, so only the meeting is listed.
  add(
    'meeting',
    await exec
      .select({ id: meetings.id, name: meetings.title, deletedAt: meetings.deletedAt, contextId: meetings.contextId })
      .from(meetings)
      .where(and(isNotNull(meetings.deletedAt), isNull(meetings.parentMeetingId))),
  )
  add(
    'item',
    await exec
      .select({ id: items.id, name: items.text, deletedAt: items.deletedAt, contextId: items.contextId })
      .from(items)
      .where(isNotNull(items.deletedAt)),
  )
  add(
    'milestone',
    await exec
      .select({ id: milestones.id, name: milestones.title, deletedAt: milestones.deletedAt, contextId: projects.contextId })
      .from(milestones)
      .innerJoin(projects, eq(projects.id, milestones.projectId))
      .where(isNotNull(milestones.deletedAt)),
  )
  add(
    'link',
    await exec
      .select({ id: projectLinks.id, name: projectLinks.label, deletedAt: projectLinks.deletedAt, contextId: projects.contextId })
      .from(projectLinks)
      .innerJoin(projects, eq(projects.id, projectLinks.projectId))
      .where(isNotNull(projectLinks.deletedAt)),
  )
  add(
    'document',
    await exec
      .select({ id: documents.id, name: documents.title, deletedAt: documents.deletedAt, contextId: documents.contextId })
      .from(documents)
      .where(isNotNull(documents.deletedAt)),
  )

  return rows.sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime())
}

// ─── for good ────────────────────────────────────────────────────────────────

/**
 * Remove a deleted row for good, with what only it held. Done by the purge
 * job after `KEEP_DAYS`, or at once from the Deleted list.
 */
export async function purge(exec: Executor, kind: DeletedKind, id: string): Promise<void> {
  await inTransaction(exec, async (tx) => {
    switch (kind) {
      case 'item':
        await tx.delete(items).where(and(eq(items.id, id), isNotNull(items.deletedAt)))
        return
      case 'milestone':
        await tx.delete(milestones).where(and(eq(milestones.id, id), isNotNull(milestones.deletedAt)))
        return
      case 'link':
        await tx.delete(projectLinks).where(and(eq(projectLinks.id, id), isNotNull(projectLinks.deletedAt)))
        return
      case 'document':
        await tx.delete(documents).where(and(eq(documents.id, id), isNotNull(documents.deletedAt)))
        return
    }

    const table = TABLES[kind]
    const [row] = await tx.select({ deletedAt: table.deletedAt }).from(table).where(eq(table.id, id))
    if (!row?.deletedAt) return

    switch (kind) {
      case 'person':
        // Its name comes off the closed items it was on.
        await tx.delete(itemParties).where(eq(itemParties.personId, id))
        await tx.delete(people).where(eq(people.id, id))
        return
      case 'group':
        await tx.delete(itemParties).where(eq(itemParties.groupId, id))
        await tx.delete(groups).where(eq(groups.id, id))
        return
      case 'project':
        await tx.delete(projects).where(eq(projects.id, id))
        return
      case 'series':
        await tx.delete(series).where(eq(series.id, id))
        return
      case 'meeting':
        // Its sessions go with it (parent_meeting_id cascades).
        await tx.delete(meetings).where(eq(meetings.id, id))
        return
      case 'context':
        /* Everything in it, in an order the foreign keys allow. Items in one
           statement: a thread's own links are checked at its end. */
        await tx.delete(documents).where(eq(documents.contextId, id))
        await tx.delete(items).where(eq(items.contextId, id))
        await tx.delete(meetings).where(eq(meetings.contextId, id))
        await tx.delete(series).where(eq(series.contextId, id))
        await tx.delete(projects).where(eq(projects.contextId, id))
        await tx.delete(groups).where(eq(groups.contextId, id))
        await tx.delete(contexts).where(eq(contexts.id, id))
        return
    }
  })
}

/** Everything deleted more than `KEEP_DAYS` ago, removed for good. Returns how many. */
export async function purgeExpired(exec: Executor, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - KEEP_DAYS * 86_400_000)
  const expired = (await listDeleted(exec)).filter((row) => row.deletedAt < cutoff)
  /* Smallest first, so a context's own rows are not purged twice over. */
  const order: DeletedKind[] = ['item', 'milestone', 'link', 'document', 'meeting', 'series', 'project', 'group', 'person', 'context']
  expired.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
  for (const row of expired) await purge(exec, row.kind, row.id)
  return expired.length
}

/** When a deleted row goes for good. */
export function purgeOn(deletedAt: Date): Date {
  return new Date(deletedAt.getTime() + KEEP_DAYS * 86_400_000)
}

