/*
 * Notes: what was written down at a meeting, pasted by hand or delivered by
 * Granola (docs/SPEC.md, "Processing").
 *
 * A note belongs to one meeting and a meeting can hold several. Its content
 * hash is what a processing run is keyed on, so saving the same content twice
 * changes nothing and asks for no new run.
 *
 * A Granola note from a folder that feeds no context arrives unfiled: no
 * meeting, so no context, and nothing is run on it. It waits in the Inbox
 * until John files it (`lib/connect/granola/unfiled.ts`).
 */

import { createHash } from 'node:crypto'
import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm'
import {
  NotFoundError,
  ValidationError,
  inTransaction,
  type ActorContext,
  type Executor,
} from '../core/types'
import { meetings, notes, proposals, type NoteAttendee, type NoteFiling } from '../db/schema'

export type Note = typeof notes.$inferSelect

export type NoteInput = {
  /** Null holds the note unfiled. */
  meetingId: string | null
  /** When it was and which event it recorded, for filing it later. */
  filing?: NoteFiling | null
  source: 'pasted' | 'granola'
  externalId?: string | null
  title?: string | null
  body: string
  summary?: string | null
  transcript?: string | null
  externalUpdatedAt?: Date | null
  /** Kept as first given: a later delivery does not bring back one John dismissed. */
  attendees?: NoteAttendee[]
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}

/** sha256 over body, summary and transcript: the version of a note a run is keyed on. */
export function hashNote(input: {
  body: string
  summary?: string | null
  transcript?: string | null
}): string {
  // As JSON, so text moving from one field to another is a different version.
  return createHash('sha256')
    .update(JSON.stringify([input.body, input.summary ?? null, input.transcript ?? null]))
    .digest('hex')
}

/** The meeting a note is filed on. Nothing is done to an unfiled note until it is filed. */
export function meetingOf(note: Pick<Note, 'meetingId'>): string {
  if (!note.meetingId) throw new ValidationError('That note is not filed yet.')
  return note.meetingId
}

export async function getNote(exec: Executor, id: string): Promise<Note> {
  const [row] = await exec.select().from(notes).where(eq(notes.id, id)).limit(1)
  if (!row) throw new NotFoundError('Note', id)
  return row
}

export type FiledNote = Note & { meetingId: string }

/** A meeting's notes, oldest first. */
export async function listNotes(exec: Executor, meetingId: string): Promise<FiledNote[]> {
  return (await exec
    .select()
    .from(notes)
    .where(eq(notes.meetingId, meetingId))
    .orderBy(asc(notes.createdAt), asc(notes.id))) as FiledNote[]
}

/** The note Granola knows by this id, wherever it is filed. */
export async function findNoteByExternalId(
  exec: Executor,
  source: NoteInput['source'],
  externalId: string,
): Promise<Note | null> {
  const [row] = await exec
    .select()
    .from(notes)
    .where(and(eq(notes.source, source), eq(notes.externalId, externalId)))
    .limit(1)
  return row ?? null
}

/**
 * Save a note. A note with an external id (Granola's) is upserted on
 * (source, externalId); `changed` is false when its content hash is the same,
 * which is how a re-delivery is told from an edit. A pasted note is always a
 * new row.
 *
 * A note that already exists stays on the meeting it is filed on, whatever
 * `meetingId` says: John may have moved it to a session since it arrived. An
 * unfiled one is filed by a `meetingId`, and otherwise stays unfiled.
 */
