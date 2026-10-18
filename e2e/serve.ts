/*
 * The app the browser tests run against: a fresh Postgres (the same substrate
 * the unit tests use), the real migrations, a small seeded world (`seed.ts`),
 * then `next dev` on its own port and build folder, so it can run beside a
 * developer's server in the same checkout. Started and stopped by Playwright
 * (`webServer` in playwright.config.ts).
 */

import { spawn } from 'node:child_process'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { startSubstrate } from '../test/substrate'
import { TODOIST_PORT, TODOIST_TOKEN, startTodoist } from './todoist'
import { E2E_PORT } from './world'

const substrate = await startSubstrate()
const admin = postgres(substrate.adminUrl, { max: 1, onnotice: () => {} })
await admin.unsafe('drop database if exists mm_e2e')
await admin.unsafe('create database mm_e2e')
await admin.end()

const url = new URL(substrate.adminUrl)
url.pathname = '/mm_e2e'
const databaseUrl = url.toString()
const sql = postgres(databaseUrl, { max: 1 })
await migrate(drizzle(sql), { migrationsFolder: 'lib/db/migrations' })
await sql.end()

const SESSION_SECRET = 'e2e-only-session-secret-not-used-anywhere-real-0123456789'
const todoist = {
  TODOIST_API_BASE: `http://localhost:${TODOIST_PORT}`,
  TODOIST_CLIENT_ID: 'e2e-client',
  TODOIST_CLIENT_SECRET: 'e2e-secret',
}
const stopTodoist = await startTodoist()

// lib/db reads DATABASE_URL when first used, so the seed goes to this database.
process.env.DATABASE_URL = databaseUrl
// The seed connects Todoist: its token is sealed with the server's secret, against the fake.
process.env.SESSION_SECRET = SESSION_SECRET
Object.assign(process.env, todoist)
const { seed } = await import('./seed')
await seed({ todoistToken: TODOIST_TOKEN })

const server = spawn('pnpm', ['exec', 'next', 'dev', '--port', String(E2E_PORT)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl,
    SESSION_SECRET,
    ...todoist,
    PUBLIC_BASE_URL: `http://localhost:${E2E_PORT}`,
    NEXT_DIST_DIR: '.next-e2e',
    // No timers: what a test needs processed is kicked by the action that queues it.
    WORKER: 'off',
    TZ: 'America/Chicago',
    ANTHROPIC_API_KEY: '',
  },
})

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  server.kill('SIGTERM')
  stopTodoist()
  await substrate.stop().catch(() => {})
  process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
server.on('exit', stop)
