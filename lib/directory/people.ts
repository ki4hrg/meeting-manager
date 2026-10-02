/* People are global; one row is John himself. */

import { asc, eq, inArray, sql } from 'drizzle-orm'
import { NotFoundError, ValidationError, inTransaction, type Executor } from '../core/types'
import { people, personEmails } from '../db/schema'

export type Person = {
  id: string
  name: string
  isSelf: boolean
  /** The primary address, when there is one. */
  email: string | null
}

async function withEmails(
  exec: Executor,
  rows: Array<typeof people.$inferSelect>,
): Promise<Person[]> {
  if (rows.length === 0) return []

  const emails = await exec
    .select()
    .from(personEmails)
    .where(
      inArray(
        personEmails.personId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(personEmails.createdAt))

  return rows.map((row) => {
    const own = emails.filter((email) => email.personId === row.id)
    const primary = own.find((email) => email.isPrimary) ?? own[0]
    return { id: row.id, name: row.name, isSelf: row.isSelf, email: primary?.email ?? null }
  })
}

export async function listPeople(exec: Executor): Promise<Person[]> {
  const rows = await exec.select().from(people).orderBy(sql`lower(${people.name})`)
  return withEmails(exec, rows)
}

export async function getPerson(exec: Executor, id: string): Promise<Person> {
  const [row] = await exec.select().from(people).where(eq(people.id, id)).limit(1)
  if (!row) throw new NotFoundError('Person', id)
  return (await withEmails(exec, [row]))[0]!
}

function cleanEmail(value: string | null | undefined): string | null {
  const email = (value ?? '').trim().toLowerCase()
  if (email === '') return null
  if (!email.includes('@')) throw new ValidationError('Enter a valid email address.')
  return email
}

/* One address per person is all the screens edit today; the table holds
   several so calendar matching can add the rest in phase 2. */
async function setPrimaryEmail(exec: Executor, personId: string, email: string | null) {
  if (email) {
    const [taken] = await exec
      .select({ personId: personEmails.personId })
      .from(personEmails)
      .where(sql`lower(${personEmails.email}) = ${email}`)
      .limit(1)
    if (taken && taken.personId !== personId) {
      throw new ValidationError(`${email} already belongs to someone else.`)
    }
    if (taken) {
      await exec
        .update(personEmails)
        .set({ isPrimary: sql`lower(${personEmails.email}) = ${email}` })
        .where(eq(personEmails.personId, personId))
      return
    }
  }

  await exec
    .delete(personEmails)
    .where(sql`${personEmails.personId} = ${personId} and ${personEmails.isPrimary}`)
  if (email) await exec.insert(personEmails).values({ personId, email, isPrimary: true })
}

export async function createPerson(
  exec: Executor,
  input: { name: string; email?: string | null },
): Promise<Person> {
  const name = input.name.trim()
  if (name === '') throw new ValidationError('Enter a name.')
  const email = cleanEmail(input.email)

  return inTransaction(exec, async (tx) => {
    const [row] = await tx.insert(people).values({ name }).returning()
    await setPrimaryEmail(tx, row!.id, email)
    return getPerson(tx, row!.id)
  })
}

export async function updatePerson(
  exec: Executor,
  id: string,
  input: { name?: string; email?: string | null },
): Promise<Person> {
  return inTransaction(exec, async (tx) => {
    await getPerson(tx, id)

    if (input.name !== undefined) {
      const name = input.name.trim()
      if (name === '') throw new ValidationError('Enter a name.')
      await tx.update(people).set({ name, updatedAt: new Date() }).where(eq(people.id, id))
    }
    if (input.email !== undefined) await setPrimaryEmail(tx, id, cleanEmail(input.email))

    return getPerson(tx, id)
  })
}

export async function findSelf(exec: Executor): Promise<Person | null> {
  const [row] = await exec.select().from(people).where(eq(people.isSelf, true)).limit(1)
  return row ? (await withEmails(exec, [row]))[0]! : null
}

/**
 * The person row that is John, created from his account the first time it is
 * asked for. The partial unique index is what keeps it to one row; a second
 * request racing the first simply reads the winner's.
 */
export async function ensureSelf(
  exec: Executor,
  account: { displayName: string; email: string },
): Promise<Person> {
  const existing = await findSelf(exec)
  if (existing) return existing

  await inTransaction(exec, async (tx) => {
    const [row] = await tx
      .insert(people)
      .values({ name: account.displayName, isSelf: true })
      .onConflictDoNothing()
      .returning()
    if (!row) return

    const email = account.email.trim().toLowerCase()
    await tx
      .insert(personEmails)
      .values({ personId: row.id, email, isPrimary: true })
      .onConflictDoNothing()
  })

  return (await findSelf(exec))!
}

/**
 * Another address for someone already in the directory: their primary when
 * they have none, otherwise one more they are known by.
 */
export async function addPersonEmail(exec: Executor, personId: string, value: string): Promise<void> {
  const email = cleanEmail(value)
  if (!email) throw new ValidationError('Enter an email address.')
  await getPerson(exec, personId)

  const [taken] = await exec
    .select({ personId: personEmails.personId })
    .from(personEmails)
    .where(sql`lower(${personEmails.email}) = ${email}`)
    .limit(1)
  if (taken) {
    if (taken.personId !== personId) throw new ValidationError(`${email} already belongs to someone else.`)
    return
  }
  const [has] = await exec
    .select({ id: personEmails.id })
    .from(personEmails)
    .where(eq(personEmails.personId, personId))
    .limit(1)
  await exec.insert(personEmails).values({ personId, email, isPrimary: !has })
}
