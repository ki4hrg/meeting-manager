/* Series: recurring meetings with their roster, defaults and skeleton. */

import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { NotFoundError, ValidationError, inTransaction, type ActorContext, type Executor } from '../core/types'
import { groups, people, projects, series, seriesGroups, seriesPeople, seriesProjects } from '../db/schema'
import type { BlockSettings, SkeletonSection } from '../db/schema'
import { parseOutline, type OutlineItem } from '../agenda/outline'
import { notDeleted, onShelf, shelvedNote, type Shelf } from '../db/shelf'
import { getContext } from '../directory/contexts'
import { carryRoster, rosterOf } from './roster'

/* A roster change reaches the series' meetings as the series' own doing. */
const SERIES_ACTOR: ActorContext = { userId: null, source: 'system', requestId: 'series-roster' }

export type SeriesView = {
  id: string
  contextId: string
  name: string
  /** Groups on its roster: each carries to every meeting. */
  groups: { id: string; name: string }[]
  calendarSeriesId: string | null
  skeleton: SkeletonSection[]
  blocks: BlockSettings
  people: { id: string; name: string }[]
  projects: { id: string; name: string }[]
  archivedAt: Date | null
}

// ─── reading ─────────────────────────────────────────────────────────────────

async function loadViews(exec: Executor, where: SQL | undefined): Promise<SeriesView[]> {
  const query = exec
    .select({ series: series })
    .from(series)
    .where(where)
    .orderBy(sql`lower(${series.name})`)

  const rows = await query
  if (rows.length === 0) return []

  const seriesIds = rows.map((row) => row.series.id)

  const peopleRows = await exec
    .select({
      seriesId: seriesPeople.seriesId,
      personId: people.id,
      personName: people.name,
      isSelf: people.isSelf,
    })
    .from(seriesPeople)
    .innerJoin(people, eq(people.id, seriesPeople.personId))
    .where(inArray(seriesPeople.seriesId, seriesIds))
    .orderBy(asc(people.name))

  const groupRows = await exec
    .select({ seriesId: seriesGroups.seriesId, groupId: groups.id, groupName: groups.name })
    .from(seriesGroups)
    .innerJoin(groups, eq(groups.id, seriesGroups.groupId))
    .where(inArray(seriesGroups.seriesId, seriesIds))
    .orderBy(asc(groups.name))

  const projectRows = await exec
    .select({
      seriesId: seriesProjects.seriesId,
      projectId: projects.id,
      projectName: projects.name,
    })
    .from(seriesProjects)
    .innerJoin(projects, eq(projects.id, seriesProjects.projectId))
    .where(inArray(seriesProjects.seriesId, seriesIds))
    .orderBy(asc(projects.name))

  const bySeriesPeople = new Map<string, { id: string; name: string }[]>()
  for (const row of peopleRows) {
    /* John (is_self) is dropped: he's at every meeting */
    if (row.isSelf) continue
    const list = bySeriesPeople.get(row.seriesId) ?? []
    list.push({ id: row.personId, name: row.personName })
    bySeriesPeople.set(row.seriesId, list)
  }

  const bySeriesProjects = new Map<string, { id: string; name: string }[]>()
  for (const row of projectRows) {
    const list = bySeriesProjects.get(row.seriesId) ?? []
    list.push({ id: row.projectId, name: row.projectName })
    bySeriesProjects.set(row.seriesId, list)
  }

  return rows.map(({ series: s }) => ({
    id: s.id,
    contextId: s.contextId,
    name: s.name,
    groups: groupRows.filter((row) => row.seriesId === s.id).map((row) => ({ id: row.groupId, name: row.groupName })),
    calendarSeriesId: s.calendarSeriesId,
    skeleton: s.skeleton,
    blocks: s.blocks,
    people: bySeriesPeople.get(s.id) ?? [],
    projects: bySeriesProjects.get(s.id) ?? [],
    archivedAt: s.archivedAt,
  }))
}

export async function getSeries(exec: Executor, id: string): Promise<SeriesView> {
  const [view] = await loadViews(exec, and(eq(series.id, id), notDeleted(series)))
  if (!view) throw new NotFoundError('Series', id)
  return view
}

export async function listSeries(
  exec: Executor,
  contextId: string,
  shelf: Shelf = 'live',
): Promise<SeriesView[]> {
  await getContext(exec, contextId)
  return loadViews(exec, and(eq(series.contextId, contextId), onShelf(series, shelf)))
}

export async function findSeriesByCalendar(
  exec: Executor,
  calendarSeriesId: string,
): Promise<SeriesView | null> {
  const [view] = await loadViews(exec, and(eq(series.calendarSeriesId, calendarSeriesId), notDeleted(series)))
  return view ?? null
}

// ─── writing ─────────────────────────────────────────────────────────────────

