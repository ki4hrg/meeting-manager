/* The one account: created by /setup, which closes once it exists. */

import { and, count, eq, isNull, sql } from 'drizzle-orm'
import { isTimeZone } from '../core/dates'
import { ValidationError, inTransaction, type Executor } from '../core/types'
import { db } from '../db'
import { users } from '../db/schema'
import { hashPassword } from './password'
import { passwordProblem } from './password-policy'
import type { AuthUser } from './sessions'

export type CreateUserInput = {
  email: string
  displayName: string
  password: string
}

/** With no user every route redirects to /setup; with one, /setup refuses. */
export async function needsSetup(exec: Executor = db): Promise<boolean> {
  const [row] = await exec.select({ n: count() }).from(users).where(isNull(users.deletedAt))
  return Number(row?.n ?? 0) === 0
}

export async function findUserByEmail(
  email: string,
  exec: Executor = db,
): Promise<typeof users.$inferSelect | undefined> {
  const [row] = await exec
    .select()
    .from(users)
    .where(and(sql`lower(${users.email}) = lower(${email.trim()})`, isNull(users.deletedAt)))
    .limit(1)
  return row
}

/**
 * Create the account. Refuses once one exists, which is what makes /setup
 * self-disabling rather than merely hidden. The check and the insert share a
 * transaction and an advisory lock so two simultaneous requests cannot both win.
 */
export async function createFirstUser(
  input: CreateUserInput,
  exec: Executor = db,
): Promise<AuthUser> {
  const email = input.email.trim().toLowerCase()
  if (!email.includes('@')) throw new ValidationError('Enter a valid email address.')

  const displayName = input.displayName.trim()
  if (displayName === '') throw new ValidationError('Enter a name.')

  const problem = passwordProblem(input.password)
  if (problem) throw new ValidationError(problem)

  const passwordHash = await hashPassword(input.password)

  return inTransaction(exec, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('mm:setup'))`)

    if (!(await needsSetup(tx))) {
      throw new ValidationError('Setup has already been completed.')
    }

    const [user] = await tx.insert(users).values({ email, displayName, passwordHash }).returning()

    return {
      id: user!.id,
      email: user!.email,
      displayName: user!.displayName,
      timeZone: user!.timeZone,
    }
  })
}

/**
 * John's time zone, which decides "today", every day shown and every date sent
 * out. Null goes back to the instance's own (the process TZ).
 */
export async function setTimeZone(
  exec: Executor,
  userId: string,
  timeZone: string | null,
): Promise<void> {
  const zone = timeZone?.trim() || null
  if (zone !== null && !isTimeZone(zone)) throw new ValidationError(`${zone} is not a time zone.`)
  await exec.update(users).set({ timeZone: zone }).where(eq(users.id, userId))
}
