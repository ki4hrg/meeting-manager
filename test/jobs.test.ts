/*
 * The scheduler against a real Postgres, because the thing that stops a job
 * overlapping itself across containers is an advisory lock, and a fake would
 * prove nothing about it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { databaseUrl } from './helpers/db'

/* Before anything queries: `lib/db` reads DATABASE_URL on first use. */
process.env.DATABASE_URL = databaseUrl

const { sqlClient } = await import('../lib/db')
const { jobNames, kick, lastRun, PROCESS_NOTES, registerJob, startJobs } = await import('../lib/jobs')
const { runJob, startScheduler, stopScheduler } = await import('../lib/jobs/scheduler')

type Job = import('../lib/jobs').Job

let key = 900_000

/** A job that counts its runs and can be held open, to see what happens while it is running. */
function counting(name: string, everyMs = 60_000) {
  let release: (() => void) | null = null
  const state = { runs: 0, concurrent: 0, peak: 0, hold: false }
  const job: Job = {
    name,
    everyMs,
    lockKey: (key += 1),
    run: async () => {
      state.runs += 1
      state.concurrent += 1
      state.peak = Math.max(state.peak, state.concurrent)
      if (state.hold) await new Promise<void>((resolve) => (release = resolve))
      state.concurrent -= 1
      return `run ${state.runs}`
    },
  }
  return { job, state, release: () => release?.() }
}

beforeAll(() => {
  vi.stubEnv('NEXT_RUNTIME', 'nodejs')
})

afterEach(() => {
  stopScheduler()
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await sqlClient().end()
})

describe('running a job', () => {
  it('runs it and records what it said', async () => {
    const { job, state } = counting('test-once')
    const run = await runJob(job)

    expect(state.runs).toBe(1)
    expect(run).toMatchObject({ summary: 'run 1', error: null })
    expect(run.finishedAt).toBeInstanceOf(Date)
    expect(lastRun('test-once')).toEqual(run)
  })

  it('records a failure instead of throwing', async () => {
    const silent = vi.spyOn(console, 'error').mockImplementation(() => {})
    const job: Job = {
      name: 'test-fails',
      everyMs: 60_000,
      lockKey: (key += 1),
      run: async () => {
        throw new Error('the model is down')
      },
    }

    const run = await runJob(job)
    expect(run).toMatchObject({ summary: null, error: 'the model is down' })
    silent.mockRestore()

    /* The lock was released on the way out: the next run is not skipped. */
    const again = await runJob({ ...job, run: async () => 'recovered' })
    expect(again.summary).toBe('recovered')
    expect(again.skipped).toBeUndefined()
  })

  it('does not overlap itself in one process', async () => {
    const { job, state, release } = counting('test-overlap')
    state.hold = true

    const first = runJob(job)
    await vi.waitFor(() => expect(state.concurrent).toBe(1))

    const second = await runJob(job)
    expect(second.skipped).toBe(true)
    expect(state.runs).toBe(1)
    /* The skip does not write over the record of the run in flight. */
    expect(lastRun('test-overlap')?.finishedAt).toBeNull()

    state.hold = false
    release()
    expect(await first).toMatchObject({ summary: 'run 1' })
    expect(state.peak).toBe(1)
  })

  it('is skipped when another session holds its lock', async () => {
    const { job, state } = counting('test-locked')

    /* A second app container, as far as Postgres can tell. */
    const other = await sqlClient().reserve()
    try {
      await other`select pg_advisory_lock(${job.lockKey})`
      const run = await runJob(job)
      expect(run).toMatchObject({ skipped: true, error: null })
      expect(state.runs).toBe(0)
    } finally {
      await other`select pg_advisory_unlock(${job.lockKey})`
      other.release()
    }

    expect(await runJob(job)).toMatchObject({ summary: 'run 1' })
  })
})

describe('the scheduler', () => {
  it('runs a registered job on its interval', async () => {
    const { job, state } = counting('test-timer', 25)
    registerJob(job)

    expect(startScheduler()).toBe(true)
    /* Idempotent: a hot reload must not start a second loop. */
    expect(startScheduler()).toBe(false)

    await vi.waitFor(() => expect(state.runs).toBeGreaterThanOrEqual(2), { timeout: 5_000 })
    expect(state.peak).toBe(1)

    stopScheduler()
    await vi.waitFor(() => expect(state.concurrent).toBe(0))
    const settled = state.runs
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(state.runs).toBe(settled)
  })

  it('gives a job registered after the start its own timer', async () => {
    expect(startScheduler()).toBe(true)
    const { job, state } = counting('test-late', 25)
    registerJob(job)
    await vi.waitFor(() => expect(state.runs).toBeGreaterThanOrEqual(1), { timeout: 5_000 })
  })

  it('does not start outside the Node runtime or with WORKER=off', () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge')
    expect(startScheduler()).toBe(false)
    vi.stubEnv('NEXT_RUNTIME', 'nodejs')

    vi.stubEnv('WORKER', 'off')
    expect(startScheduler()).toBe(false)
    vi.stubEnv('WORKER', '')
  })

  it('is never started by startJobs under Vitest', () => {
    expect(startJobs()).toBe(false)
  })
})

describe('kick', () => {
  it('runs the job now, without the scheduler', async () => {
    /* An hour: only a kick can have run it. */
    const { job, state } = counting('test-kick', 60 * 60 * 1000)
    registerJob(job)

    const run = await kick('test-kick')
    expect(run).toMatchObject({ summary: 'run 1', error: null })
    expect(state.runs).toBe(1)
  })

  it('during a run, makes it run once more afterwards instead of overlapping', async () => {
    const { job, state, release } = counting('test-kick-again', 60 * 60 * 1000)
    registerJob(job)
    state.hold = true

    const first = kick('test-kick-again')
    await vi.waitFor(() => expect(state.concurrent).toBe(1))

    /* Two more kicks while it runs are one more run, not two. */
    expect((await kick('test-kick-again')).skipped).toBe(true)
    expect((await kick('test-kick-again')).skipped).toBe(true)
    expect(state.runs).toBe(1)

    state.hold = false
    release()
    await first

    await vi.waitFor(() => expect(state.runs).toBe(2))
    await vi.waitFor(() => expect(lastRun('test-kick-again')?.summary).toBe('run 2'))
    expect(state.peak).toBe(1)
  })

  it('refuses a name nobody registered', () => {
    expect(() => kick('no-such-job')).toThrow(/No job is registered/)
  })

  it('knows the process-notes job', () => {
    expect(jobNames()).toContain(PROCESS_NOTES)
  })
})
