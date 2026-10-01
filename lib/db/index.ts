import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

type Db = ReturnType<typeof drizzle<typeof schema>>

/*
 * One pool, created on first use rather than at import: `next build` evaluates
 * page modules with no DATABASE_URL in the environment.
 *
 * It hangs off globalThis because Next re-evaluates modules on hot reload and
 * compiles this file once per server layer; a module-level pool would be one
 * pool per copy.
 */
const globalForDb = globalThis as unknown as { mm?: { sql: postgres.Sql; db: Db } }

function connect(): { sql: postgres.Sql; db: Db } {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')

  const sql = postgres(url, { max: 10 })
  return { sql, db: drizzle(sql, { schema }) }
}

function instance(): { sql: postgres.Sql; db: Db } {
  return (globalForDb.mm ??= connect())
}

/* A proxy so callers can `import { db }` directly. Methods are bound to the
   real instance because drizzle's builders rely on `this`. */
export const db: Db = new Proxy({} as Db, {
  get(_target, property) {
    const value = Reflect.get(instance().db, property)
    return typeof value === 'function' ? value.bind(instance().db) : value
  },
})

/** The raw client, for the rare query drizzle should not shape. */
export function sqlClient(): postgres.Sql {
  return instance().sql
}
