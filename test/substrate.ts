/*
 * Where the test database comes from.
 *
 * The preferred substrate is Testcontainers on postgres:18-alpine, which is
 * what CI uses and what the deployed database is. Two things in a Claude Code
 * on the web session can stop that working, and neither is a reason for a
 * developer to be unable to run the suite:
 *
 *   - `dockerd` is installed but not started at boot. The SessionStart hook in
 *     .claude/hooks/ starts it, but a session that predates the hook, or one
 *     where it failed, still lands here.
 *   - Anonymous Docker Hub pulls are rate-limited. A cold pull returns 429 and
 *     succeeds moments later, so this retries rather than giving up — a suite
 *     that dies on a rate limit is a suite people stop running.
 *
 * When Docker is genuinely unavailable, `initdb` runs a throwaway cluster
 * instead. That is Postgres 16, because apt.postgresql.org is unreachable from
 * this environment and there is no 17 to install — so CI stays the authority on
 * the version that ships, and this prints which substrate it chose so a
 * version-sensitive failure is never mistaken for a logic bug.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export type Substrate = {
  /** A superuser connection URL for the server, on the `postgres` database. */
  adminUrl: string
  describe: string
  stop: () => Promise<void>
}

const IMAGE = 'postgres:18-alpine'

export async function startSubstrate(): Promise<Substrate> {
  const container = await tryContainer()
  if (container) return container

  const local = await tryLocalCluster()
  if (local) return local

  throw new Error(
    'No Postgres available. Start Docker (the SessionStart hook does this), or install a ' +
      'local Postgres server so initdb is on PATH.',
  )
}

// ─── preferred: Testcontainers ───────────────────────────────────────────────

async function tryContainer(): Promise<Substrate | null> {
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql')

  /* Two attempts, because the failure this guards against is a rate limit that
     clears in seconds. A third would just be waiting on a wall. */
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const started = await new PostgreSqlContainer(IMAGE).start()
      announce(`Testcontainers ${IMAGE}`)
      return {
        adminUrl: started.getConnectionUri(),
        describe: IMAGE,
        stop: () => started.stop().then(() => undefined),
      }
    } catch (err) {
      const message = String(err)
      const rateLimited = message.includes('429') || message.includes('Too Many Requests')
      if (attempt === 1 && rateLimited) {
        console.warn('  postgres image pull was rate-limited; retrying once…')
        await new Promise((resolve) => setTimeout(resolve, 5_000))
        continue
      }
      console.warn(`  Docker unavailable (${firstLine(message)}); falling back to a local cluster.`)
      return null
    }
  }
  return null
}

// ─── fallback: a throwaway local cluster ─────────────────────────────────────

async function tryLocalCluster(): Promise<Substrate | null> {
  const bin = await findPgBin()
  if (!bin) return null

  /*
   * `initdb` refuses to run as root, and this environment is root. When there
   * is a `postgres` account, drop to it and put the cluster somewhere that
   * account can actually write — its own home. /tmp is not that place: the
   * scratchpad is mode 700 under another uid, and initdb fails with a
   * permission error that reads like a bug in this file.
   */
  const asUser = process.getuid?.() === 0 ? await postgresUser() : null
  if (process.getuid?.() === 0 && !asUser) {
    console.warn('  running as root with no postgres account; cannot initdb.')
    return null
  }

  const dir = asUser
    ? join('/var/lib/postgresql', `mm-test-${process.pid}`)
    : await mkdtemp(join(tmpdir(), 'mm-pg-'))
  const port = 5000 + (process.pid % 10_000)

  const sh = async (command: string) => {
    const wrapped = asUser ? ['su', asUser, '-c', command] : ['sh', '-c', command]
    await run(wrapped[0]!, wrapped.slice(1))
  }

  try {
    if (asUser) {
      await run('mkdir', ['-p', dir])
      await run('chown', [`${asUser}:${asUser}`, dir])
    }
    await sh(`${bin}/initdb -D ${dir} -U postgres --auth=trust`)
    await sh(
      `${bin}/pg_ctl -D ${dir} -o '-p ${port} -c listen_addresses=127.0.0.1' -l ${dir}/pg.log -w start`,
    )
  } catch (err) {
    console.warn(`  local cluster failed to start: ${firstLine(String(err))}`)
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    return null
  }

  const version = await clusterVersion(bin)
  announce(`local cluster, PostgreSQL ${version} (CI runs ${IMAGE})`)

  return {
    adminUrl: `postgres://postgres@127.0.0.1:${port}/postgres`,
    describe: `local PostgreSQL ${version}`,
    stop: async () => {
      await sh(`${bin}/pg_ctl -D ${dir} -m immediate stop`).catch(() => {})
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    },
  }
}

async function findPgBin(): Promise<string | null> {
  try {
    const { stdout } = await run('sh', ['-c', 'command -v initdb'])
    return stdout.trim().replace(/\/initdb$/, '')
  } catch {
    /* Debian and Ubuntu put the server binaries outside PATH, one directory per
       major version. Take the highest. */
    try {
      const { stdout } = await run('sh', ['-c', 'ls -1 /usr/lib/postgresql 2>/dev/null | sort -rn'])
      const major = stdout.trim().split('\n')[0]
      return major ? `/usr/lib/postgresql/${major}/bin` : null
    } catch {
      return null
    }
  }
}

async function postgresUser(): Promise<string | null> {
  try {
    await run('id', ['postgres'])
    return 'postgres'
  } catch {
    return null
  }
}

async function clusterVersion(bin: string): Promise<string> {
  try {
    /* `postgres --version` prints "postgres (PostgreSQL) 16.13 (Ubuntu …)", so
       take the version after the parenthesised product name rather than the
       last whitespace-delimited token — which is the packaging string. */
    const { stdout } = await run(`${bin}/postgres`, ['--version'])
    return /\(PostgreSQL\)\s+(\S+)/.exec(stdout)?.[1] ?? stdout.trim()
  } catch {
    return 'unknown'
  }
}

function firstLine(message: string): string {
  return message.split('\n')[0]!.slice(0, 160)
}

function announce(what: string): void {
  console.log(`\n  test database: ${what}\n`)
}
