/*
 * Something new, from its name alone: what a picker or a quick-add line
 * offers when the name typed matches nothing. It is made in the given
 * context, inside the caller's transaction, so a refused line or form makes
 * nothing; its details are filled in later on its own page. A name already
 * taken is refused.
 */

import { ValidationError, type Executor } from '../core/types'
import { createSeries } from '../meetings/series'
import { createProject } from '../projects/projects'
import { createGroup } from './groups'
import { assertPersonNameFree, createPerson } from './people'
import type { Mention } from './resolve'

export type NewKind = Mention['type']

const NEW_KINDS: readonly string[] = ['person', 'group', 'project', 'series'] satisfies NewKind[]

export function isNewKind(value: unknown): value is NewKind {
  return typeof value === 'string' && NEW_KINDS.includes(value)
}

export async function createNamed(
  exec: Executor,
  contextId: string,
  type: NewKind,
  rawName: string,
): Promise<Mention> {
  const name = rawName.trim()
  if (name === '') throw new ValidationError('Enter a name.')
  switch (type) {
    case 'person': {
      await assertPersonNameFree(exec, name)
      const person = await createPerson(exec, { name })
      return { type, id: person.id, name: person.name }
    }
    case 'group': {
      const group = await createGroup(exec, { contextId, name })
      return { type, id: group.id, name: group.name }
    }
    case 'project': {
      const project = await createProject(exec, { contextId, name })
      return { type, id: project.id, name: project.name }
    }
    case 'series': {
      const made = await createSeries(exec, { contextId, name })
      return { type, id: made.id, name: made.name }
    }
  }
}
