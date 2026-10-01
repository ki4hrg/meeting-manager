/*
 * Turning a name, as typed or as a model supplies it, into a row.
 *
 * Capture is meant to be quick, so a first name or a prefix is enough when it
 * is unambiguous. When it is not, the refusal names the candidates so the
 * caller can pick one.
 */

import { eq } from 'drizzle-orm'
import { isUuid, matchName } from '../core/match'
import { ValidationError, type Executor } from '../core/types'
import { groups, people, projects } from '../db/schema'
import { listContexts, type Context } from './contexts'

export type Party = { type: 'person' | 'group'; id: string; name: string }

function listNames(rows: Array<{ name: string }>): string {
  return rows.map((row) => row.name).join(', ')
}

/** A person anywhere, or a group in this context. `me` is John. */
export async function resolveParty(exec: Executor, contextId: string, ref: string): Promise<Party> {
  const wanted = ref.trim().replace(/^@/, '')
  if (wanted === '') throw new ValidationError('Name a person or a group.')

  const allPeople = await exec
    .select({ id: people.id, name: people.name, isSelf: people.isSelf })
    .from(people)
  const contextGroups = await exec
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .where(eq(groups.contextId, contextId))

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
    ...allPeople.map((row) => ({ type: 'person' as const, id: row.id, name: row.name })),
    ...contextGroups.map((row) => ({ type: 'group' as const, id: row.id, name: row.name })),
  ]
  const matches = matchName(candidates, wanted)

  if (matches.length === 1) return matches[0]!
  if (matches.length === 0) throw new ValidationError(`No person or group matches ${wanted}.`)
  throw new ValidationError(`${wanted} could be ${listNames(matches)}. Be more specific.`)
}

export async function resolveProject(
  exec: Executor,
  contextId: string,
  ref: string,
): Promise<{ id: string; name: string }> {
  const wanted = ref.trim().replace(/^#/, '')
  if (wanted === '') throw new ValidationError('Name a project.')

  const rows = await exec
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.contextId, contextId))

  if (isUuid(wanted)) {
    const project = rows.find((row) => row.id === wanted)
    if (project) return project
    throw new ValidationError(`No project in this context has the id ${wanted}.`)
  }

  const matches = matchName(rows, wanted)
  if (matches.length === 1) return matches[0]!
  if (matches.length === 0) throw new ValidationError(`No project matches ${wanted}.`)
  throw new ValidationError(`${wanted} could be ${listNames(matches)}. Be more specific.`)
}

/**
 * The context a capture belongs in when the caller did not say: the only one
 * there is, or the only one holding a project or group by one of these names.
 */
export async function inferContext(
  exec: Executor,
  hints: { context?: string; project?: string; parties?: string[] },
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
    const found = isUuid(wanted) ? rows.filter((row) => row.id === wanted) : matchName(rows, wanted)
    for (const row of found) holding.add(row.contextId)
  }

  if (holding.size === 0 && hints.parties?.length) {
    const rows = await exec
      .select({ id: groups.id, name: groups.name, contextId: groups.contextId })
      .from(groups)
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