async function assertGroupIn(exec: Executor, groupId: string, contextId: string) {
  const [group] = await exec
    .select({ contextId: groups.contextId })
    .from(groups)
    .where(eq(groups.id, groupId))
    .limit(1)
  if (!group) throw new NotFoundError('Group', groupId)
  if (group.contextId !== contextId) {
    throw new ValidationError('That group belongs to another context.')
  }
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

async function assertNameFree(exec: Executor, contextId: string, name: string, exceptId?: string) {
  const [taken] = await exec
    .select({ id: series.id, archivedAt: series.archivedAt, deletedAt: series.deletedAt })
    .from(series)
    .where(and(eq(series.contextId, contextId), sql`lower(${series.name}) = lower(${name})`))
    .limit(1)
  if (taken && taken.id !== exceptId) {
    throw new ValidationError(`There is already a series called ${name}${shelvedNote(taken)}.`)
  }
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}

const MAX_MINUTES = 24 * 60

/**
 * A skeleton as it is stored: trimmed, with blank lines dropped and minutes
 * either a whole number or absent. What arrives is whatever a form or a tool
 * sent, so nothing about its shape is assumed. A section with no title is
 * refused rather than dropped, because its lines would go with it.
 */
export function cleanSkeleton(input: unknown): SkeletonSection[] {
  if (!Array.isArray(input)) throw new ValidationError('That is not an agenda.')
  return input.map((raw) => {
    const section = (raw ?? {}) as { title?: unknown; lines?: unknown }
    const title = typeof section.title === 'string' ? section.title.trim() : ''
    if (title === '') throw new ValidationError('Name the section.')

    const lines: SkeletonSection['lines'] = []
    for (const rawLine of Array.isArray(section.lines) ? section.lines : []) {
      const line = (rawLine ?? {}) as { text?: unknown; minutes?: unknown }
      const text = typeof line.text === 'string' ? line.text.trim() : ''
      if (text === '') continue

      if (line.minutes === undefined || line.minutes === null || line.minutes === '') {
        lines.push({ text })
        continue
      }
      const minutes = Number(line.minutes)
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) {
        throw new ValidationError('Minutes are a whole number.')
      }
      lines.push({ text, minutes })
    }
    return { title, lines }
  })
}

/**
 * A pasted outline as a skeleton. A heading, or a top-level bullet, is a
 * section; what is under it is its lines, whether those were written as
 * deeper headings, nested bullets, or a bullet list beneath a heading.
 */
export function skeletonFromOutline(source: string): SkeletonSection[] {
  const toLine = (item: OutlineItem) =>
    item.minutes && item.minutes <= MAX_MINUTES
      ? { text: item.title, minutes: item.minutes }
      : { text: item.title }

  const sections: SkeletonSection[] = []
  for (const item of parseOutline(source)) {
    if (item.depth > 0) {
      sections.at(-1)?.lines.push(toLine(item))
      continue
    }
    /* Under a heading the parser leaves bullets in the body, as prose. Here
       they are the section's lines. */
    sections.push({ title: item.title, lines: parseOutline(item.body).map(toLine) })
  }
  return cleanSkeleton(sections)
}

function cleanBlocks(input: BlockSettings): BlockSettings {
  return {
    followUps: input?.followUps === true,
    sinceLast: input?.sinceLast === true,
    lookahead: input?.lookahead === true,
  }
}

export async function createSeries(
  exec: Executor,
  input: {
    contextId: string
    name: string
    /** Its groups; `groupId` is one. */
    groupIds?: string[]
    groupId?: string
    personIds?: string[]
    projectIds?: string[]
    skeleton?: SkeletonSection[]
    blocks?: BlockSettings
    calendarSeriesId?: string
  },
): Promise<SeriesView> {
  const name = input.name.trim()
  if (name === '') throw new ValidationError('Enter a name.')
  await getContext(exec, input.contextId)
  await assertNameFree(exec, input.contextId, name)

  const groupIds = [...new Set([...(input.groupIds ?? []), ...(input.groupId ? [input.groupId] : [])])]
  for (const groupId of groupIds) await assertGroupIn(exec, groupId, input.contextId)
  // A project named twice is one project, not a primary-key violation.
  const projectIds = [...new Set(input.projectIds ?? [])]
  for (const projectId of projectIds) {
    await assertProjectIn(exec, projectId, input.contextId)
  }
  const skeleton = cleanSkeleton(input.skeleton ?? [])
  /* John is silently dropped from people lists */
  let personIds = input.personIds ?? []
  if (personIds.length > 0) {
    const people_ = await exec
      .select({ id: people.id, isSelf: people.isSelf })
      .from(people)
      .where(inArray(people.id, personIds))
    personIds = people_.filter((p) => !p.isSelf).map((p) => p.id)
  }

  if (input.calendarSeriesId) {
    const [taken] = await exec
      .select({ id: series.id })
      .from(series)
      .where(eq(series.calendarSeriesId, input.calendarSeriesId))
      .limit(1)
    if (taken) throw new ValidationError('That calendar event already has a series.')
  }

  const view = await inTransaction(exec, async (tx) => {
    const [row] = await tx
      .insert(series)
      .values({
        contextId: input.contextId,
        name,
        skeleton,
        blocks: cleanBlocks(input.blocks ?? { followUps: false, sinceLast: false, lookahead: false }),
        calendarSeriesId: input.calendarSeriesId ? blankToNull(input.calendarSeriesId) : null,
      })
      .returning()

    if (personIds.length) {
      await tx.insert(seriesPeople).values(
        personIds.map((personId) => ({ seriesId: row!.id, personId })),
      )
    }
    if (projectIds.length) {
      await tx.insert(seriesProjects).values(
        projectIds.map((projectId) => ({ seriesId: row!.id, projectId })),
      )
    }
    if (groupIds.length) {
      await tx.insert(seriesGroups).values(groupIds.map((groupId) => ({ seriesId: row!.id, groupId })))
    }

    return getSeries(tx, row!.id)
  })
  return view
}