export async function saveNote(
  exec: Executor,
  _actor: ActorContext,
  input: NoteInput,
): Promise<{ note: Note; changed: boolean }> {
  const externalId = blankToNull(input.externalId)
  const content = {
    body: input.body.trim(),
    summary: blankToNull(input.summary),
    transcript: blankToNull(input.transcript),
  }
  const contentHash = hashNote(content)

  if (input.source === 'pasted' && content.body === '') {
    throw new ValidationError('Enter some notes.')
  }

  return inTransaction(exec, async (tx) => {
    const existing = externalId ? await findNoteByExternalId(tx, input.source, externalId) : null

    if (existing) {
      const filing = existing.meetingId === null && input.meetingId !== null
      if (filing) await assertMeeting(tx, input.meetingId!)
      if (existing.contentHash === contentHash && !filing) return { note: existing, changed: false }
      const [note] = await tx
        .update(notes)
        .set({
          ...(filing ? { meetingId: input.meetingId, dismissedAt: null } : {}),
          ...(existing.meetingId === null && input.filing ? { filing: input.filing } : {}),
          ...content,
          contentHash,
          title: blankToNull(input.title) ?? existing.title,
          externalUpdatedAt: input.externalUpdatedAt ?? existing.externalUpdatedAt,
          updatedAt: new Date(),
        })
        .where(eq(notes.id, existing.id))
        .returning()
      return { note: note!, changed: true }
    }

    if (input.meetingId !== null) await assertMeeting(tx, input.meetingId)

    const [note] = await tx
      .insert(notes)
      .values({
        meetingId: input.meetingId,
        filing: input.filing ?? null,
        source: input.source,
        externalId,
        title: blankToNull(input.title),
        ...content,
        contentHash,
        externalUpdatedAt: input.externalUpdatedAt ?? null,
        attendees: input.attendees ?? [],
      })
      .returning()
    return { note: note!, changed: true }
  })
}

async function assertMeeting(exec: Executor, meetingId: string) {
  const [meeting] = await exec
    .select({ id: meetings.id })
    .from(meetings)
    .where(eq(meetings.id, meetingId))
    .limit(1)
  if (!meeting) throw new NotFoundError('Meeting', meetingId)
}

/**
 * File a note on a session of its meeting, on another session, or back on the
 * parent. Nowhere else: a note does not travel between unrelated meetings.
 *
 * What is still undecided goes with it: the note's pending and rejected
 * proposals move to the new meeting (a rejection is a fact about the note, so
 * it is remembered where the note now is). Accepted proposals stay, because the
 * items they made originate in the meeting they were accepted on. A proposal
 * the new meeting already has, by fingerprint, is dropped rather than doubled.
 * An agenda line belongs to one meeting, so the moved proposals lose theirs.
 */
export async function moveNote(
  exec: Executor,
  _actor: ActorContext,
  noteId: string,
  meetingId: string,
): Promise<Note> {
  return inTransaction(exec, async (tx) => {
    const note = await getNote(tx, noteId)
    if (note.meetingId === meetingId) return note
    const fromId = meetingOf(note)

    const rows = await tx
      .select({ id: meetings.id, parentMeetingId: meetings.parentMeetingId })
      .from(meetings)
      .where(inArray(meetings.id, [fromId, meetingId]))
    const from = rows.find((row) => row.id === fromId)
    const to = rows.find((row) => row.id === meetingId)
    if (!to) throw new NotFoundError('Meeting', meetingId)
    if (!from || (from.parentMeetingId ?? from.id) !== (to.parentMeetingId ?? to.id)) {
      throw new ValidationError('A note can only move between a meeting and its own sessions.')
    }

    const there = new Set(
      (
        await tx
          .select({ fingerprint: proposals.fingerprint })
          .from(proposals)
          .where(eq(proposals.meetingId, meetingId))
      ).map((row) => row.fingerprint),
    )
    const moving = await tx
      .select({ id: proposals.id, fingerprint: proposals.fingerprint })
      .from(proposals)
      .where(
        and(
          eq(proposals.noteId, noteId),
          eq(proposals.meetingId, fromId),
          ne(proposals.status, 'accepted'),
        ),
      )

    const doubled = moving.filter((row) => there.has(row.fingerprint)).map((row) => row.id)
    const going = moving.filter((row) => !there.has(row.fingerprint)).map((row) => row.id)
    if (doubled.length > 0) await tx.delete(proposals).where(inArray(proposals.id, doubled))
    if (going.length > 0) {
      await tx
        .update(proposals)
        .set({ meetingId, agendaLineId: null, updatedAt: new Date() })
        .where(inArray(proposals.id, going))
    }

    const [moved] = await tx
      .update(notes)
      .set({ meetingId, updatedAt: new Date() })
      .where(eq(notes.id, noteId))
      .returning()
    return moved!
  })
}

/**
 * Have the next reconcile pass ask Granola about every waiting note again,
 * though none has changed: after a folder is bound or a context restored, one
 * of them may now have a home. Dismissed notes stay where they are.
 */
export async function recheckHeldNotes(exec: Executor): Promise<void> {
  await exec
    .update(notes)
    .set({ externalUpdatedAt: null })
    .where(and(isNull(notes.meetingId), isNull(notes.dismissedAt)))
}
