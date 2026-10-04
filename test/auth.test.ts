import { describe, expect, it } from 'vitest'
import { verifyPassword } from '../lib/auth/password'
import { safeNext } from '../lib/auth/redirects'
import { createSession, resolveSession, revokeSession } from '../lib/auth/sessions'
import { createFirstUser, findUserByEmail, needsSetup, setTimeZone } from '../lib/auth/users'
import { ValidationError } from '../lib/core/types'
import { db, resetBetweenTests } from './helpers/db'

resetBetweenTests()

const account = { email: 'John@Example.test', displayName: 'John', password: 'correct horse battery' }

describe('time zone', () => {
  it('saves a known zone, refuses an unknown one, and clears back to the default', async () => {
    const user = await createFirstUser(account, db)
    await setTimeZone(db, user.id, 'America/Denver')
    expect((await findUserByEmail(account.email, db))?.timeZone).toBe('America/Denver')

    await expect(setTimeZone(db, user.id, 'Mars/Olympus')).rejects.toBeInstanceOf(ValidationError)
    expect((await findUserByEmail(account.email, db))?.timeZone).toBe('America/Denver')

    await setTimeZone(db, user.id, '')
    expect((await findUserByEmail(account.email, db))?.timeZone).toBeNull()
  })
})

describe('setup', () => {
  it('creates the account once and then refuses', async () => {
    expect(await needsSetup(db)).toBe(true)

    const user = await createFirstUser(account, db)
    expect(user.email).toBe('john@example.test')
    expect(await needsSetup(db)).toBe(false)

    await expect(
      createFirstUser({ ...account, email: 'other@example.test' }, db),
    ).rejects.toThrow('Setup has already been completed.')
  })

  it('lets only one of two simultaneous attempts win', async () => {
    const results = await Promise.allSettled([
      createFirstUser(account, db),
      createFirstUser({ ...account, email: 'second@example.test' }, db),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  })

  it('refuses a short password', async () => {
    await expect(createFirstUser({ ...account, password: 'short' }, db)).rejects.toBeInstanceOf(
      ValidationError,
    )
    expect(await needsSetup(db)).toBe(true)
  })

  it('stores a hash that verifies, and finds the address in any case', async () => {
    await createFirstUser(account, db)
    const row = await findUserByEmail('JOHN@example.TEST', db)
    expect(row).toBeDefined()
    expect(row!.passwordHash).not.toContain(account.password)
    expect(await verifyPassword(row!.passwordHash, account.password)).toBe(true)
    expect(await verifyPassword(row!.passwordHash, 'wrong password here')).toBe(false)
  })
})

describe('sessions', () => {
  it('resolves a live session and nothing else', async () => {
    const user = await createFirstUser(account, db)
    const session = await createSession(user.id, {}, db)

    expect((await resolveSession(session.token, db))?.id).toBe(user.id)
    expect(await resolveSession('not-a-token', db)).toBeNull()
    expect(await resolveSession(undefined, db)).toBeNull()

    await revokeSession(session.token, db)
    expect(await resolveSession(session.token, db)).toBeNull()
  })
})

describe('safeNext', () => {
  it('allows a path on this origin and nothing else', () => {
    expect(safeNext('/oauth/authorize?client_id=x')).toBe('/oauth/authorize?client_id=x')
    expect(safeNext('https://evil.example')).toBe('/')
    expect(safeNext('//evil.example')).toBe('/')
    expect(safeNext('/\\evil.example')).toBe('/')
    expect(safeNext(null)).toBe('/')
  })
})
