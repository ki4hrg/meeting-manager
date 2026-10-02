/*
 * A Granola note becoming a meeting's note (docs/SPEC.md, "Drop-ins" and
 * "Processing").
 *
 * In order, and the order is the design:
 *
 *   1. **Which context.** Only the folder says: the note's folders, or the
 *      nearest folder above each, are looked up in this account's bindings. No
 *      bound folder and the note is ignored, unread. Folders bound to two
 *      contexts and it is left where it is, for John to sort out in Granola.
 *      Everything after this step looks inside that one context and nowhere
 *      else.
 *   2. **Already here.** A note Granola has sent before is updated where it is
 *      filed, whatever else has changed since: John may have moved it to a
 *      session, or moved its meeting.
 *   3. **Its calendar event.** The meeting that holds the same event id.
 *   4. **Its time.** Failing that, the one meeting that was going on when the
 *      note was started and whose people do not contradict the note's.
 *   5. **A meeting of its own.** Otherwise the note makes one, through
 *      `meetingFromNote`, with whoever of its attendees is already in the
 *      directory. Nobody is added to the directory from here.
 *
 * Then the note is saved and a run queued, in the same commit as any meeting
 * made for it. The same content twice saves nothing and queues nothing; edited
 * content is a new version and a new run. Nothing is processed here: the
 * caller kicks the job.
 *
 * Matching is deliberately narrow. A note filed on the wrong meeting cannot be
 * taken off it, while a drop-in made in error can simply be deleted.
 */

import { randomUUID } from 'node:crypto'
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { inTransaction, type ActorContext, type Executor } from '../../core/types'
import {
  integrationEvents,
  meetingPeople,
  meetings,
  people,
  personEmails,
  type NoteAttendee,
} from '../../db/schema'
import { meetingFromNote } from '../../meetings/prep'
import { findSeriesByCalendar } from '../../meetings/series'
import { findNoteByExternalId, saveNote } from '../../notes/notes'
import { queueRun } from '../../processing/run'
import {
  getNote,
  getTranscript,
  listFolders,
  type GranolaFolder,
  type GranolaNote,
  type GranolaTranscriptLine,
} from './client'
import { GRANOLA, listFolderBindings, withGranola } from './connection'

export type IntegrationEvent = typeof integrationEvents.$inferSelect

/** What happened to one note. Both are ordinary; neither is an error. */
export type IngestOutcome =
  | {
      kind: 'filed'
      meetingId: string
      noteId: string
      /** How the meeting was found: the note was already there, by event, by time, or made new. */
      via: 'note' | 'event' | 'time' | 'new'
      /** False when Granola sent what is already held. */
      changed: boolean
      /** A processing run was queued, so the job is worth kicking. */
      queued: boolean
    }
  | { kind: 'ignored'; reason: 'unbound' | 'ambiguous' | 'empty' }

/** The sentence kept on the delivery. */
export function describeOutcome(outcome: IngestOutcome): string {
  if (outcome.kind === 'ignored') {
    return {
      unbound: 'The note is in no folder that feeds a context.',
      ambiguous: 'The note is in folders that feed different contexts.',
      empty: 'The note has nothing in it yet.',
    }[outcome.reason]
  }
  if (!outcome.changed) return 'Already held, unchanged.'
  return {
    note: 'Updated where it was filed.',
    event: 'Filed on the meeting for its calendar event.',
    time: 'Filed on the meeting that was under way.',
    new: 'Made a meeting of its own.',
  }[outcome.via]
}

/** Granola speaking, with no person behind it. */
export function granolaActor(source: 'webhook' | 'job'): ActorContext {
  return { userId: null, source, requestId: randomUUID() }
}

// ─── which context ───────────────────────────────────────────────────────────

export type FolderHome = { kind: 'bound'; contextId: string } | { kind: 'unbound' } | { kind: 'ambiguous' }

/* Far deeper than Granola nests; stops a cycle in what it sends from looping. */
const MAX_DEPTH = 20

/**
 * The one context a note's folders feed, on this account.
 *
 * A folder with no binding of its own takes its nearest bound ancestor's,
 * which is how Granola itself treats a folder filter. Two folders that lead to
 * different contexts settle nothing: the note is not filed on a guess.
 *
 * `loadFolders` is the account's whole folder list, asked for only when a
 * folder's parent has to be looked further up than the note itself says.
 */
