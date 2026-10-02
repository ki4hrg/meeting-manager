/*
 * The jobs themselves, and the three things the rest of the app does with them.
 *
 * The lock keys are assigned by hand and must stay stable. They are what stops
 * two app containers running the same job at the same moment, so renumbering
 * during a rolling deploy would let the old and new containers both run it for
 * the length of the overlap.
 */

import { extractorFromEnv } from '../processing/extract'
import {
  registerJob as register,
  registeredJobs,
  runJob,
  startScheduler,
  type Job,
  type JobRun,
} from './scheduler'

export type { Job, JobRun } from './scheduler'
export { lastRun } from './scheduler'

export const PROCESS_NOTES = 'process-notes'

/*
 * Every queued processing run, oldest first.
 *
 * A minute, and the interval is the safety net rather than the path: whatever
 * queues a run also calls `kick(PROCESS_NOTES)`, so a note is normally picked
 * up at once. The timer is for a run queued while the container was
 * restarting, or one whose kick was lost.
 */
const processNotes: Job = {
  name: PROCESS_NOTES,
  everyMs: 60 * 1000,
  lockKey: 200_001,
  run: async () => {
    /* Imported here, not at module scope: `instrumentation` loads this file at
       boot and the pipeline reaches most of the domain layer. */
    const { db } = await import('../db')
    const { processQueued } = await import('../processing/run')

    const { processed, failed } = await processQueued(db, extractorFromEnv())
    if (processed === 0 && failed === 0) return 'Nothing queued.'
    return failed > 0 ? `${processed} processed · ${failed} failed` : `${processed} processed`
  },
}

/** Make a job known to the scheduler. One started later still gets its timer. */
export function registerJob(job: Job) {
  register(job)
}

registerJob(processNotes)

export const GRANOLA_RECONCILE = 'granola-reconcile'

/*
 * Notes the webhook did not deliver (lib/connect/granola/reconcile.ts).
 *
 * A quarter of an hour: with a webhook this is the net, and without one (a
 * local instance, or an endpoint that could not be registered) it is how long
 * a note takes to arrive.
 */
const granolaReconcile: Job = {
  name: GRANOLA_RECONCILE,
  everyMs: 15 * 60 * 1000,
  lockKey: 200_002,
  run: async () => {
    const { db } = await import('../db')
    const { reconcileGranola, summariseReconcile } = await import('../connect/granola/reconcile')

    const result = await reconcileGranola(db)
    /* Not awaited: the runs it queued are the other job's work, and this one
       should not hold its lock while a model reads them. */
    if (result.queued > 0) void kick(PROCESS_NOTES)
    return summariseReconcile(result)
  },
}

registerJob(granolaReconcile)

/**
 * Start the timers. Called once, from `instrumentation.ts`.
 *
 * Not during `next build`, which evaluates the server's modules with no
 * database, and not under Vitest, where a test that imports anything reaching
 * here must not start a loop against its database. The runtime and `WORKER=off`
 * guards are the scheduler's own.
 */
export function startJobs(): boolean {
  if (process.env.NEXT_PHASE === 'phase-production-build') return false
  if (process.env.VITEST) return false
  return startScheduler()
}

export function jobNames(): string[] {
  return registeredJobs().map((job) => job.name)
}

/**
 * Run a job now instead of waiting for its interval.
 *
 * Safe from a server action through `after()`: it never rejects for a failed
 * run, and it cannot overlap a run in flight. If one is, this asks for one
 * more run when it finishes, so work queued a moment ago is not left for the
 * timer.
 */
export function kick(name: string): Promise<JobRun> {
  const job = registeredJobs().find((candidate) => candidate.name === name)
  if (!job) throw new Error(`No job is registered as "${name}".`)
  return runJob(job, { again: true })
}
