/*
 * Log a meeting: pick people, paste notes, and let the same processing run
 * over them (docs/SPEC.md, "Drop-ins"). It covers the conversation nobody
 * recorded, and it is the fallback when Granola fails.
 *
 * One commit: the meeting, its note and the queued run exist together or not
 * at all. Nothing is processed here; the caller kicks the job.
 */

import { and, inArray } from 'drizzle-orm'
import { isUuid } from '../core/match'
import { ValidationError, inTransaction, type ActorContext, type Executor } from '../core/types'
import { people } from '../db/schema'
import { notDeleted } from '../db/shelf'
import { saveNote } from '../notes/notes'
import { queueRun } from '../processing/run'
import { takeRoll } from './attendance'
import { createMeeting, type MeetingView } from './meetings'

export type LogMeetingInput = {
  contextId: string
  /** Defaults from the people's names, the way a prepped meeting is titled. */
  title?: string
  /** When it happened; now, when not given. A logged meeting is never an undated stub. */
  startsAt?: Date | null
  /** When it ended; or how long it ran. Neither, with a start, leaves it open-ended. */
  endsAt?: Date | null
  minutes?: number | null
  personIds: string[]
  /** Its groups; `groupId` is one. */
  groupIds?: string[]
  groupId?: string | null
  projectIds?: string[]
  notes: string
}

export async function logMeeting(
  exec: Executor,
  actor: ActorContext,
  input: LogMeetingInput,
  now: Date = new Date(),
): Promise<{ meeting: MeetingView; noteId: string; runId: string }> {
  if (input.notes.trim() === '') throw new ValidationError('Enter some notes.')
  if (input.minutes != null && (!Number.isFinite(input.minutes) || input.minutes < 0)) {
    throw new ValidationError('Minutes must be non-negative.')
  }

  if (input.startsAt && Number.isNaN(input.startsAt.getTime())) {
    throw new ValidationError('That is not a date and time.')
  }

  const startsAt = input.startsAt ?? now
  /* Logged with no time, it has just finished: ending now keeps it out of the
     upcoming list, where a meeting with no end stays for an hour. */
  const endsAt = input.endsAt
    ? input.endsAt
    : input.minutes
      ? new Date(startsAt.getTime() + input.minutes * 60_000)
      : input.startsAt
        ? null
        : startsAt

  const personIds = [...new Set(input.personIds)]

  return inTransaction(exec, async (tx) => {
    /* createMeeting keeps the people it finds and says nothing of the rest. A
       logged meeting is about who was there, so someone unknown is refused
       rather than left out. */
    const known = personIds.every(isUuid)
      ? await tx
          .select({ id: people.id })
          .from(people)
          .where(and(inArray(people.id, personIds), notDeleted(people)))
      : []
    if (known.length !== personIds.length) {
      throw new ValidationError('One of those people is not in the directory.')
    }

    const groupIds = [...new Set([...(input.groupIds ?? []), ...(input.groupId ? [input.groupId] : [])])]
    const made = await createMeeting(tx, actor, {
      contextId: input.contextId,
      title: input.title?.trim() || null,
      startsAt,
      endsAt,
      groupIds,
      personIds,
      projectIds: input.projectIds ?? [],
    })
    /* Logged after the fact, so who was there is known now: those picked,
       the rest of its group out; or, with a group and nobody picked, the
       group's members. */
    const here = personIds.length > 0 ? personIds : made.attendees.map((person) => person.id)
    const meeting = await takeRoll(
      tx,
      made.id,
      { here, out: made.attendees.map((person) => person.id).filter((id) => !here.includes(id)) },
      now,
    )

    const { note } = await saveNote(tx, actor, {
      meetingId: meeting.id,
      source: 'pasted',
      body: input.notes,
    })
    const run = await queueRun(tx, note.id)
    // A new note has no run yet, so there is always one to queue.
    return { meeting, noteId: note.id, runId: run!.id }
  })
}