export async function contextForFolders(
  exec: Executor,
  connectionId: string,
  folders: GranolaFolder[],
  loadFolders: () => Promise<GranolaFolder[]>,
): Promise<FolderHome> {
  if (folders.length === 0) return { kind: 'unbound' }

  const bound = new Map(
    (await listFolderBindings(exec, { connectionId })).map((binding) => [
      binding.externalId,
      binding.contextId,
    ]),
  )
  if (bound.size === 0) return { kind: 'unbound' }

  const parentOf = new Map<string, string | null>(
    folders.map((folder) => [folder.id, folder.parent_folder_id]),
  )
  let loaded = false

  const contexts = new Set<string>()
  for (const folder of folders) {
    let current: string | null = folder.id
    for (let depth = 0; current && depth < MAX_DEPTH; depth++) {
      const contextId = bound.get(current)
      if (contextId) {
        contexts.add(contextId)
        break
      }
      if (!parentOf.has(current) && !loaded) {
        for (const known of await loadFolders()) parentOf.set(known.id, known.parent_folder_id)
        loaded = true
      }
      current = parentOf.get(current) ?? null
    }
  }

  if (contexts.size === 0) return { kind: 'unbound' }
  if (contexts.size > 1) return { kind: 'ambiguous' }
  return { kind: 'bound', contextId: [...contexts][0]! }
}

// ─── what the note says ──────────────────────────────────────────────────────

/** Everyone the note names, by address: attendees first, then the event's invitees. */
export function attendeesOf(note: GranolaNote): string[] {
  const emails = new Set<string>()
  for (const attendee of [...(note.attendees ?? []), ...(note.calendar_event?.invitees ?? [])]) {
    const email = attendee.email?.trim().toLowerCase()
    if (email) emails.add(email)
  }
  return [...emails]
}

/* Everyone the note names, with the name Granola has for them, without the
   note's owner (John). Kept on the note, so the ones not in the directory can
   be offered at review rather than lost. */
function namedAttendees(note: GranolaNote): NoteAttendee[] {
  const owner = note.owner?.email?.trim().toLowerCase()
  const byEmail = new Map<string, NoteAttendee>()
  for (const attendee of [...(note.attendees ?? []), ...(note.calendar_event?.invitees ?? [])]) {
    const email = attendee.email?.trim().toLowerCase()
    if (!email || email === owner) continue
    const name = ('name' in attendee ? attendee.name?.trim() : '') || null
    const held = byEmail.get(email)
    if (!held) byEmail.set(email, { email, name })
    else if (!held.name && name) held.name = name
  }
  return [...byEmail.values()]
}

/* The note's people who are already in the directory, without John: he is at
   every meeting and never a row on one. */
async function knownPeople(exec: Executor, note: GranolaNote): Promise<string[]> {
  const emails = attendeesOf(note)
  if (emails.length === 0) return []
  const rows = await exec
    .select({ personId: personEmails.personId })
    .from(personEmails)
    .innerJoin(people, eq(people.id, personEmails.personId))
    .where(and(inArray(sql`lower(${personEmails.email})`, emails), eq(people.isSelf, false)))
  return [...new Set(rows.map((row) => row.personId))]
}

function moment(value: string | null | undefined): Date | null {
  if (!value) return null
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? null : at
}

/** When the conversation began: the event's start, else when the note was started. */
export function startedAt(note: GranolaNote): Date | null {
  return moment(note.calendar_event?.scheduled_start_time) ?? moment(note.created_at)
}

/* Who said each line, as well as Granola knows: a name, an anonymous label, or
   only which side of the microphone. */
function speaker(line: GranolaTranscriptLine): string {
  const who = line.speaker
  if (who?.name) return who.name
  if (who?.diarization_label) return who.diarization_label
  if (who?.attribution === 'me') return 'Me'
  if (who?.attribution === 'them') return 'Them'
  return ''
}

export function transcriptText(lines: GranolaTranscriptLine[]): string {
  return lines
    .filter((line) => line.text?.trim())
    .map((line) => {
      const who = speaker(line)
      return who ? `${who}: ${line.text.trim()}` : line.text.trim()
    })
    .join('\n')
}

// ─── which meeting ───────────────────────────────────────────────────────────

/* A note started this long before a meeting's start is still that meeting's. */
const EARLY_MS = 15 * 60_000
/* How long a meeting with no end is taken to run (as `isOver` takes it). */
const DEFAULT_MINUTES = 60

/* One occurrence of a recurring event is `<recurring id>_<date or instant>`. */
const OCCURRENCE = /^(.+)_\d{8}(T\d{6}Z)?$/

type Target = { meetingId: string; via: 'event' | 'time' }

/**
 * The meeting in this context that the note records, if exactly one can be
 * told. Every query here carries `contextId`: a meeting in another context is
 * never a candidate, whatever its event id or its time.
 */
