import { describe, expect, it } from 'vitest'
import { decrypt, encrypt } from '../lib/connect/crypto'
import {
  accessTokenFor,
  ConnectionError,
  GoogleUnauthorized,
  bindCalendar,
  deleteConnection,
  getConnection,
  googleConfigured,
  listBindings,
  listCalendars,
  listConnections,
  saveGoogleConnection,
  unbindCalendar,
  type CalendarInfo,
} from '../lib/connect/connections'
import { NotFoundError, ValidationError } from '../lib/core/types'
import { db, resetBetweenTests } from './helpers/db'
import { createContext } from '../lib/directory/contexts'

resetBetweenTests()

describe('crypto', () => {
  it('encrypts and decrypts strings', () => {
    const plaintext = 'hello world'
    const password = 'secret-password'

    const encrypted = encrypt(plaintext, password)
    expect(encrypted).toHaveProperty('ciphertext')
    expect(encrypted).toHaveProperty('iv')
    expect(encrypted).toHaveProperty('salt')

    const decrypted = decrypt(encrypted, password)
    expect(decrypted).toBe(plaintext)
  })

  it('rejects wrong password', () => {
    const plaintext = 'hello world'
    const encrypted = encrypt(plaintext, 'correct-password')

    expect(() => decrypt(encrypted, 'wrong-password')).toThrow()
  })

  it('rejects tampered ciphertext', () => {
    const plaintext = 'hello world'
    const encrypted = encrypt(plaintext, 'password')

    encrypted.ciphertext = encrypted.ciphertext.slice(0, -4) + 'zzzz'
    expect(() => decrypt(encrypted, 'password')).toThrow()
  })
})

describe('connections', () => {
  it('saves and lists connections without leaking credentials', async () => {
    const conn = await saveGoogleConnection(db, {
      account: 'john@example.com',
      tokens: {
        accessToken: 'access-xyz',
        refreshToken: 'refresh-xyz',
        expiresAt: Date.now() + 3600_000,
      },
      scopes: ['calendar.readonly', 'email'],
    })

    expect(conn.provider).toBe('google')
    expect(conn.account).toBe('john@example.com')
    expect(conn.scopes).toBe('calendar.readonly email')
    expect(conn).not.toHaveProperty('credentials')

    const listed = await listConnections(db)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.provider).toBe('google')
    expect(listed[0]).not.toHaveProperty('credentials')
  })

  it('upserts on provider+account', async () => {
    await saveGoogleConnection(db, {
      account: 'john@example.com',
      tokens: {
        accessToken: 'access-v1',
        refreshToken: 'refresh-v1',
        expiresAt: Date.now() + 3600_000,
      },
      scopes: ['calendar.readonly'],
    })

    await saveGoogleConnection(db, {
      account: 'john@example.com',
      tokens: {
        accessToken: 'access-v2',
        refreshToken: 'refresh-v2',
        expiresAt: Date.now() + 3600_000,
      },
      scopes: ['calendar.readonly', 'email'],
    })

    const listed = await listConnections(db)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.scopes).toBe('calendar.readonly email')
  })

  it('case-insensitively matches account emails', async () => {
    const conn1 = await saveGoogleConnection(db, {
      account: 'John@Example.Com',
      tokens: {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: Date.now() + 3600_000,
      },
      scopes: ['calendar.readonly'],
    })

    await saveGoogleConnection(db, {
      account: 'john@example.com',
      tokens: {
        accessToken: 'access-2',
        refreshToken: 'refresh-2',
        expiresAt: Date.now() + 3600_000,
      },
      scopes: ['calendar.readonly'],
    })

    const listed = await listConnections(db)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.account).toBe(conn1.account)
  })

  it('refuses invalid email', async () => {
    await expect(
      saveGoogleConnection(db, {
        account: 'not-an-email',
        tokens: {
          accessToken: 'access',
          refreshToken: null,
          expiresAt: null,
        },
        scopes: [],
      }),
    ).rejects.toThrow(ValidationError)
  })

  it('gets a connection by id', async () => {
    const saved = await saveGoogleConnection(db, {
      account: 'john@example.com',
      tokens: {
        accessToken: 'access-xyz',
        refreshToken: 'refresh-xyz',
        expiresAt: Date.now() + 3600_000,
      },
      scopes: ['calendar.readonly'],
    })

    const fetched = await getConnection(db, saved.id)
    expect(fetched.provider).toBe('google')
    expect(fetched.account).toBe('john@example.com')
  })

  it('deletes a connection', async () => {
    const saved = await saveGoogleConnection(db, {
      account: 'john@example.com',
      tokens: {
        accessToken: 'access-xyz',
        refreshToken: 'refresh-xyz',
        expiresAt: Date.now() + 3600_000,
      },
      scopes: ['calendar.readonly'],
    })

    await deleteConnection(db, saved.id)

    const listed = await listConnections(db)
    expect(listed).toHaveLength(0)
  })
})

