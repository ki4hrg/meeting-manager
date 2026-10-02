/*
 * Where background work starts.
 *
 * Next calls `register()` once per server process, before any request is
 * served, which makes it the one place a long-lived timer can be started
 * without a request having to trigger it.
 *
 * The guards live in `startJobs` and the scheduler, so a future entry point
 * cannot start the loop by a route that forgot one. What this file adds is the
 * log line: a scheduler that did not start and one that started silently look
 * the same when notes are sitting unprocessed, and the difference is usually
 * `WORKER=off` left on a container somebody was debugging.
 */

export async function register() {
  /* The Edge runtime evaluates this file too and can load none of what follows. */
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  /* Imported inside the function: `next build` evaluates this file, and a
     top-level import would pull the database driver into a build that has no
     DATABASE_URL. */
  const { startJobs, jobNames } = await import('./lib/jobs')

  if (startJobs()) {
    console.log(`[jobs] scheduler started: ${jobNames().join(', ')}`)
  } else if (process.env.WORKER === 'off') {
    console.log('[jobs] scheduler not started: WORKER=off')
  }
}