async function findMeeting(
  exec: Executor,
  contextId: string,
  note: GranolaNote,
  personIds: string[],
): Promise<{ target: Target | null; eventTaken: boolean }> {
  const eventId = note.calendar_event?.calendar_event_id?.trim() || null

  let eventTaken = false
  if (eventId) {
    const [held] = await exec
      .select({ id: meetings.id, contextId: meetings.contextId })
      .from(meetings)
      .where(eq(meetings.calendarEventId, eventId))
      .limit(1)
    if (held?.contextId === contextId) {
      return { target: { meetingId: held.id, via: 'event' }, eventTaken: true }
    }
    /* The event is a meeting in another context. The folder says this note is
       not that context's, so it does not follow the event there. */
    eventTaken = !!held
  }

  const start = startedAt(note)
  if (!start) return { target: null, eventTaken }

  const under = await exec
    .select({ id: meetings.id, parentMeetingId: meetings.parentMeetingId })
    .from(meetings)
    .where(
      and(
        eq(meetings.contextId, contextId),
        isNotNull(meetings.startsAt),
        /* A meeting on a calendar event of its own is a different event from
           the one this note names. */
        eventId ? isNull(meetings.calendarEventId) : undefined,
        sql`${meetings.startsAt} <= ${new Date(start.getTime() + EARLY_MS).toISOString()}::timestamptz`,
        sql`coalesce(${meetings.endsAt}, ${meetings.startsAt} + interval '${sql.raw(String(DEFAULT_MINUTES))} minutes') >= ${start.toISOString()}::timestamptz`,
      ),
    )
  if (under.length === 0) return { target: null, eventTaken }

  const rosters = await exec
    .select({ meetingId: meetingPeople.meetingId, personId: meetingPeople.personId })
    .from(meetingPeople)
    .where(
      inArray(
        meetingPeople.meetingId,
        under.map((row) => row.id),
      ),
    )
  const known = new Set(personIds)
  const fits = under.filter((row) => {
    const roster = rosters.filter((one) => one.meetingId === row.id)
    /* People contradict only when both sides name some and share none. */
    return known.size === 0 || roster.length === 0 || roster.some((one) => known.has(one.personId))
  })

  /* A multi-day meeting and the session inside it both cover the moment; the
     session is the closer answer. */
  const ids = new Set(fits.map((row) => row.id))
  const parents = new Set(
    fits.flatMap((row) =>
      row.parentMeetingId && ids.has(row.parentMeetingId) ? [row.parentMeetingId] : [],
    ),
  )
  const leaves = fits.filter((row) => !parents.has(row.id))

  // Two meetings at once is a question for John, not a coin to toss.
  if (leaves.length !== 1) return { target: null, eventTaken }
  return { target: { meetingId: leaves[0]!.id, via: 'time' }, eventTaken }
}

// ─── the ingest ──────────────────────────────────────────────────────────────

export type IngestDeps = {
  loadFolders: () => Promise<GranolaFolder[]>
  loadTranscript: () => Promise<GranolaTranscriptLine[]>
}

function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if ((current as Error & { code?: string }).code === '23505') return true
    current = current.cause
  }
  return false
}

/**
 * File one note, as fetched. `deps` reach back to Granola for what the note
 * does not carry; the transcript is asked for only once the note is known to
 * belong somewhere.
 */
