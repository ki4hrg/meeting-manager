/* A small world to test the domain layer in: two contexts, John, and a few others. */

import { randomUUID } from 'node:crypto'
import type { ActorContext } from '../../lib/core/types'
import { createContext } from '../../lib/directory/contexts'
import { addMember, createGroup } from '../../lib/directory/groups'
import { createPerson, ensureSelf } from '../../lib/directory/people'
import { createProject } from '../../lib/projects/projects'
import { db } from './db'

export const actor: ActorContext = { userId: null, source: 'system', requestId: randomUUID() }

export async function makeWorld() {
  const parish = await createContext(db, { name: 'Parish' })
  const diocese = await createContext(db, { name: 'Diocese' })

  const john = await ensureSelf(db, { displayName: 'John', email: 'john@example.test' })
  const sarah = await createPerson(db, { name: 'Sarah Jones', email: 'sarah@example.test' })
  const tom = await createPerson(db, { name: 'Tom Baker' })
  const bishop = await createPerson(db, { name: 'Bishop Wright' })

  const staff = await createGroup(db, { contextId: parish.id, name: 'Staff' })
  await addMember(db, staff.id, sarah.id)
  await addMember(db, staff.id, tom.id)
  const council = await createGroup(db, { contextId: diocese.id, name: 'Council' })

  const retreat = await createProject(db, { contextId: parish.id, name: 'Retreat' })
  const campaign = await createProject(db, { contextId: parish.id, name: 'Capital campaign' })
  const synod = await createProject(db, { contextId: diocese.id, name: 'Synod' })

  return { parish, diocese, john, sarah, tom, bishop, staff, council, retreat, campaign, synod }
}
