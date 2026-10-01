/*
 * Applied at container boot by docker-entrypoint.sh, before the server listens.
 *
 * This file is NOT part of the Next build. `output: 'standalone'` only traces
 * what the application imports, and nothing in the app imports this — so it is
 * bundled separately with esbuild into dist/migrate.cjs.
 *
 * A failed migration exits non-zero, which `set -e` in the entrypoint turns into
 * a container crash. That is deliberate: a half-migrated database should not
 * serve traffic.
 */

import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

const MIGRATIONS_FOLDER = process.env.MIGRATIONS_FOLDER ?? 'lib/db/migrations'

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set')
    process.exit(1)
  }

  // max: 1 — migrations are serial, and a pool here would outlive the process.
  const sql = postgres(url, { max: 1 })
  try {
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER })
    console.log(JSON.stringify({ level: 'info', msg: 'migrations applied' }))
  } finally {
    await sql.end()
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ level: 'error', msg: 'migration failed', err: String(err) }))
  process.exit(1)
})