describe('accessTokenFor', () => {
  it('returns a valid token', async () => {
    const expiresAt = Date.now() + 3600_000
    const conn = await saveGoogleConnection(db, {
      account: 'john@example.com',
      tokens: {
        accessToken: 'access-xyz',
        refreshToken: 'refresh-xyz',
        expiresAt,
      },
      scopes: ['calendar.readonly'],
    })

    const token = await accessTokenFor(db, conn.id)
    expect(token).toBe('access-xyz')
  })

  it('refreshes an expired token', async () => {
    const conn = await saveGoogleConnection(db, {
      account: 'john@example.com',
      tokens: {
        accessToken: 'access-old',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() - 1000, // Expired
      },
      scopes: ['calendar.readonly'],
    })

    const newTokens = {
      accessToken: 'access-new',
      refreshToken: 'refresh-token-new',
      expiresAt: Date.now() + 3600_000,
    }

    const token = await accessTokenFor(db, conn.id, {
      refreshToken: async () => newTokens,
    })

    expect(token).toBe('access-new')

    // Verify it was persisted
    const fetched = await getConnection(db, conn.id)
    expect(fetched.lastError).toBeNull()
  })

  it('records errors when refresh fails', async () => {
    const conn = await saveGoogleConnection(db, {
      account: 'john@example.com',
      tokens: {
        accessToken: 'access-old',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() - 1000,
      },
      scopes: ['calendar.readonly'],
    })

    await expect(
      accessTokenFor(db, conn.id, {
        refreshToken: async () => {
          throw new Error('Network error')
        },
      }),
    ).rejects.toThrow('Network error')

    const fetched = await getConnection(db, conn.id)
    expect(fetched.lastError).toContain('Network error')
  })

  it('clears lastError on successful refresh', async () => {
    const conn = await saveGoogleConnection(db, {
      account: 'john@example.com',
      tokens: {
        accessToken: 'access-old',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() - 1000,
      },
      scopes: ['calendar.readonly'],
    })
    await accessTokenFor(db, conn.id, {
      refreshToken: async () => {
        throw new Error('Previous error')
      },
    }).catch(() => {})
    expect((await getConnection(db, conn.id)).lastError).toBe('Previous error')

    const newTokens = {
      accessToken: 'access-new',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
    }

    await accessTokenFor(db, conn.id, {
      refreshToken: async () => newTokens,
    })

    const fetched = await getConnection(db, conn.id)
    expect(fetched.lastError).toBeNull()
  })
})