export async function updateSeries(
  exec: Executor,
  id: string,
  input: {
    name?: string
    /** Replaces its groups; `groupId` sets one, or none with null. */
    groupIds?: string[]
    groupId?: string | null
    skeleton?: SkeletonSection[]
    blocks?: BlockSettings
    calendarSeriesId?: string | null
  },
): Promise<SeriesView> {
  const view = await getSeries(exec, id)

  const groupIds =
    input.groupIds !== undefined
      ? [...new Set(input.groupIds)]
      : input.groupId !== undefined
        ? input.groupId
          ? [input.groupId]
          : []
        : undefined
  for (const groupId of groupIds ?? []) await assertGroupIn(exec, groupId, view.contextId)
  if (input.calendarSeriesId !== undefined && input.calendarSeriesId !== null) {
    const [taken] = await exec
      .select({ id: series.id })
      .from(series)
      .where(
        and(
          eq(series.calendarSeriesId, input.calendarSeriesId),
          sql`${series.id} != ${id}`,
        ),
      )
      .limit(1)
    if (taken) throw new ValidationError('That calendar event already has a series.')
  }

  const patch: Partial<typeof series.$inferInsert> = {}

  if (input.name !== undefined) {
    const name = input.name.trim()
    if (name === '') throw new ValidationError('Enter a name.')
    await assertNameFree(exec, view.contextId, name, id)
    patch.name = name
  }
  if (input.skeleton !== undefined) patch.skeleton = cleanSkeleton(input.skeleton)
  if (input.blocks !== undefined) patch.blocks = cleanBlocks(input.blocks)
  if (input.calendarSeriesId !== undefined) {
    patch.calendarSeriesId = input.calendarSeriesId
      ? blankToNull(input.calendarSeriesId)
      : null
  }

  return inTransaction(exec, async (tx) => {
    await tx
      .update(series)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(series.id, id))
    if (groupIds !== undefined) {
      await tx.delete(seriesGroups).where(eq(seriesGroups.seriesId, id))
      if (groupIds.length > 0) {
        await tx.insert(seriesGroups).values(groupIds.map((groupId) => ({ seriesId: id, groupId })))
      }
      await carryRoster(tx, SERIES_ACTOR, id, rosterOf(view))
    }
    return getSeries(tx, id)
  })
}

export async function setSeriesPeople(
  exec: Executor,
  id: string,
  personIds: string[],
): Promise<SeriesView> {
  const before = rosterOf(await getSeries(exec, id))

  /* John is silently dropped from people lists */
  let filtered = personIds
  if (filtered.length > 0) {
    const people_ = await exec
      .select({ id: people.id, isSelf: people.isSelf })
      .from(people)
      .where(inArray(people.id, filtered))
    filtered = people_.filter((p) => !p.isSelf).map((p) => p.id)
  }

  return inTransaction(exec, async (tx) => {
    await tx.delete(seriesPeople).where(eq(seriesPeople.seriesId, id))
    if (filtered.length > 0) {
      await tx.insert(seriesPeople).values(
        filtered.map((personId) => ({ seriesId: id, personId })),
      )
    }
    await carryRoster(tx, SERIES_ACTOR, id, before)
    return getSeries(tx, id)
  })
}

export async function setSeriesProjects(
  exec: Executor,
  id: string,
  projectIds: string[],
): Promise<SeriesView> {
  const view = await getSeries(exec, id)

  projectIds = [...new Set(projectIds)]
  for (const projectId of projectIds) {
    await assertProjectIn(exec, projectId, view.contextId)
  }

  return inTransaction(exec, async (tx) => {
    await tx.delete(seriesProjects).where(eq(seriesProjects.seriesId, id))
    if (projectIds.length > 0) {
      await tx.insert(seriesProjects).values(
        projectIds.map((projectId) => ({ seriesId: id, projectId })),
      )
    }
    await carryRoster(tx, SERIES_ACTOR, id, rosterOf(view))
    return getSeries(tx, id)
  })
}

/** Gone at once. What a person removes is archived, then deleted (lib/archive). */
export async function deleteSeries(exec: Executor, id: string): Promise<void> {
  await getSeries(exec, id)
  await exec.delete(series).where(eq(series.id, id))
}