export async function ingestNote(
  exec: Executor,
  actor: ActorContext,
  connectionId: string,
  note: GranolaNote,
  deps: IngestDeps,
): Promise<IngestOutcome> {
  const home = await contextForFolders(
    exec,
    connectionId,
    note.folder_membership ?? [],
    deps.loadFolders,
  )
  if (home.kind !== 'bound') return { kind: 'ignored', reason: home.kind }

  const lines = await deps.loadTranscript()
  const content = {
    body: (note.private_notes_markdown ?? note.private_notes_text ?? '').trim(),
    summary: (note.summary_markdown ?? note.summary_text ?? '').trim(),
    transcript: transcriptText(lines),
  }
  /* Listed by the reconcile while it is still being recorded: nothing to file
     until Granola has written something. */
  if (!content.body && !content.summary && !content.transcript) {
    return { kind: 'ignored', reason: 'empty' }
  }

  const file = () =>
    inTransaction(exec, async (tx): Promise<IngestOutcome> => {
      let meetingId: string
      let via: 'note' | 'event' | 'time' | 'new'

      /* One arrival of a note at a time. The webhook and the reconcile can
         both bring a new note at the same moment, and each would make a
         meeting for it before either could see the other's. Held until this
         commits, so the second looks only once the first has filed. */
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`granola:${note.id}`}, 0))`)

      const held = await findNoteByExternalId(tx, GRANOLA, note.id)
      if (held) {
        meetingId = held.meetingId
        via = 'note'
      } else {
        const personIds = await knownPeople(tx, note)
        const { target, eventTaken } = await findMeeting(tx, home.contextId, note, personIds)
        if (target) {
          meetingId = target.meetingId
          via = target.via
        } else {
          const start = startedAt(note) ?? new Date()
          const eventId = note.calendar_event?.calendar_event_id?.trim() || null
          /* The event becomes this meeting's only when no meeting anywhere has
             it; its series comes along only when that series is here too. */
          const claim = eventId && !eventTaken ? eventId : undefined
          const recurring = claim ? OCCURRENCE.exec(claim)?.[1] : undefined
          const series = recurring ? await findSeriesByCalendar(tx, recurring) : null

          const end =
            moment(note.calendar_event?.scheduled_end_time) ?? moment(lines.at(-1)?.end_time)
          const meeting = await meetingFromNote(tx, actor, {
            contextId: home.contextId,
            title: note.title?.trim() || note.calendar_event?.event_title?.trim() || null,
            startsAt: start,
            endsAt: end && end > start ? end : null,
            personIds,
            calendarEventId: claim,
            seriesId: series?.contextId === home.contextId ? series.id : undefined,
          })
          meetingId = meeting.id
          via = 'new'
        }
      }

      const saved = await saveNote(tx, actor, {
        meetingId,
        source: GRANOLA,
        externalId: note.id,
        title: note.title,
        ...content,
        externalUpdatedAt: moment(note.updated_at),
        attendees: namedAttendees(note),
      })
      /* Asked for even when nothing changed: null when this version has its
         run, which is every time but the one where an earlier attempt saved
         the note and died before queueing. */
      const run = await queueRun(tx, saved.note.id)

      return {
        kind: 'filed',
        meetingId: saved.note.meetingId,
        noteId: saved.note.id,
        via,
        changed: saved.changed,
        queued: run !== null,
      }
    })

  try {
    return await file()
  } catch (err) {
    /* Two notes of one calendar event that nobody prepped, arriving at once:
       each makes the event's meeting, one wins the unique key and the other is
       rolled back whole. Its second look finds the meeting the winner made. */
    if (!isUniqueViolation(err)) throw err
    return file()
  }
}

/** Fetch a note from Granola and file it. What a delivery and the reconcile both do. */
export async function ingestNoteById(
  exec: Executor,
  actor: ActorContext,
  connectionId: string,
  noteId: string,
): Promise<IngestOutcome> {
  return withGranola(exec, connectionId, async (key) => {
    const note = await getNote(key, noteId)
    return ingestNote(exec, actor, connectionId, note, {
      loadFolders: () => listFolders(key),
      loadTranscript: () => getTranscript(key, note.id),
    })
  })
}

// ─── the delivery ledger ─────────────────────────────────────────────────────

/**
 * Claim a delivery by its id, or learn that it was claimed before.
 *
 * The insert is the claim: a select followed by an insert leaves a gap exactly
 * wide enough for the duplicate this table exists to stop. `fresh` is false
 * for a repeat, with one exception: a delivery whose first attempt failed is
 * handed out again, once, to whoever asks first.
 */
export async function claimDelivery(
  exec: Executor,
  input: { externalId: string; type: string; payload: unknown },
): Promise<{ event: IntegrationEvent; fresh: boolean }> {
  const [inserted] = await exec
    .insert(integrationEvents)
    .values({
      provider: GRANOLA,
      externalId: input.externalId,
      type: input.type,
      payload: (input.payload ?? {}) as object,
    })
    .onConflictDoNothing({ target: [integrationEvents.provider, integrationEvents.externalId] })
    .returning()
  if (inserted) return { event: inserted, fresh: true }

  const [retried] = await exec
    .update(integrationEvents)
    .set({ status: 'received', detail: null, processedAt: null })
    .where(
      and(
        eq(integrationEvents.provider, GRANOLA),
        eq(integrationEvents.externalId, input.externalId),
        eq(integrationEvents.status, 'failed'),
      ),
    )
    .returning()
  if (retried) return { event: retried, fresh: true }

  const [existing] = await exec
    .select()
    .from(integrationEvents)
    .where(
      and(
        eq(integrationEvents.provider, GRANOLA),
        eq(integrationEvents.externalId, input.externalId),
      ),
    )
    .limit(1)
  return { event: existing!, fresh: false }
}

export async function completeDelivery(
  exec: Executor,
  eventId: string,
  result: IngestOutcome | { failed: string } | { ignored: string },
): Promise<void> {
  const [status, detail] =
    'failed' in result
      ? ['failed', result.failed]
      : 'ignored' in result
        ? ['ignored', result.ignored]
        : [result.kind === 'filed' ? 'processed' : 'ignored', describeOutcome(result)]

  await exec
    .update(integrationEvents)
    .set({ status, detail: detail.slice(0, 500), processedAt: new Date() })
    .where(eq(integrationEvents.id, eventId))
}
