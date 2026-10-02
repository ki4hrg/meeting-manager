/*
 * The net under the webhook (docs/SPEC.md: "A reconcile job catches missed
 * webhook deliveries"). Lifted in shape from ../Meeter/lib/connect/granola/sync.ts.
 *
 * A delivery is missed for ordinary reasons: the container was restarting,
 * Granola gave up retrying, no endpoint could be registered, or the folder was
 * bound after the note was written. So this does not replay deliveries; it
 * asks Granola what changed lately on the account and files whatever is not
 * already held as it now stands. Filing is the same `ingestNote` the webhook
 * uses, so running this over a note the webhook did deliver changes nothing.
 *
 * Every note is listed, not only those in bound folders: a note in no bound
 * folder is held for the Inbox rather than left behind.
 *
 * There is no cursor. The window is fixed, and a note already held at the
 * `updated_at` Granola reports costs no request beyond the listing.
 */

import type { Executor } from '../../core/types'
import { findNoteByExternalId } from '../../notes/notes'
import { ConnectionError } from '../connections'
import {
  GranolaApiError,
  getNote,
  getTranscript,
  listFolders,
  listNotes,
  type GranolaFolder,
} from './client'
import { GRANOLA, listGranolaAccounts, withGranola } from './connection'
import { granolaActor, ingestNote } from './ingest'

/* How far back to look. Long enough to cover a weekend with the container
   down; short enough that binding a folder does not file its whole history. */
export const LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000

export type ReconcileResult = {
  /** Notes Granola listed. */
  seen: number
  /** New notes filed or held for the Inbox, and notes already here that had changed. */
  filed: number
  /** Processing runs queued. */
  queued: number
  /** Accounts that could not be read; each has its error on its connection. */
  failed: number
}

async function reconcileAccount(
  exec: Executor,
  connectionId: string,
  now: Date,
): Promise<Omit<ReconcileResult, 'failed'>> {
  const result = { seen: 0, filed: 0, queued: 0 }
  const actor = granolaActor('job')
  const updatedAfter = new Date(now.getTime() - LOOKBACK_MS)

  return withGranola(exec, connectionId, async (key) => {
    const listed = new Map<string, string>()
    for (const summary of await listNotes(key, { updatedAfter })) {
      listed.set(summary.id, summary.updated_at)
    }
    result.seen = listed.size

    let tree: Promise<GranolaFolder[]> | null = null
    for (const [noteId, updatedAt] of listed) {
      const held = await findNoteByExternalId(exec, GRANOLA, noteId)
      const theirs = new Date(updatedAt)
      if (held?.externalUpdatedAt && held.externalUpdatedAt >= theirs) continue

      const note = await getNote(key, noteId)
      const outcome = await ingestNote(exec, actor, connectionId, note, {
        // The same folder tree for every note of this pass.
        loadFolders: () => (tree ??= listFolders(key)),
        loadTranscript: () => getTranscript(key, noteId),
      })
      if (outcome.kind === 'ignored') continue
      if (outcome.changed) result.filed += 1
      if (outcome.kind === 'filed' && outcome.queued) result.queued += 1
    }
    return result
  })
}

/**
 * Every connected account, one after another. One account's trouble never
 * stops the next: a revoked key or a busy API is recorded on that connection
 * and the pass moves on. Anything else is a bug and is thrown.
 */
export async function reconcileGranola(
  exec: Executor,
  now: Date = new Date(),
): Promise<ReconcileResult> {
  const total: ReconcileResult = { seen: 0, filed: 0, queued: 0, failed: 0 }

  for (const account of await listGranolaAccounts(exec)) {
    try {
      const one = await reconcileAccount(exec, account.id, now)
      total.seen += one.seen
      total.filed += one.filed
      total.queued += one.queued
    } catch (err) {
      if (!(err instanceof ConnectionError || err instanceof GranolaApiError)) throw err
      total.failed += 1
    }
  }
  return total
}

/** One line for the job's last run. */
export function summariseReconcile(result: ReconcileResult): string {
  if (result.seen === 0 && result.failed === 0) return 'Nothing new.'
  const parts = [`${result.seen} seen`, `${result.filed} filed`]
  if (result.failed > 0) parts.push(`${result.failed} failed`)
  return parts.join(' · ')
}
