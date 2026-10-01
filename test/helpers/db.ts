/*
 * A database per test file, cloned from the migrated template in test/setup.ts.
 *
 * Vitest isolates modules per test file, so this module runs once per file and
 * the name below is unique to it. That is the isolation boundary: it is what
 * lets files run in parallel, because one file truncating its own tables cannot
 * delete another file's fixtures.
 *
 * Within a file, tests are separated by truncation rather than by an outer
 * rollback, because the domain layer opens its own transactions and nesting
 * those inside an outer rollback turns every real COMMIT into a savepoint
 * release.
 */

import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeEach, inject } from 'vitest'
import * as schema from '../../lib/db/schema'
import { TEMPLATE_DB } from '../setup'

export type Db = PostgresJsDatabase<typeof schema>

const adminUrl = inject('adminDatabaseUrl')
const dbName = `test_${randomUUID().replaceAll('-', '')}`

const admin = postgres(adminUrl, { max: 1 })
try {
  await admin.unsafe(`create database "${dbName}" template "${TEMPLATE_DB}"`)
} finally {
  await admin.end()
}

const url = new URL(adminUrl)
url.pathname = `/${dbName}`

/**
 * This file's database, as a URL.
 *
 * For the tests that exercise a Route Handler rather than the module under it:
 * those import `@/lib/db`, which reads DATABASE_URL on first use. A test that
 * sets this before the first query gets the same isolated database everything
 * else in the file is using, instead of whatever the developer happens to have
 * running.
 */
export const databaseUrl = url.toString()

const client = postgres(databaseUrl, { max: 4 })
export const db: Db = drizzle(client, { schema })

/* Discovered rather than listed, so a new table cannot silently start leaking
   rows between tests. */
let cached: string[] | null = null

async function tableNames(): Promise<string[]> {
  const rows = await db.execute(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  )
  /*
   * `public` only, which excludes Drizzle's own journal — it lives in a
   * `drizzle` schema of its own. Worth knowing rather than assuming: a database
   * whose public tables are dropped while that journal survives looks fully
   * migrated to the migrator and completely empty to the app, which presents as
   * every page 500ing with "relation does not exist".
   */
  return [...rows].map((r) => (r as { tablename: string }).tablename)
}

/*
 * What the migrations put there, captured before any test could touch it, and
 * put back after each truncation. Nothing is seeded today; this keeps reference
 * data a future migration inserts from being truncated away, without a list.
 */
type Seeded = { table: string; rows: unknown[] }
let seeded: Seeded[] | null = null

async function captureSeed(tables: string[]): Promise<Seeded[]> {
  const captured: Seeded[] = []
  for (const table of tables) {
    const rows = await db.execute(sql`select * from ${sql.identifier(table)}`)
    if (rows.length > 0) captured.push({ table, rows: [...rows] })
  }
  return captured
}

/* Through the table's own row type rather than a generated column list, so a
   column added later needs no change here — and so timestamps and arrays are
   parsed by Postgres rather than by string concatenation. */
async function restoreSeed(captured: Seeded[]) {
  for (const { table, rows } of captured) {
    await db.execute(
      sql`insert into ${sql.identifier(table)}
          select * from json_populate_recordset(
            null::${sql.identifier(table)}, ${JSON.stringify(rows)}::json)`,
    )
  }
}

export async function resetDb() {
  cached ??= await tableNames()
  if (cached.length === 0) return

  /* Captured on the first reset, which runs before the first test body — so it
     sees the template's state rather than anything a test wrote. */
  seeded ??= await captureSeed(cached)

  await db.execute(
    sql.raw(`truncate table ${cached.map((t) => `"${t}"`).join(', ')} restart identity cascade`),
  )

  await restoreSeed(seeded)
}

/** Opt in per file: call at the top level of the test file. Not a React hook —
 *  the name deliberately avoids a `use` prefix, which rules-of-hooks would claim. */
export function resetBetweenTests() {
  beforeEach(resetDb)
}

afterAll(async () => {
  await client.end()
})
