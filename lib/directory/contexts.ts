/* Contexts: the hard boundary projects, groups and items sit inside. */

import { asc, eq, sql } from 'drizzle-orm'
import { NotFoundError, ValidationError, type Executor } from '../core/types'
import { contexts } from '../db/schema'

export type Context = typeof contexts.$inferSelect

export async function listContexts(exec: Executor): Promise<Context[]> {
  return exec.select().from(contexts).orderBy(asc(contexts.sortOrder), asc(contexts.createdAt))
}

export async function getContext(exec: Executor, id: string): Promise<Context> {
  const [row] = await exec.select().from(contexts).where(eq(contexts.id, id)).limit(1)
  if (!row) throw new NotFoundError('Context', id)
  return row
}

async function assertNameFree(exec: Executor, name: string, exceptId?: string) {
  const [taken] = await exec
    .select({ id: contexts.id })
    .from(contexts)
    .where(sql`lower(${contexts.name}) = lower(${name})`)
    .limit(1)
  if (taken && taken.id !== exceptId) {
    throw new ValidationError(`There is already a context called ${name}.`)
  }
}

export async function createContext(exec: Executor, input: { name: string }): Promise<Context> {
  const name = input.name.trim()
  if (name === '') throw new ValidationError('Enter a name.')
  await assertNameFree(exec, name)

  const [row] = await exec.insert(contexts).values({ name }).returning()
  return row!
}

export async function renameContext(exec: Executor, id: string, name: string): Promise<Context> {
  const trimmed = name.trim()
  if (trimmed === '') throw new ValidationError('Enter a name.')
  await getContext(exec, id)
  await assertNameFree(exec, trimmed, id)

  const [row] = await exec
    .update(contexts)
    .set({ name: trimmed, updatedAt: new Date() })
    .where(eq(contexts.id, id))
    .returning()
  return row!
}
