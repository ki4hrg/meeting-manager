/* Projects, with their milestones and links. Each belongs to one context. */

import { and, asc, eq, gte, inArray, or, sql } from 'drizzle-orm'
import { parseDay } from '../core/dates'
import { NotFoundError, ValidationError, inTransaction, type Executor } from '../core/types'
import {
  bindings,
  documents,
  items,
  meetingProjects,
  milestones,
  projectLinks,
  projects,
  seriesProjects,
} from '../db/schema'
import { notDeleted, onShelf, shelvedNote, type Shelf } from '../db/shelf'
import { getContext } from '../directory/contexts'

export type Project = typeof projects.$inferSelect
export type ProjectStatus = Project['status']
export type Milestone = typeof milestones.$inferSelect
export type ProjectLink = typeof projectLinks.$inferSelect

/* Pending will happen but has not started; proposed has not been agreed to at
   all, so nothing of it is offered on an agenda (`unconfirmedIds`). */
export const PROJECT_STATUSES: ProjectStatus[] = ['active', 'pending', 'proposed', 'paused', 'done']

/** A context's projects; `all` for the tree itself, which still reads archived ones. */
export async function listProjects(exec: Executor, contextId: string, shelf: Shelf = 'live'): Promise<Project[]> {
  return exec
    .select()
    .from(projects)
    .where(and(eq(projects.contextId, contextId), onShelf(projects, shelf)))
    // Active first, finished last.
    .orderBy(projects.status, sql`lower(${projects.name})`)
}

export async function getProject(exec: Executor, id: string): Promise<Project> {
  const [row] = await exec
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), notDeleted(projects)))
    .limit(1)
  if (!row) throw new NotFoundError('Project', id)
  return row
}

async function assertNameFree(exec: Executor, contextId: string, name: string, exceptId?: string) {
  const [taken] = await exec
    .select({ id: projects.id, archivedAt: projects.archivedAt, deletedAt: projects.deletedAt })
    .from(projects)
    .where(and(eq(projects.contextId, contextId), sql`lower(${projects.name}) = lower(${name})`))
    .limit(1)
  if (taken && taken.id !== exceptId) {
    throw new ValidationError(`There is already a project called ${name}${shelvedNote(taken)}.`)
  }
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}

/* A parent must be in the same context and must not be the project or one of its own sub-projects. */
async function assertParent(exec: Executor, contextId: string, parentId: string, childId?: string) {
  const parent = await getProject(exec, parentId)
  if (parent.contextId !== contextId) throw new ValidationError('That project belongs to another context.')
  if (!childId) return
  const all = await listProjects(exec, contextId, 'all')
  if (parentId === childId || descendantIds(all, [childId]).has(parentId)) {
    throw new ValidationError('A project cannot sit inside itself.')
  }
}

export async function createProject(
  exec: Executor,
  input: {
    contextId: string
    name: string
    description?: string | null
    parentId?: string | null
    status?: ProjectStatus
  },
): Promise<Project> {
  const name = input.name.trim()
  if (name === '') throw new ValidationError('Enter a name.')
  await getContext(exec, input.contextId)
  await assertNameFree(exec, input.contextId, name)
  if (input.parentId) await assertParent(exec, input.contextId, input.parentId)

  const [row] = await exec
    .insert(projects)
    .values({
      contextId: input.contextId,
      name,
      description: blankToNull(input.description),
      parentId: input.parentId || null,
      ...(input.status ? { status: input.status } : {}),
    })
    .returning()
  return row!
}

export async function updateProject(
  exec: Executor,
  id: string,
  input: {
    name?: string
    description?: string | null
    status?: ProjectStatus
    parentId?: string | null
    /** The new status goes to its sub-projects too, at any depth (archived ones aside). */
    subProjects?: boolean
  },
): Promise<Project> {
  return inTransaction(exec, (tx) => applyUpdate(tx, id, input))
}

async function applyUpdate(
  exec: Executor,
  id: string,
  input: Parameters<typeof updateProject>[2],
): Promise<Project> {
  const project = await getProject(exec, id)
  const patch: Partial<typeof projects.$inferInsert> = {}

  if (input.parentId !== undefined) {
    if (input.parentId) await assertParent(exec, project.contextId, input.parentId, id)
    patch.parentId = input.parentId || null
  }

  if (input.name !== undefined) {
    const name = input.name.trim()
    if (name === '') throw new ValidationError('Enter a name.')
    await assertNameFree(exec, project.contextId, name, id)
    patch.name = name
  }
  if (input.description !== undefined) patch.description = blankToNull(input.description)
  if (input.status !== undefined) {
    if (!PROJECT_STATUSES.includes(input.status)) {
      throw new ValidationError(`${input.status} is not a project status.`)
    }
    patch.status = input.status
  }

  const [row] = await exec
    .update(projects)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(projects.id, id))
    .returning()

  if (input.subProjects && patch.status) {
    const below = [...descendantIds(await listProjects(exec, project.contextId), [id])]
    if (below.length > 0) {
      await exec
        .update(projects)
        .set({ status: patch.status, updatedAt: new Date() })
        .where(inArray(projects.id, below))
    }
  }
  return row!
}

