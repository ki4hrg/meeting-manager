/*
 * One database server for the whole run, whatever it turns out to be
 * (test/substrate.ts), with the real migrations applied once to a template
 * database. Each test file then clones that template into a database of its own
 * (test/helpers/db.ts), which is what makes files independent — they run in
 * parallel and one file's truncation cannot delete another file's fixtures.
 *
 * Applying the real migrations rather than pushing the schema is deliberate:
 * every run also proves the migration chain still builds a working database,
 * which is the thing the container does at boot.
 */

import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import type { TestProject } from 'vitest/node'
import { startSubstrate, type Substrate } from './substrate'

export const TEMPLATE_DB = 'mm_template'

let substrate: Substrate | undefined

export async function setup(project: TestProject) {
  substrate = await startSubstrate()
  const adminUrl = substrate.adminUrl

  /* `onnotice` silenced: `drop database if exists` on a fresh server emits a
     NOTICE, and a run that opens with a Postgres notice block reads like
     something went wrong. */
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
  try {
    /* Dropped first because the local-cluster fallback reuses a data directory
       across runs when a previous run was killed before teardown. */
    await admin.unsafe(`drop database if exists "${TEMPLATE_DB}"`)
    await admin.unsafe(`create database "${TEMPLATE_DB}"`)
  } finally {
    await admin.end()
  }

  const templateUrl = new URL(adminUrl)
  templateUrl.pathname = `/${TEMPLATE_DB}`

  const sql = postgres(templateUrl.toString(), { max: 1 })
  try {
    await migrate(drizzle(sql), { migrationsFolder: 'lib/db/migrations' })
  } finally {
    // The connection has to be closed before anything can clone the template:
    // CREATE DATABASE ... TEMPLATE refuses while another session is attached.
    await sql.end()
  }

  // globalSetup runs in its own process, so mutating process.env would not reach
  // the test workers. provide/inject is the supported channel.
  project.provide('adminDatabaseUrl', adminUrl)
  project.provide('substrate', substrate.describe)
}

export async function teardown() {
  await substrate?.stop()
}

declare module 'vitest' {
  interface ProvidedContext {
    adminDatabaseUrl: string
    substrate: string
  }
}
