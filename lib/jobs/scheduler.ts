/*
 * Background work, without a broker or a second service. Lifted from Meeter.
 *
 * A timer in the Next server process, and every guard is a failure somebody hit:
 *
 *   `NEXT_RUNTIME !== 'nodejs'`: Edge has no usable timers and no database.
 *   `WORKER=off`: a one-off `next start` against production to look at
 *     something must not also start processing notes.
 *   No import-time database work: `next build` evaluates this module and has
 *     no DATABASE_URL.
 *   State on `globalThis`: a dev hot reload re-evaluates the module and would
 *     otherwise leave two loops running.
 *
 * Then `timer.unref()`, so a shutdown does not wait out the interval, and two
 * things that stop a job overlapping itself: an in-process record of what is
 * running, and a `pg_try_advisory_lock` per job so two app containers behind a
 * proxy cannot run it at once. The lock is *try* rather than blocking: a second
 * container should skip this tick, not queue behind the first.
 */

import { sqlClient } from '../db'
import { processMap } from '../process-state'

export type JobRun = {
  startedAt: Date
  finishedAt: Date | null
  /** What the job wants a screen to say. Its own sentence, not a template. */
  summary: string | null
  error: string | null
  /** It did not run, because it was already running. */
  skipped?: boolean
}

export type Job = {
  name: string
  everyMs: number
  /**
   * A stable key for `pg_try_advisory_lock`. Assigned by hand rather than
   * hashed from the name, so two jobs cannot collide and renaming a job does
   * not change which lock it takes.
   */
  lockKey: number
  run: () => Promise<string>
}

/*
 * All of it through `globalThis` (lib/process-state.ts): `instrumentation` and
 * a server action are compiled into different layers, each with its own copy
 * of this module. A module-local Map would let the action start a run the
 * timer's copy knows nothing about.
 */
const registered = processMap<Job>('jobs')
const runs = processMap<JobRun>('job-runs')
const inFlight = processMap<Promise<JobRun>>('job-in-flight')
const wanted = processMap<boolean>('job-wanted-again')
const timers = processMap<ReturnType<typeof setInterval>>('job-timers')
const state = processMap<boolean>('job-scheduler')

export function lastRun(name: string): JobRun | undefined {
  return runs.get(name)
}

export function registeredJobs(): Job[] {
  return [...registered.values()]
}

async function underLock(job: Job, startedAt: Date): Promise<JobRun> {
  /*
   * A reserved connection, and that is the subtlety here.
   * `pg_try_advisory_lock` is session-scoped, and postgres-js hands out a
   * pooled connection per query, so taking the lock on one and releasing it on
   * whichever came next would leak it and wedge the job after its first run.
   * Reserving pins one session for the job's lifetime. It also means a
   * container killed mid-run drops its connection and Postgres releases the
   * lock with it: nothing to clear by hand.
   */
  const reserved = await sqlClient().reserve()
  try {
    const [lock] = await reserved<{ locked: boolean }[]>`
      select pg_try_advisory_lock(${job.lockKey}) as locked`

    if (!lock?.locked) {
      return {
        startedAt,
        finishedAt: new Date(),
        summary: 'Skipped: already running elsewhere.',
        error: null,
        skipped: true,
      }
    }

    try {
      const summary = await job.run()
      return { startedAt, finishedAt: new Date(), summary, error: null }
    } finally {
      await reserved`select pg_advisory_unlock(${job.lockKey})`
    }
  } finally {
    reserved.release()
  }
}

/**
 * Run a job once. Never rejects: a failure is recorded on the run.
 *
 * `again` is for a caller who has just made work for the job (a note was
 * queued). If the job is mid-run it may already have read its queue, so
 * instead of being dropped the request makes it run once more when it
 * finishes. The timer does not ask for this; its next tick is its second try.
 */
export function runJob(job: Job, opts: { again?: boolean } = {}): Promise<JobRun> {
  const running = inFlight.get(job.name)
  if (running) {
    if (opts.again) wanted.set(job.name, true)
    return Promise.resolve({
      startedAt: new Date(),
      finishedAt: new Date(),
      summary: 'Skipped: already running.',
      error: null,
      skipped: true,
    })
  }

  const startedAt = new Date()
  runs.set(job.name, { startedAt, finishedAt: null, summary: null, error: null })

  const promise = underLock(job, startedAt)
    .catch((err): JobRun => {
      /* Caught rather than propagated: an unhandled rejection inside a timer
         takes down the Node process, and one failing job would take the whole
         application with it. */
      console.error(`[jobs] ${job.name} failed:`, err)
      const message = err instanceof Error ? err.message : String(err)
      return { startedAt, finishedAt: new Date(), summary: null, error: message }
    })
    .then((run) => {
      runs.set(job.name, run)
      inFlight.delete(job.name)
      if (wanted.delete(job.name)) void runJob(registered.get(job.name) ?? job)
      return run
    })

  inFlight.set(job.name, promise)
  return promise
}

function schedule(job: Job) {
  if (timers.has(job.name)) return

  const timer = setInterval(() => {
    /* Looked up by name at each tick, so a hot reload that registers the job
       again runs the new code on the old timer. */
    void runJob(registered.get(job.name) ?? job)
  }, job.everyMs)

  /* So `SIGTERM` during a deploy does not wait out the interval. */
  timer.unref()
  timers.set(job.name, timer)
}

/** Make a job known. Safe to call again with the same name; the newer one wins. */
export function registerJob(job: Job) {
  registered.set(job.name, job)
  if (state.get('started')) schedule(job)
}

/**
 * Start the loop for every registered job. Idempotent, and a no-op wherever it
 * should not run. Returns whether it started, so `instrumentation.ts` can say
 * so in the log.
 */
export function startScheduler(): boolean {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return false
  if (process.env.WORKER === 'off') return false
  if (state.get('started')) return false

  state.set('started', true)
  for (const job of registered.values()) schedule(job)
  return true
}

/** Clears every timer. For tests; the server never stops its loop. */
export function stopScheduler() {
  for (const timer of timers.values()) clearInterval(timer)
  timers.clear()
  state.delete('started')
}