// ─── the tree ────────────────────────────────────────────────────────────────

/** Every project under these, at any depth, not counting them. */
export function descendantIds(all: Pick<Project, 'id' | 'parentId'>[], ids: Iterable<string>): Set<string> {
  const found = new Set<string>()
  let frontier = [...ids]
  while (frontier.length > 0) {
    const next = all.filter((one) => one.parentId && frontier.includes(one.parentId) && !found.has(one.id))
    for (const one of next) found.add(one.id)
    frontier = next.map((one) => one.id)
  }
  return found
}

/**
 * The projects not yet agreed to: each proposed one and everything within it.
 * Their items are no agenda's to offer until the project is confirmed, except
 * at a meeting that carries the proposed project or one within it (`carried`:
 * the meeting's projects and every one above them), which is about it.
 */
export function unconfirmedIds(
  all: Pick<Project, 'id' | 'parentId' | 'status'>[],
  carried: Set<string> = new Set(),
): Set<string> {
  const byId = new Map(all.map((one) => [one.id, one]))
  const found = new Set<string>()
  for (const one of all) {
    let at: (typeof all)[number] | undefined = one
    for (let depth = 0; at && depth < 100; depth++) {
      if (at.status === 'proposed' && !carried.has(at.id)) {
        found.add(one.id)
        break
      }
      at = at.parentId ? byId.get(at.parentId) : undefined
    }
  }
  return found
}

/**
 * These projects, every one above them and every one within them, as the
 * generated blocks read a meeting's projects. A proposed project within them
 * is left out, and what is within it: it is not theirs until agreed to
 * (`unconfirmedIds`).
 */
export function projectLine(
  all: Pick<Project, 'id' | 'parentId' | 'status'>[],
  own: string[],
): Set<string> {
  const above = ancestorIds(all, own)
  const unconfirmed = unconfirmedIds(all, new Set([...own, ...above]))
  const below = [...descendantIds(all, own)].filter((id) => !unconfirmed.has(id))
  return new Set([...own, ...above, ...below])
}

/** Every project above these, up to the top, not counting them. */
export function ancestorIds(all: Pick<Project, 'id' | 'parentId'>[], ids: Iterable<string>): Set<string> {
  const byId = new Map(all.map((one) => [one.id, one]))
  const found = new Set<string>()
  for (const id of ids) {
    let parent = byId.get(id)?.parentId ?? null
    while (parent && !found.has(parent)) {
      found.add(parent)
      parent = byId.get(parent)?.parentId ?? null
    }
  }
  return found
}

/**
 * Remove a project for good, but only while nothing has been put on it: no
 * item, milestone, link, document, meeting, series, sub-project or binding.
 * Undoing what made it uses this; once it holds anything, it is archived instead.
 */
export async function deleteEmptyProject(exec: Executor, id: string): Promise<void> {
  const holds = await Promise.all([
    exec.select({ id: items.id }).from(items).where(or(eq(items.projectId, id), eq(items.targetProjectId, id))).limit(1),
    exec.select({ id: milestones.id }).from(milestones).where(eq(milestones.projectId, id)).limit(1),
    exec.select({ id: projectLinks.id }).from(projectLinks).where(eq(projectLinks.projectId, id)).limit(1),
    exec.select({ id: documents.id }).from(documents).where(eq(documents.projectId, id)).limit(1),
    exec.select({ id: meetingProjects.meetingId }).from(meetingProjects).where(eq(meetingProjects.projectId, id)).limit(1),
    exec.select({ id: seriesProjects.seriesId }).from(seriesProjects).where(eq(seriesProjects.projectId, id)).limit(1),
    exec.select({ id: projects.id }).from(projects).where(eq(projects.parentId, id)).limit(1),
    exec.select({ id: bindings.id }).from(bindings).where(eq(bindings.projectId, id)).limit(1),
  ])
  if (holds.some((rows) => rows.length > 0)) {
    throw new ValidationError('The project has things on it now. Archive it instead.')
  }
  await exec.delete(projects).where(eq(projects.id, id))
}

