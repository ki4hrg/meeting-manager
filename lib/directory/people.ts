/* People are global; one row is John himself. */

import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { NotFoundError, ValidationError, inTransaction, type Executor } from '../core/types'
import { groupEmails, groups, people, personEmails } from '../db/schema'
import { notDeleted, onShelf, shelvedNote, type Shelf } from '../db/shelf'

export type Person = {
  id: string
  name: string
  isSelf: boolean
  /** The primary address, when there is one. */
  email: string | null
  /** Every address, the primary first. Invitees are matched against all of them. */
  emails: string[]
  archivedAt: Date | null
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
    return {
      id: row.id,
      name: row.name,
      isSelf: row.isSelf,
      archivedAt: row.archivedAt,
      email: primary?.email ?? null,
      emails: primary
        ? [primary.email, ...own.filter((email) => email !== primary).map((email) => email.email)]
        : [],
    }
  })
}

export async function listPeople(exec: Executor, shelf: Shelf = 'live'): Promise<Person[]> {
  const rows = await exec
    .select()
    .from(people)
    .where(onShelf(people, shelf))
    .orderBy(sql`lower(${people.name})`)
  return withEmails(exec, rows)
}

export async function getPerson(exec: Executor, id: string): Promise<Person> {
  const [row] = await exec
    .select()
    .from(people)
    .where(and(eq(people.id, id), notDeleted(people)))
    .limit(1)
  if (!row) throw new NotFoundError('Person', id)
  return (await withEmails(exec, [row]))[0]!
}

function cleanEmail(value: string | null | undefined): string | null {
  const email = (value ?? '').trim().toLowerCase()
  if (email === '') return null
  if (!email.includes('@')) throw new ValidationError('Enter a valid email address.')
  return email
}

/* An address on a group's list is refused for a person, naming the group. */
async function assertNotOnGroup(exec: Executor, email: string): Promise<void> {
  const [group] = await exec
    .select({ name: groups.name })
    .from(groupEmails)
    .innerJoin(groups, eq(groups.id, groupEmails.groupId))
    .where(sql`lower(${groupEmails.email}) = ${email}`)
    .limit(1)
  if (group) throw new ValidationError(`${email} already belongs to ${group.name}.`)
}

/** Who has an address already, if anyone. */
async function holderOf(
  exec: Executor,
  email: string,
): Promise<{ personId: string; name: string; archivedAt: Date | null; deletedAt: Date | null } | null> {
  const [taken] = await exec
    .select({
      personId: personEmails.personId,
      name: people.name,
      archivedAt: people.archivedAt,
      deletedAt: people.deletedAt,
    })
    .from(personEmails)
    .innerJoin(people, eq(people.id, personEmails.personId))
    .where(sql`lower(${personEmails.email}) = ${email}`)
    .limit(1)
  return taken ?? null
}

function belongsTo(
  email: string,
  holder: { name: string; archivedAt: Date | null; deletedAt: Date | null },
): ValidationError {
  return new ValidationError(`${email} already belongs to ${holder.name}${shelvedNote(holder)}.`)
}

