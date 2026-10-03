/*
 * Granola notes waiting in the Inbox (docs/SPEC.md, "Drop-ins").
 *
 * A note from no folder that feeds a context, or from folders that feed two,
 * is held with no meeting and so in no context at all. It is listed in the
 * Inbox whichever context is selected, which crosses no boundary: it belongs
 * to none yet. Only what it is (title, when, who) is listed; nothing is run on
 * it, and nothing of any context is read against it, until John files it.
 *
 * Filing does in the chosen context what the ingest does in a bound folder's:
 * the meeting for its calendar event, else the one under way when it started,
 * else a meeting of its own. Or John links it to a meeting he picks there. Then
 * a run is queued, as for any arriving note.
 */

import { and, count, desc, eq, isNull } from 'drizzle-orm'
import {
  NotFoundError,
  ValidationError,
  inTransaction,
  type ActorContext,
  type Executor,
} from '../../core/types'
import { notes, type NoteAttendee } from '../../db/schema'
import { getContext } from '../../directory/contexts'
import { getMeeting } from '../../meetings/meetings'
import { getNote } from '../../notes/notes'
import { queueRun } from '../../processing/run'
import { isUniqueViolation, knownPeople, lockNote, matchMeeting, placeNote } from './ingest'

export type UnfiledNote = {
  id: string
  title: string | null
  startsAt: Date | null
  endsAt: Date | null
  attendees: NoteAttendee[]
  receivedAt: Date
}

/** Every note waiting to be filed, the latest first. */
export async function listUnfiledNotes(exec: Executor): Promise<UnfiledNote[]> {
  const rows = await exec
    .select({
      id: notes.id,
      title: notes.title,
      filing: notes.filing,
      attendees: notes.attendees,
      createdAt: notes.createdAt,
    })
    .from(notes)
    .where(and(isNull(notes.meetingId), isNull(notes.dismissedAt)))
    .orderBy(desc(notes.createdAt))

  const at = (value: string | null | undefined) => (value ? new Date(value) : null)
  return rows
    .map((row) => ({
      id: row.id,
      title: row.title,
      startsAt: at(row.filing?.startsAt),
      endsAt: at(row.filing?.endsAt),
      attendees: row.attendees,
      receivedAt: row.createdAt,
    }))
    .sort(
      (a, b) =>
        (b.startsAt ?? b.receivedAt).getTime() - (a.startsAt ?? a.receivedAt).getTime(),
    )
}

/** How many notes are waiting to be filed. */
export async function countUnfiledNotes(exec: Executor): Promise<number> {
  const [row] = await exec
    .select({ n: count() })
    .from(notes)
    .where(and(isNull(notes.meetingId), isNull(notes.dismissedAt)))
  return row?.n ?? 0
}

async function heldNote(exec: Executor, noteId: string) {
  const note = await getNote(exec, noteId)
  if (note.meetingId !== null) throw new ValidationError('That note is already filed.')
  return note
}

const NO_FILING = { startsAt: null, endsAt: null, calendarEventId: null }

/**
 * What File would do with a held note in a context: the meeting it would go
 * on, or null for a new one. Reads only that context, which John has chosen.
 */
export async function previewFiling(
  exec: Executor,
  noteId: string,
  contextId: string,
): Promise<{ meetingId: string; via: 'event' | 'time' } | null> {
  const note = await heldNote(exec, noteId)
  return matchMeeting(
    exec,
    contextId,
    note.filing ?? NO_FILING,
    await knownPeople(
      exec,
      note.attendees.map((attendee) => attendee.email),
    ),
  )
}

/**
 * File a held note in a context: on the meeting it records there, or on one
 * made for it. With `meetingId`, on that meeting instead, which must be in the
 * context and, if it has sessions, be one of them. Returns the meeting.
 */
export async function fileHeldNote(
  exec: Executor,
  actor: ActorContext,
  noteId: string,
  contextId: string,
  opts: { meetingId?: string } = {},
): Promise<{ meetingId: string; via: 'event' | 'time' | 'new' | 'chosen' }> {
  await getContext(exec, contextId)
  if (opts.meetingId) {
    const chosen = await getMeeting(exec, opts.meetingId)
    if (chosen.contextId !== contextId) {
      throw new ValidationError('That meeting belongs to another context.')
    }
    // As for any note: the session, not the meeting it belongs to.
    if (chosen.sessions.length > 0) throw new ValidationError('Pick one of its sessions.')
  }

  const file = () =>
    inTransaction(exec, async (tx) => {
      const { externalId } = await getNote(tx, noteId)
      /* The same lock the ingest takes, so a delivery of this note arriving
         now waits and then finds it filed. */
      if (externalId) await lockNote(tx, externalId)
      const note = await heldNote(tx, noteId)

      const placed = opts.meetingId
        ? { meetingId: opts.meetingId, via: 'chosen' as const }
        : await placeNote(tx, actor, {
            contextId,
            projectIds: [],
            filing: note.filing ?? NO_FILING,
            personIds: await knownPeople(
              tx,
              note.attendees.map((attendee) => attendee.email),
            ),
            title: note.title,
          })
      await tx
        .update(notes)
        .set({ meetingId: placed.meetingId, dismissedAt: null, updatedAt: new Date() })
        .where(eq(notes.id, note.id))
      await queueRun(tx, note.id)
      return placed
    })

  try {
    return await file()
  } catch (err) {
    // As in the ingest: a meeting for the same event made at the same moment.
    if (!isUniqueViolation(err)) throw err
    return file()
  }
}

/** Wave a held note away. A later delivery updates it but does not bring it back. */
export async function dismissHeldNote(
  exec: Executor,
  _actor: ActorContext,
  noteId: string,
): Promise<void> {
  await heldNote(exec, noteId)
  const [row] = await exec
    .update(notes)
    .set({ dismissedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(notes.id, noteId), isNull(notes.meetingId)))
    .returning({ id: notes.id })
  if (!row) throw new NotFoundError('Note', noteId)
}
