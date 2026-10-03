/* Groups belong to a context and act as parties alongside people. */

import { and, eq, sql } from 'drizzle-orm'
import { NotFoundError, ValidationError, type Executor } from '../core/types'
import { groupMembers, groups, people } from '../db/schema'
import { notDeleted, onShelf, shelvedNote, type Shelf } from '../db/shelf'
import { getContext } from './contexts'
import { getPerson } from './people'

export type Group = typeof groups.$inferSelect

export type GroupWithCount = Group & { memberCount: number }

export async function listGroups(
  exec: Executor,
  contextId: string,
  shelf: Shelf = 'live',
): Promise<GroupWithCount[]> {
  return exec
    .select({
      id: groups.id,
      contextId: groups.contextId,
      name: groups.name,
      createdAt: groups.createdAt,
      updatedAt: groups.updatedAt,
      archivedAt: groups.archivedAt,
      deletedAt: groups.deletedAt,
      memberCount: sql<number>`(select count(*)::int from ${groupMembers}
        where ${groupMembers.groupId} = ${groups.id})`,
    })
    .from(groups)
    .where(and(eq(groups.contextId, contextId), onShelf(groups, shelf)))
    .orderBy(sql`lower(${groups.name})`)
}

export async function getGroup(exec: Executor, id: string): Promise<Group> {
  const [row] = await exec
    .select()
    .from(groups)
    .where(and(eq(groups.id, id), notDeleted(groups)))
    .limit(1)
  if (!row) throw new NotFoundError('Group', id)
  return row
}

async function assertNameFree(exec: Executor, contextId: string, name: string, exceptId?: string) {
  const [taken] = await exec
    .select({ id: groups.id, archivedAt: groups.archivedAt, deletedAt: groups.deletedAt })
    .from(groups)
    .where(and(eq(groups.contextId, contextId), sql`lower(${groups.name}) = lower(${name})`))
    .limit(1)
  if (taken && taken.id !== exceptId) {
    throw new ValidationError(`There is already a group called ${name}${shelvedNote(taken)}.`)
  }
}

export async function createGroup(
  exec: Executor,
  input: { contextId: string; name: string },
): Promise<Group> {
  const name = input.name.trim()
  if (name === '') throw new ValidationError('Enter a name.')
  await getContext(exec, input.contextId)
  await assertNameFree(exec, input.contextId, name)

  const [row] = await exec.insert(groups).values({ contextId: input.contextId, name }).returning()
  return row!
}

export async function renameGroup(exec: Executor, id: string, name: string): Promise<Group> {
  const trimmed = name.trim()
  if (trimmed === '') throw new ValidationError('Enter a name.')
  const group = await getGroup(exec, id)
  await assertNameFree(exec, group.contextId, trimmed, id)

  const [row] = await exec
    .update(groups)
    .set({ name: trimmed, updatedAt: new Date() })
    .where(eq(groups.id, id))
    .returning()
  return row!
}

export type Member = { id: string; name: string; isSelf: boolean }

export async function listMembers(exec: Executor, groupId: string): Promise<Member[]> {
  return exec
    .select({ id: people.id, name: people.name, isSelf: people.isSelf })
    .from(groupMembers)
    .innerJoin(people, eq(people.id, groupMembers.personId))
    .where(and(eq(groupMembers.groupId, groupId), notDeleted(people)))
    .orderBy(sql`lower(${people.name})`)
}

export async function addMember(exec: Executor, groupId: string, personId: string): Promise<void> {
  await getGroup(exec, groupId)
  await getPerson(exec, personId)
  await exec.insert(groupMembers).values({ groupId, personId }).onConflictDoNothing()
}

export async function removeMember(
  exec: Executor,
  groupId: string,
  personId: string,
): Promise<void> {
  await exec
    .delete(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.personId, personId)))
}