/* The address the person form edits: it becomes the primary, replacing the old one. */
async function setPrimaryEmail(exec: Executor, personId: string, email: string | null) {
  if (email) {
    const taken = await holderOf(exec, email)
    if (taken && taken.personId !== personId) throw belongsTo(email, taken)
    if (!taken) await assertNotOnGroup(exec, email)
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

/**
 * Refuses a name someone already has. `createPerson` does not ask, since two
 * people can share a name; one made from a name alone, with nothing else to
 * tell them apart, must not.
 */
export async function assertPersonNameFree(exec: Executor, name: string): Promise<void> {
  const [taken] = await exec
    .select({ archivedAt: people.archivedAt, deletedAt: people.deletedAt })
    .from(people)
    .where(sql`lower(${people.name}) = lower(${name.trim()})`)
    .limit(1)
  if (taken) throw new ValidationError(`There is already a person called ${name.trim()}${shelvedNote(taken)}.`)
}

/** A new person. With `emails`, the first is the primary; `email` alone is the same as one. */
export async function createPerson(
  exec: Executor,
  input: { name: string; email?: string | null; emails?: string[] },
): Promise<Person> {
  const name = input.name.trim()
  if (name === '') throw new ValidationError('Enter a name.')
  const emails = [input.email, ...(input.emails ?? [])]
    .map(cleanEmail)
    .filter((email): email is string => email !== null)

  return inTransaction(exec, async (tx) => {
    const [row] = await tx.insert(people).values({ name }).returning()
    for (const email of emails) await addPersonEmail(tx, row!.id, email)
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

/** Every address on someone not deleted: what invitees are matched against. */
export async function liveEmails(exec: Executor): Promise<Array<typeof personEmails.$inferSelect>> {
  const rows = await exec
    .select({ email: personEmails })
    .from(personEmails)
    .innerJoin(people, eq(people.id, personEmails.personId))
    .where(notDeleted(people))
  return rows.map((row) => row.email)
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

  const taken = await holderOf(exec, email)
  if (taken) {
    if (taken.personId !== personId) throw belongsTo(email, taken)
    return
  }
  await assertNotOnGroup(exec, email)
  const [has] = await exec
    .select({ id: personEmails.id })
    .from(personEmails)
    .where(eq(personEmails.personId, personId))
    .limit(1)
  await exec.insert(personEmails).values({ personId, email, isPrimary: !has })
}

/** Take an address off someone. If it was their primary, their oldest remaining one takes its place. */
export async function removePersonEmail(exec: Executor, personId: string, value: string): Promise<void> {
  const email = cleanEmail(value)
  if (!email) return
  await inTransaction(exec, async (tx) => {
    const [gone] = await tx
      .delete(personEmails)
      .where(sql`${personEmails.personId} = ${personId} and lower(${personEmails.email}) = ${email}`)
      .returning({ isPrimary: personEmails.isPrimary })
    if (!gone?.isPrimary) return
    const [next] = await tx
      .select({ id: personEmails.id })
      .from(personEmails)
      .where(eq(personEmails.personId, personId))
      .orderBy(asc(personEmails.createdAt))
      .limit(1)
    if (next) await tx.update(personEmails).set({ isPrimary: true }).where(eq(personEmails.id, next.id))
  })
}

/** Make one of someone's addresses their primary. */
export async function makePrimaryEmail(exec: Executor, personId: string, value: string): Promise<void> {
  const email = cleanEmail(value)
  const own = (await getPerson(exec, personId)).emails
  if (!email || !own.includes(email)) throw new ValidationError('That address is not theirs.')
  await exec
    .update(personEmails)
    .set({ isPrimary: sql`lower(${personEmails.email}) = ${email}` })
    .where(eq(personEmails.personId, personId))
}

/** Set someone's addresses to exactly these, the first as primary. */
export async function setPersonEmails(exec: Executor, personId: string, values: string[]): Promise<void> {
  const emails = [...new Set(values.map(cleanEmail).filter((email): email is string => email !== null))]
  await inTransaction(exec, async (tx) => {
    for (const email of emails) await addPersonEmail(tx, personId, email)
    for (const email of (await getPerson(tx, personId)).emails) {
      if (!emails.includes(email)) await removePersonEmail(tx, personId, email)
    }
    if (emails[0]) await makePrimaryEmail(tx, personId, emails[0])
  })
}

/* The people at these addresses who are already in the directory, without
   John: he is at every meeting and never a row on one. */
export async function knownPeople(exec: Executor, emails: string[]): Promise<string[]> {
  if (emails.length === 0) return []
  const rows = await exec
    .select({ personId: personEmails.personId })
    .from(personEmails)
    .innerJoin(people, eq(people.id, personEmails.personId))
    .where(
      and(inArray(sql`lower(${personEmails.email})`, emails), eq(people.isSelf, false), notDeleted(people)),
    )
  return [...new Set(rows.map((row) => row.personId))]
}
