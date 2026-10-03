/* Projects, with their milestones and links. Each belongs to one context. */

import { and, asc, eq, gte, sql } from 'drizzle-orm'
import { parseDay } from '../core/dates'
import { NotFoundError, ValidationError, type Executor } from '../core/types'
import { milestones, projectLinks, projects } from '../db/schema'
import { getContext } from '../directory/contexts'

export type Project = typeof projects.$inferSelect
export type ProjectStatus = Project['status']
export type Milestone = typeof milestones.$inferSelect
export type ProjectLink = typeof projectLinks.$inferSelect

export const PROJECT_STATUSES: ProjectStatus[] = ['active', 'paused', 'done']

export async function listProjects(exec: Executor, contextId: string): Promise<Project[]> {
  return exec
    .select()
    .from(projects)
    .where(eq(projects.contextId, contextId))
    // Active first, finished last.
    .orderBy(projects.status, sql`lower(${projects.name})`)
}

export async function getProject(exec: Executor, id: string): Promise<Project> {
  const [row] = await exec.select().from(projects).where(eq(projects.id, id)).limit(1)
  if (!row) throw new NotFoundError('Project', id)
  return row
}

async function assertNameFree(exec: Executor, contextId: string, name: string, exceptId?: string) {
  const [taken] = await exec
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.contextId, contextId), sql`lower(${projects.name}) = lower(${name})`))
    .limit(1)
  if (taken && taken.id !== exceptId) {
    throw new ValidationError(`There is already a project called ${name}.`)
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
  const all = await listProjects(exec, contextId)
  if (parentId === childId || descendantIds(all, [childId]).has(parentId)) {
    throw new ValidationError('A project cannot sit inside itself.')
  }
}

export async function createProject(
  exec: Executor,
  input: { contextId: string; name: string; description?: string | null; parentId?: string | null },
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
    })
    .returning()
  return row!
}

export async function updateProject(
  exec: Executor,
  id: string,
  input: { name?: string; description?: string | null; status?: ProjectStatus; parentId?: string | null },
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

/** A project's name indented by its depth, for an <option>. */
export function indented(project: { name: string; depth: number }): string {
  return `${'\u00a0\u00a0\u00a0'.repeat(project.depth)}${project.name}`
}

// ─── milestones ──────────────────────────────────────────────────────────────

export async function listMilestones(exec: Executor, projectId: string): Promise<Milestone[]> {
  return exec
    .select()
    .from(milestones)
    .where(eq(milestones.projectId, projectId))
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

export async function deleteMilestone(exec: Executor, id: string): Promise<void> {
  await exec.delete(milestones).where(eq(milestones.id, id))
}

// ─── links ───────────────────────────────────────────────────────────────────

export async function listLinks(exec: Executor, projectId: string): Promise<ProjectLink[]> {
  return exec
    .select()
    .from(projectLinks)
    .where(eq(projectLinks.projectId, projectId))
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

export async function deleteLink(exec: Executor, id: string): Promise<void> {
  await exec.delete(projectLinks).where(eq(projectLinks.id, id))
}

/** A context's projects for a picker: in tree order, each name indented by its depth. */
export async function listProjectChoices(exec: Executor, contextId: string): Promise<Project[]> {
  return treeOrder(await listProjects(exec, contextId)).map(({ depth, ...project }) => ({
    ...project,
    name: indented({ name: project.name, depth }),
  }))
}
