/*
 * Turning a name, as typed or as a model supplies it, into a row.
 *
 * Capture is meant to be quick, so a first name or a prefix is enough when it
 * is unambiguous. When it is not, the refusal names the candidates so the
 * caller can pick one.
 */

import { and, eq } from 'drizzle-orm'
import { isUuid, matchName, matchTiered } from '../core/match'
import { ValidationError, type Executor } from '../core/types'
import { groups, people, projects, series } from '../db/schema'
import { notDeleted, onShelf } from '../db/shelf'
import { listContexts, type Context } from './contexts'

export type Party = { type: 'person' | 'group'; id: string; name: string }

/** A name that matched nothing at all, as against one that matched several. */
export class NoMatchError extends ValidationError {}

/* An id still reaches an archived row; a name only finds what the lists show. */
function named<T extends { archivedAt: Date | null }>(rows: T[]): T[] {
  return rows.filter((row) => !row.archivedAt)
}

function listNames(rows: Array<{ name: string }>): string {
  return rows.map((row) => row.name).join(', ')
}

/** A person anywhere, or a group in this context. `me` is John. */
export async function resolveParty(exec: Executor, contextId: string, ref: string): Promise<Party> {
  const wanted = ref.trim().replace(/^@/, '')
  if (wanted === '') throw new ValidationError('Name a person or a group.')

  const allPeople = await exec
    .select({ id: people.id, name: people.name, isSelf: people.isSelf, archivedAt: people.archivedAt })
    .from(people)
    .where(notDeleted(people))
  const contextGroups = await exec
    .select({ id: groups.id, name: groups.name, archivedAt: groups.archivedAt })
    .from(groups)
    .where(and(eq(groups.contextId, contextId), notDeleted(groups)))

  if (isUuid(wanted)) {
    const person = allPeople.find((row) => row.id === wanted)
    if (person) return { type: 'person', id: person.id, name: person.name }
    const group = contextGroups.find((row) => row.id === wanted)
    if (group) return { type: 'group', id: group.id, name: group.name }
    throw new ValidationError(`No person or group in this context has the id ${wanted}.`)
  }

  if (wanted.toLowerCase() === 'me') {
    const self = allPeople.find((row) => row.isSelf)
    if (self) return { type: 'person', id: self.id, name: self.name }
  }

  const candidates: Party[] = [
    ...named(allPeople).map((row) => ({ type: 'person' as const, id: row.id, name: row.name })),
    ...named(contextGroups).map((row) => ({ type: 'group' as const, id: row.id, name: row.name })),
  ]
  const matches = matchName(candidates, wanted)

  if (matches.length === 1) return matches[0]!
  if (matches.length === 0) throw new NoMatchError(`No person or group matches ${wanted}.`)
  throw new ValidationError(`${wanted} could be ${listNames(matches)}. Be more specific.`)
}

