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

export async function createProject(
  exec: Executor,
  input: { contextId: string; name: string; description?: string | null },
): Promise<Project> {
  const name = input.name.trim()
  if (name === '') throw new ValidationError('Enter a name.')
  await getContext(exec, input.contextId)
  await assertNameFree(exec, input.contextId, name)

  const [row] = await exec
    .insert(projects)
    .values({ contextId: input.contextId, name, description: blankToNull(input.description) })
    .returning()
  return row!
}

export async function updateProject(
  exec: Executor,
  id: string,
  input: { name?: string; description?: string | null; status?: ProjectStatus },
): Promise<Project> {
  const project = await getProject(exec, id)
  const patch: Partial<typeof projects.$inferInsert> = {}

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