describe('refresh tokens', () => {
  const expired = { accessToken: 'access-old', refreshToken: 'refresh-kept', expiresAt: Date.now() - 1000 }

  it('keeps the refresh token when a refresh does not repeat it', async () => {
    const conn = await saveGoogleConnection(db, {
      account: 'john@example.com',
      tokens: expired,
      scopes: ['calendar.readonly'],
    })

    // What Google sends: a new access token and no refresh token, expiring at once here.
    await accessTokenFor(db, conn.id, {
      refreshToken: async () => ({ accessToken: 'access-2', refreshToken: null, expiresAt: Date.now() - 1 }),
    })

    const seen: string[] = []
    const token = await accessTokenFor(db, conn.id, {
      refreshToken: async (refresh) => {
        seen.push(refresh)
        return { accessToken: 'access-3', refreshToken: null, expiresAt: Date.now() + 3600_000 }
      },
    })

    expect(seen).toEqual(['refresh-kept'])
    expect(token).toBe('access-3')
    expect(await accessTokenFor(db, conn.id)).toBe('access-3')
  })

  it('keeps the refresh token when the account is connected again without one', async () => {
    const conn = await saveGoogleConnection(db, {
      account: 'john@example.com',
      tokens: { accessToken: 'a1', refreshToken: 'refresh-kept', expiresAt: Date.now() + 3600_000 },
      scopes: ['calendar.readonly'],
    })
    await saveGoogleConnection(db, {
      account: 'John@Example.com',
      tokens: { accessToken: 'a2', refreshToken: null, expiresAt: Date.now() - 1000 },
      scopes: ['calendar.readonly'],
    })

    const seen: string[] = []
    await accessTokenFor(db, conn.id, {
      refreshToken: async (refresh) => {
        seen.push(refresh)
        return { accessToken: 'a3', refreshToken: null, expiresAt: Date.now() + 3600_000 }
      },
    })
    expect(seen).toEqual(['refresh-kept'])
  })

  it('says so on the connection when there is no refresh token to use', async () => {
    const conn = await saveGoogleConnection(db, {
      account: 'john@example.com',
      tokens: { accessToken: 'a1', refreshToken: null, expiresAt: Date.now() - 1000 },
      scopes: ['calendar.readonly'],
    })

    await expect(accessTokenFor(db, conn.id)).rejects.toBeInstanceOf(ConnectionError)
    expect((await getConnection(db, conn.id)).lastError).toContain('Connect this account again')
  })

  it('says so on the connection when the stored credentials cannot be read', async () => {
    const conn = await saveGoogleConnection(db, {
      account: 'john@example.com',
      tokens: { accessToken: 'a1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
      scopes: ['calendar.readonly'],
    })

    const key = process.env.SESSION_SECRET
    process.env.SESSION_SECRET = 'a-different-secret-than-the-one-that-encrypted-it'
    try {
      await expect(accessTokenFor(db, conn.id)).rejects.toBeInstanceOf(ConnectionError)
    } finally {
      process.env.SESSION_SECRET = key
    }
    expect((await getConnection(db, conn.id)).lastError).toContain('cannot be read')
  })

  it('refuses an unknown connection by name', async () => {
    const missing = '00000000-0000-4000-8000-000000000000'
    await expect(getConnection(db, missing)).rejects.toBeInstanceOf(NotFoundError)
    await expect(accessTokenFor(db, missing)).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('listCalendars', () => {
  const live = { accessToken: 'a1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 }
  const calendars: CalendarInfo[] = [{ id: 'primary', name: 'John', primary: true }]

  it('records a failure on the connection and clears it on the next success', async () => {
    const conn = await saveGoogleConnection(db, {
      account: 'john@example.com',
      tokens: live,
      scopes: ['calendar.readonly'],
    })

    await expect(
      listCalendars(db, conn.id, {
        fetchCalendars: async () => {
          throw new Error('Google calendar list failed: 403')
        },
      }),
    ).rejects.toThrow('403')
    expect((await getConnection(db, conn.id)).lastError).toContain('403')

    expect(await listCalendars(db, conn.id, { fetchCalendars: async () => calendars })).toEqual(calendars)
    expect((await getConnection(db, conn.id)).lastError).toBeNull()
  })
})

describe('a token Google stops honouring early', () => {
  const live = { accessToken: 'revoked', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 }

  it('is refreshed once and the call made again', async () => {
    const conn = await saveGoogleConnection(db, {
      account: 'john@example.com',
      tokens: live,
      scopes: ['calendar.readonly'],
    })
    const used: string[] = []
    let refreshes = 0

    const calendars = await listCalendars(db, conn.id, {
      fetchCalendars: async (token) => {
        used.push(token)
        if (token === 'revoked') throw new GoogleUnauthorized()
        return [{ id: 'primary', name: 'John', primary: true }]
      },
      refreshToken: async () => {
        refreshes++
        return { accessToken: 'fresh', refreshToken: null, expiresAt: Date.now() + 3600_000 }
      },
    })

    expect(calendars).toHaveLength(1)
    expect(used).toEqual(['revoked', 'fresh'])
    expect(refreshes).toBe(1)
    expect(await accessTokenFor(db, conn.id)).toBe('fresh')
    expect((await getConnection(db, conn.id)).lastError).toBeNull()
  })

  it('says to connect again when the fresh token is refused too', async () => {
    const conn = await saveGoogleConnection(db, {
      account: 'john@example.com',
      tokens: live,
      scopes: ['calendar.readonly'],
    })
    let calls = 0

    await expect(
      listCalendars(db, conn.id, {
        fetchCalendars: async () => {
          calls++
          throw new GoogleUnauthorized()
        },
        refreshToken: async () => ({ accessToken: 'fresh', refreshToken: null, expiresAt: Date.now() + 3600_000 }),
      }),
    ).rejects.toBeInstanceOf(GoogleUnauthorized)
    expect(calls).toBe(2)
    expect((await getConnection(db, conn.id)).lastError).toContain('Connect this account again')
  })
})

describe('bindings', () => {
  it('moves a calendar in place, never leaving two bindings', async () => {
    const work = await createContext(db, { name: 'Work' })
    const home = await createContext(db, { name: 'Home' })
    const conn = await saveGoogleConnection(db, {
      account: 'john@example.com',
      tokens: { accessToken: 'access', refreshToken: null, expiresAt: null },
      scopes: ['calendar.readonly'],
    })
    const input = { connectionId: conn.id, calendarId: 'cal1', name: 'Calendar 1' }

    const first = await bindCalendar(db, { ...input, contextId: work.id })
    const [second, third] = await Promise.all([
      bindCalendar(db, { ...input, contextId: home.id }),
      bindCalendar(db, { ...input, name: 'Renamed', contextId: home.id }),
    ])

    const all = await listBindings(db)
    expect(all).toHaveLength(1)
    expect(all[0]?.contextId).toBe(home.id)
    expect(new Set([first.id, second.id, third.id]).size).toBe(1)
  })

  it('refuses a context or a connection that does not exist', async () => {
    const ctx = await createContext(db, { name: 'Work' })
    const conn = await saveGoogleConnection(db, {
      account: 'john@example.com',
      tokens: { accessToken: 'access', refreshToken: null, expiresAt: null },
      scopes: ['calendar.readonly'],
    })
    const missing = '00000000-0000-4000-8000-000000000000'

    await expect(
      bindCalendar(db, { connectionId: conn.id, calendarId: 'cal1', name: 'C', contextId: missing }),
    ).rejects.toBeInstanceOf(NotFoundError)
    await expect(
      bindCalendar(db, { connectionId: missing, calendarId: 'cal1', name: 'C', contextId: ctx.id }),
    ).rejects.toBeInstanceOf(NotFoundError)
    await expect(
      bindCalendar(db, { connectionId: conn.id, calendarId: ' ', name: 'C', contextId: ctx.id }),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(await listBindings(db)).toHaveLength(0)
  })

  it('drops the bindings of a deleted connection', async () => {
    const ctx = await createContext(db, { name: 'Work' })
    const conn = await saveGoogleConnection(db, {
      account: 'john@example.com',
      tokens: { accessToken: 'access', refreshToken: null, expiresAt: null },
      scopes: ['calendar.readonly'],
    })
    await bindCalendar(db, { connectionId: conn.id, calendarId: 'cal1', name: 'C', contextId: ctx.id })

    await deleteConnection(db, conn.id)
    expect(await listBindings(db)).toHaveLength(0)
  })

  it('binds a calendar to a context', async () => {
    const ctx = await createContext(db, { name: 'Work' })
    const conn = await saveGoogleConnection(db, {
      account: 'john@example.com',
      tokens: {
        accessToken: 'access',
        refreshToken: null,
        expiresAt: null,
      },
      scopes: ['calendar.readonly'],
    })

    const binding = await bindCalendar(db, {
      connectionId: conn.id,
      calendarId: 'john@google.com',
      name: 'John Calendar',
      contextId: ctx.id,
    })

    expect(binding.kind).toBe('calendar')
    expect(binding.externalId).toBe('john@google.com')
    expect(binding.contextId).toBe(ctx.id)
  })

  it('lists bindings for a context', async () => {
    const ctx = await createContext(db, { name: 'Work' })
    const conn = await saveGoogleConnection(db, {
      account: 'john@example.com',
      tokens: {
        accessToken: 'access',
        refreshToken: null,
        expiresAt: null,
      },
      scopes: ['calendar.readonly'],
    })

    await bindCalendar(db, {
      connectionId: conn.id,
      calendarId: 'cal1',
      name: 'Calendar 1',
      contextId: ctx.id,
    })

    await bindCalendar(db, {
      connectionId: conn.id,
      calendarId: 'cal2',
      name: 'Calendar 2',
      contextId: ctx.id,
    })

    const bindings = await listBindings(db, { contextId: ctx.id })
    expect(bindings).toHaveLength(2)
  })

  it('rebinds a calendar to a different context', async () => {
    const ctx1 = await createContext(db, { name: 'Work' })
    const ctx2 = await createContext(db, { name: 'Personal' })
    const conn = await saveGoogleConnection(db, {
      account: 'john@example.com',
      tokens: {
        accessToken: 'access',
        refreshToken: null,
        expiresAt: null,
      },
      scopes: ['calendar.readonly'],
    })

    await bindCalendar(db, {
      connectionId: conn.id,
      calendarId: 'cal1',
      name: 'Calendar 1',
      contextId: ctx1.id,
    })

    const binding2 = await bindCalendar(db, {
      connectionId: conn.id,
      calendarId: 'cal1',
      name: 'Calendar 1',
      contextId: ctx2.id,
    })

    const bindings1 = await listBindings(db, { contextId: ctx1.id })
    expect(bindings1).toHaveLength(0)

    const bindings2 = await listBindings(db, { contextId: ctx2.id })
    expect(bindings2).toHaveLength(1)
    expect(bindings2[0]?.id).toBe(binding2.id)
  })

  it('unbinds a calendar', async () => {
    const ctx = await createContext(db, { name: 'Work' })
    const conn = await saveGoogleConnection(db, {
      account: 'john@example.com',
      tokens: {
        accessToken: 'access',
        refreshToken: null,
        expiresAt: null,
      },
      scopes: ['calendar.readonly'],
    })

    const binding = await bindCalendar(db, {
      connectionId: conn.id,
      calendarId: 'cal1',
      name: 'Calendar 1',
      contextId: ctx.id,
    })

    await unbindCalendar(db, binding.id)

    const bindings = await listBindings(db, { contextId: ctx.id })
    expect(bindings).toHaveLength(0)
  })
})

describe('googleConfigured', () => {
  it('returns true when env vars are set', () => {
    process.env.GOOGLE_CLIENT_ID = 'id'
    process.env.GOOGLE_CLIENT_SECRET = 'secret'
    expect(googleConfigured()).toBe(true)

    delete process.env.GOOGLE_CLIENT_ID
    expect(googleConfigured()).toBe(false)

    process.env.GOOGLE_CLIENT_ID = 'id'
    delete process.env.GOOGLE_CLIENT_SECRET
    expect(googleConfigured()).toBe(false)
  })
})