export async function resolveProject(
  exec: Executor,
  contextId: string,
  ref: string,
): Promise<{ id: string; name: string }> {
  const wanted = ref.trim().replace(/^#/, '')
  if (wanted === '') throw new ValidationError('Name a project.')

  const all = await exec
    .select({ id: projects.id, name: projects.name, parentId: projects.parentId, archivedAt: projects.archivedAt })
    .from(projects)
    .where(and(eq(projects.contextId, contextId), notDeleted(projects)))
  const rows = named(all).map(({ id, name }) => ({ id, name }))

  if (isUuid(wanted)) {
    const project = all.map(({ id, name }) => ({ id, name })).find((row) => row.id === wanted)
    if (project) return project
    throw new ValidationError(`No project in this context has the id ${wanted}.`)
  }

  /* A path, "AC2027/Worship": the last part names the project, and each part
     before it names the project itself or one above it. */
  const parts = wanted.split('/').map((part) => part.trim()).filter(Boolean)
  if (parts.length > 1) {
    const byId = new Map(all.map((row) => [row.id, row]))
    const line = (id: string) => {
      const chain: Array<{ name: string }> = []
      for (let at = byId.get(id); at; at = at.parentId ? byId.get(at.parentId) : undefined) chain.push(at)
      return chain
    }
    const found = matchName(rows, parts.at(-1)!).filter((row) =>
      parts.slice(0, -1).every((part) => matchName(line(row.id), part).length > 0),
    )
    if (found.length === 1) return found[0]!
    if (found.length === 0) throw new ValidationError(`No project matches ${wanted}.`)
    throw new ValidationError(`${wanted} could be ${listNames(found)}. Be more specific.`)
  }

  const matches = matchName(rows, wanted)
  if (matches.length === 1) return matches[0]!
  if (matches.length === 0) throw new ValidationError(`No project matches ${wanted}.`)
  throw new ValidationError(`${wanted} could be ${listNames(matches)}. Be more specific.`)
}

/** A person, never a group: who is at a meeting. `me` is John. */
export async function resolvePerson(exec: Executor, ref: string): Promise<{ id: string; name: string }> {
  const wanted = ref.trim().replace(/^@/, '')
  if (wanted === '') throw new ValidationError('Name a person.')

  const rows = await exec
    .select({ id: people.id, name: people.name, isSelf: people.isSelf, archivedAt: people.archivedAt })
    .from(people)
    .where(notDeleted(people))
  const only = (row: { id: string; name: string }) => ({ id: row.id, name: row.name })

  if (isUuid(wanted)) {
    const person = rows.find((row) => row.id === wanted)
    if (person) return only(person)
    throw new ValidationError(`No person has the id ${wanted}.`)
  }

  if (wanted.toLowerCase() === 'me') {
    const self = rows.find((row) => row.isSelf)
    if (self) return only(self)
  }

  const matches = matchName(named(rows), wanted)
  if (matches.length === 1) return only(matches[0]!)
  if (matches.length === 0) throw new NoMatchError(`No person matches ${wanted}.`)
  throw new ValidationError(`${wanted} could be ${listNames(matches)}. Be more specific.`)
}

/** A group in this context. */
export async function resolveGroup(
  exec: Executor,
  contextId: string,
  ref: string,
): Promise<{ id: string; name: string }> {
  const wanted = ref.trim().replace(/^@/, '')
  if (wanted === '') throw new ValidationError('Name a group.')

  const rows = await exec
    .select({ id: groups.id, name: groups.name, archivedAt: groups.archivedAt })
    .from(groups)
    .where(and(eq(groups.contextId, contextId), notDeleted(groups)))

  if (isUuid(wanted)) {
    const group = rows.find((row) => row.id === wanted)
    if (group) return { id: group.id, name: group.name }
    throw new ValidationError(`No group in this context has the id ${wanted}.`)
  }

  const matches = matchName(named(rows), wanted).map(({ id, name }) => ({ id, name }))
  if (matches.length === 1) return matches[0]!
  if (matches.length === 0) throw new ValidationError(`No group matches ${wanted}.`)
  throw new ValidationError(`${wanted} could be ${listNames(matches)}. Be more specific.`)
}

/** A series in this context. */
export async function resolveSeries(
  exec: Executor,
  contextId: string,
  ref: string,
): Promise<{ id: string; name: string }> {
  const wanted = ref.trim()
  if (wanted === '') throw new ValidationError('Name a series.')

  const rows = await exec
    .select({ id: series.id, name: series.name, archivedAt: series.archivedAt })
    .from(series)
    .where(and(eq(series.contextId, contextId), notDeleted(series)))

  if (isUuid(wanted)) {
    const found = rows.find((row) => row.id === wanted)
    if (found) return { id: found.id, name: found.name }
    throw new ValidationError(`No series in this context has the id ${wanted}.`)
  }

  const matches = matchName(named(rows), wanted).map(({ id, name }) => ({ id, name }))
  if (matches.length === 1) return matches[0]!
  if (matches.length === 0) throw new ValidationError(`No series matches ${wanted}.`)
  throw new ValidationError(`${wanted} could be ${listNames(matches)}. Be more specific.`)
}

export type Mention =
  | Party
  | { type: 'project'; id: string; name: string }
  | { type: 'series'; id: string; name: string }

/**
 * Quick-add's one `@`: a person or group, else a project, else a series, in
 * this context (see `matchTiered`). A path ("AC2027/Worship") is a project's.
 */
export async function resolveMention(exec: Executor, contextId: string, ref: string): Promise<Mention> {
  const wanted = ref.trim().replace(/^@/, '')
  if (wanted === '') throw new ValidationError('Name someone or something.')
  if (wanted.toLowerCase() === 'me' || isUuid(wanted)) return resolveParty(exec, contextId, wanted)
  if (wanted.includes('/')) {
    const project = await resolveProject(exec, contextId, wanted).catch(() => null)
    if (project) return { type: 'project', ...project }
  }

  const [allPeople, contextGroups, contextProjects, contextSeries] = await Promise.all([
    exec.select({ id: people.id, name: people.name }).from(people).where(onShelf(people)),
    exec
      .select({ id: groups.id, name: groups.name })
      .from(groups)
      .where(and(eq(groups.contextId, contextId), onShelf(groups))),
    exec
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(and(eq(projects.contextId, contextId), onShelf(projects))),
    exec
      .select({ id: series.id, name: series.name })
      .from(series)
      .where(and(eq(series.contextId, contextId), onShelf(series))),
  ])
  const matches = matchTiered<Mention>(
    [
      [
        ...allPeople.map((row) => ({ type: 'person' as const, ...row })),
        ...contextGroups.map((row) => ({ type: 'group' as const, ...row })),
      ],
      contextProjects.map((row) => ({ type: 'project' as const, ...row })),
      contextSeries.map((row) => ({ type: 'series' as const, ...row })),
    ],
    wanted,
  )
  if (matches.length === 1) return matches[0]!
  if (matches.length === 0) throw new ValidationError(`No person, group, project or series matches ${wanted}.`)
  throw new ValidationError(`${wanted} could be ${listNames(matches)}. Be more specific.`)
}

/**
 * The context a capture belongs in when the caller did not say: the only one
 * there is, or the only one holding a project, series or group by one of these
 * names.
 */
export async function inferContext(
  exec: Executor,
  hints: { context?: string; project?: string; series?: string; parties?: string[] },
): Promise<Context> {
  const all = await listContexts(exec)
  if (all.length === 0) throw new ValidationError('There are no contexts yet. Create one first.')

  if (hints.context) {
    const wanted = hints.context.trim()
    const matches = isUuid(wanted) ? all.filter((row) => row.id === wanted) : matchName(all, wanted)
    if (matches.length === 1) return matches[0]!
    throw new ValidationError(`No single context matches ${wanted}. There are: ${listNames(all)}.`)
  }

  if (all.length === 1) return all[0]!

  const holding = new Set<string>()

  if (hints.project) {
    const wanted = hints.project.trim().replace(/^#/, '')
    const rows = await exec
      .select({ id: projects.id, name: projects.name, contextId: projects.contextId })
      .from(projects)
      .where(onShelf(projects))
    const found = isUuid(wanted) ? rows.filter((row) => row.id === wanted) : matchName(rows, wanted)
    for (const row of found) holding.add(row.contextId)
  }

  if (holding.size === 0 && hints.series) {
    const wanted = hints.series.trim()
    const rows = await exec
      .select({ id: series.id, name: series.name, contextId: series.contextId })
      .from(series)
      .where(onShelf(series))
    const found = isUuid(wanted) ? rows.filter((row) => row.id === wanted) : matchName(rows, wanted)
    for (const row of found) holding.add(row.contextId)
  }

  if (holding.size === 0 && hints.parties?.length) {
    const rows = await exec
      .select({ id: groups.id, name: groups.name, contextId: groups.contextId })
      .from(groups)
      .where(onShelf(groups))
    for (const ref of hints.parties) {
      const wanted = ref.trim().replace(/^@/, '')
      const found = isUuid(wanted)
        ? rows.filter((row) => row.id === wanted)
        : matchName(rows, wanted)
      for (const row of found) holding.add(row.contextId)
    }
  }

  if (holding.size === 1) return all.find((row) => row.id === [...holding][0])!
  throw new ValidationError(`Say which context this belongs to: ${listNames(all)}.`)
}