/** A context's projects in tree order, each with how deep it sits: for pickers that show the tree indented. */
export function treeOrder<T extends Pick<Project, 'id' | 'parentId' | 'name'>>(all: T[]): Array<T & { depth: number }> {
  const ids = new Set(all.map((one) => one.id))
  const out: Array<T & { depth: number }> = []
  const walk = (parentId: string | null, depth: number) => {
    const children = all
      .filter((one) => (parentId === null ? !one.parentId || !ids.has(one.parentId) : one.parentId === parentId))
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const child of children) {
      out.push({ ...child, depth })
      walk(child.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

export type ProjectNode<T> = T & { depth: number; archived: boolean; children: Array<ProjectNode<T>> }

/**
 * The live projects as a forest, siblings in `treeOrder`. An archived project
 * comes along only above a live one, so a live sub-project keeps its parent.
 */
export function projectTree<T extends Pick<Project, 'id' | 'parentId' | 'name'>>(
  live: T[],
  archived: T[] = [],
): Array<ProjectNode<T>> {
  const above = ancestorIds([...live, ...archived], live.map((one) => one.id))
  const shelved = new Set(archived.filter((one) => above.has(one.id)).map((one) => one.id))
  const rows = [...live, ...archived.filter((one) => shelved.has(one.id))]
  const roots: Array<ProjectNode<T>> = []
  const path: Array<ProjectNode<T>> = []
  for (const row of treeOrder(rows)) {
    const node: ProjectNode<T> = { ...row, archived: shelved.has(row.id), children: [] }
    path.length = row.depth
    if (row.depth === 0) roots.push(node)
    else path[row.depth - 1]!.children.push(node)
    path.push(node)
  }
  return roots
}

/** A project's name indented by its depth, for an <option>. */
export function indented(project: { name: string; depth: number }): string {
  return `${'\u00a0\u00a0\u00a0'.repeat(project.depth)}${project.name}`
}

// ─── milestones ──────────────────────────────────────────────────────────────

export async function listMilestones(exec: Executor, projectId: string): Promise<Milestone[]> {
  return exec
    .select()
    .from(milestones)
    .where(and(eq(milestones.projectId, projectId), notDeleted(milestones)))
    .orderBy(sql`${milestones.dueOn} asc nulls last`, asc(milestones.createdAt))
}

/** The next milestone of each project in a context, from `today` (the user's day) on. */
export async function nextMilestones(
  exec: Executor,
  contextId: string,
  today: string,
): Promise<Map<string, Milestone>> {
  const rows = await exec
    .select({ milestone: milestones })
    .from(milestones)
    .innerJoin(projects, eq(projects.id, milestones.projectId))
    .where(
      and(
        eq(projects.contextId, contextId),
        gte(milestones.dueOn, today),
        notDeleted(milestones),
      ),
    )
    .orderBy(asc(milestones.dueOn))

  const next = new Map<string, Milestone>()
  for (const { milestone } of rows) {
    if (!next.has(milestone.projectId)) next.set(milestone.projectId, milestone)
  }
  return next
}

export async function addMilestone(
  exec: Executor,
  input: { projectId: string; title: string; dueOn?: string | null },
): Promise<Milestone> {
  const title = input.title.trim()
  if (title === '') throw new ValidationError('Enter a title.')
  await getProject(exec, input.projectId)

  const [row] = await exec
    .insert(milestones)
    .values({ projectId: input.projectId, title, dueOn: parseDay(input.dueOn) })
    .returning()
  return row!
}

/** Kept 30 days for Restore on Settings (lib/archive). */
export async function deleteMilestone(exec: Executor, id: string): Promise<void> {
  await exec.update(milestones).set({ deletedAt: new Date() }).where(eq(milestones.id, id))
}

// ─── links ───────────────────────────────────────────────────────────────────

export async function listLinks(exec: Executor, projectId: string): Promise<ProjectLink[]> {
  return exec
    .select()
    .from(projectLinks)
    .where(and(eq(projectLinks.projectId, projectId), notDeleted(projectLinks)))
    .orderBy(asc(projectLinks.createdAt))
}

export async function addLink(
  exec: Executor,
  input: { projectId: string; url: string; label?: string | null },
): Promise<ProjectLink> {
  const raw = input.url.trim()
  if (raw === '') throw new ValidationError('Enter a URL.')

  /* http and https only: the link is rendered as an href, and anything else
     (javascript:, data:) has no business there. */
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`)
  } catch {
    throw new ValidationError(`${raw} is not a URL.`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError('Links must start with http:// or https://.')
  }

  await getProject(exec, input.projectId)
  const [row] = await exec
    .insert(projectLinks)
    .values({
      projectId: input.projectId,
      url: url.toString(),
      label: blankToNull(input.label) ?? url.hostname,
    })
    .returning()
  return row!
}

/** Kept 30 days for Restore on Settings (lib/archive). */
export async function deleteLink(exec: Executor, id: string): Promise<void> {
  await exec.update(projectLinks).set({ deletedAt: new Date() }).where(eq(projectLinks.id, id))
}

/** A context's projects for a picker: in tree order, each name indented by its depth. */
export async function listProjectChoices(exec: Executor, contextId: string): Promise<Project[]> {
  return treeOrder(await listProjects(exec, contextId)).map(({ depth, ...project }) => ({
    ...project,
    name: indented({ name: project.name, depth }),
  }))
}
