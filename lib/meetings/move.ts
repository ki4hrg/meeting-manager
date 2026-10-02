/*
 * Moving a meeting, or a whole series, to another context.
 *
 * A calendar is bound to one context, so an event prepped from it lands there
 * even when it belongs elsewhere (a church meeting on the work calendar). A
 * context is otherwise a hard boundary, so a move carries only what is the
 * meeting's own: its row, its times and calendar ids, its people (who are
 * global), the agenda as typed, and its notes. Everything that points into the
 * old context is left there: projects, the group, the series, item lines,
 * dismissals, items aimed at it, and what processing worked out against the old
 * context's items.
 *
 * A meeting that has produced records in its context does not move: those
 * records stay, and a meeting in one context with its outcomes in another is
 * the leak a context exists to prevent.
 */

import { and, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import {
  NotFoundError,
  ValidationError,
  inTransaction,
  type ActorContext,
  type Executor,
  type Tx,
} from '../core/types'
import {
  agendaLines,
  documents,
  itemEvents,
  items,
  meetingDismissals,
  meetingProjects,
  meetings,
  notes,
  processingRuns,
  proposals,
  series,
  seriesProjects,
} from '../db/schema'
import { getContext } from '../directory/contexts'
import { queueRun } from '../processing/run'
import { getMeeting, type MeetingView } from './meetings'
import { getSeries, type SeriesView } from './series'

type MeetingRow = typeof meetings.$inferSelect

async function loadRow(exec: Executor, meetingId: string): Promise<MeetingRow> {
  const [row] = await exec.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1)
  if (!row) throw new NotFoundError('Meeting', meetingId)
  return row
}

/* A meeting moves as one with its sessions. */
async function withSessions(exec: Executor, meetingId: string): Promise<string[]> {
  const sessions = await exec
    .select({ id: meetings.id })
    .from(meetings)
    .where(eq(meetings.parentMeetingId, meetingId))
  return [meetingId, ...sessions.map((session) => session.id)]
}

/**
 * Why a meeting (with its sessions) has to stay where it is, or null when it
 * can go. By then it has produced records in its context, and those do not
 * move: an item that came out of it, or anything an accepted proposal made.
 */
async function whyItStays(exec: Executor, ids: string[], title: string): Promise<string | null> {
  const [item] = await exec
    .select({ id: items.id })
    .from(items)
    .where(inArray(items.originMeetingId, ids))
    .limit(1)
  if (item) return `${title} has produced items here, and they do not move. It stays.`

  const [accepted] = await exec
    .select({ id: proposals.id })
    .from(proposals)
    .where(and(inArray(proposals.meetingId, ids), eq(proposals.status, 'accepted')))
    .limit(1)
  if (accepted) return `${title} has accepted proposals here, and what they made does not move. It stays.`

  const [document] = await exec
    .select({ id: documents.id })
    .from(documents)
    .where(inArray(documents.meetingId, ids))
    .limit(1)
  if (document) return `${title} has produced a document here, and it does not move. It stays.`

  return null
}

/* The move itself, for a meeting already found free to go. */
async function relocate(
  tx: Tx,
  actor: ActorContext,
  ids: string[],
  contextId: string,
  opts: { keepSeries: boolean },
): Promise<void> {
  await tx.delete(meetingProjects).where(inArray(meetingProjects.meetingId, ids))
  await tx.delete(meetingDismissals).where(inArray(meetingDismissals.meetingId, ids))

  /* Item lines go; the items themselves are not touched. What was typed stays,
     closed up so each list is numbered from zero again. */
  await tx
    .delete(agendaLines)
    .where(and(inArray(agendaLines.meetingId, ids), isNotNull(agendaLines.itemId)))
  await tx.execute(sql`
    update agenda_lines set position = ranked.place
    from (
      select id,
        (row_number() over (partition by meeting_id, section_id order by position, created_at))::int - 1 as place
      from agenda_lines
      where ${inArray(agendaLines.meetingId, ids)}
    ) ranked
    where agenda_lines.id = ranked.id and agenda_lines.position <> ranked.place`)

  /* Items aimed at it go back to waiting in their own context, and say so in
     their history as any change of target does. */
  const aimed = await tx
    .update(items)
    .set({ targetMeetingId: null, updatedAt: new Date() })
    .where(inArray(items.targetMeetingId, ids))
    .returning({ id: items.id })
  if (aimed.length > 0) {
    await tx.insert(itemEvents).values(
      aimed.map((item) => ({
        itemId: item.id,
        type: 'targeted',
        data: { meetingId: null, seriesId: null },
        source: actor.source,
        requestId: actor.requestId,
      })),
    )
  }

  /* What processing proposed was worked out against the old context's items
     and directory. The notes stay; their runs go and are queued afresh, so
     the same notes are read again where the meeting now lives. */
  await tx
    .delete(proposals)
    .where(and(inArray(proposals.meetingId, ids), ne(proposals.status, 'accepted')))
  const kept = await tx.select({ id: notes.id }).from(notes).where(inArray(notes.meetingId, ids))
  const noteIds = kept.map((note) => note.id)
  if (noteIds.length > 0) {
    await tx.delete(processingRuns).where(inArray(processingRuns.noteId, noteIds))
    for (const noteId of noteIds) await queueRun(tx, noteId)
  }

  await tx
    .update(meetings)
    .set({
      contextId,
      groupId: null,
      ...(opts.keepSeries ? {} : { seriesId: null }),
      updatedAt: new Date(),
    })
    .where(inArray(meetings.id, ids))
}

/**
 * Move a meeting to another context, with its sessions. Refused once it has
 * produced items or accepted proposals. Nothing is placed here: the agenda
 * picks up the new context's items the way it always does, when the meeting is
 * next opened.
 */
export async function moveMeeting(
  exec: Executor,
  actor: ActorContext,
  meetingId: string,
  contextId: string,
): Promise<MeetingView> {
  return inTransaction(exec, async (tx) => {
    const meeting = await loadRow(tx, meetingId)
    await getContext(tx, contextId)
    if (meeting.contextId === contextId) return getMeeting(tx, meetingId)

    if (meeting.parentMeetingId) {
      const parent = await loadRow(tx, meeting.parentMeetingId)
      throw new ValidationError(`A session moves with its meeting. Move ${parent.title} instead.`)
    }

    const ids = await withSessions(tx, meetingId)
    const reason = await whyItStays(tx, ids, meeting.title)
    if (reason) throw new ValidationError(reason)

    await relocate(tx, actor, ids, contextId, { keepSeries: false })
    return getMeeting(tx, meetingId)
  })
}

export type SeriesMove = {
  series: SeriesView
  /** Went with the series, and are still its occurrences. */
  moved: MeetingView[]
  /** Had produced items: still in the old context, no longer in the series. */
  stayed: MeetingView[]
}

/**
 * Move a series to another context, with its roster and skeleton, so the next
 * occurrences of its calendar event follow it. Each of its meetings that is
 * free to move goes too; one that has produced items stays where its items
 * are, out of the series.
 */
export async function moveSeries(
  exec: Executor,
  actor: ActorContext,
  seriesId: string,
  contextId: string,
): Promise<SeriesMove> {
  return inTransaction(exec, async (tx) => {
    const before = await getSeries(tx, seriesId)
    const destination = await getContext(tx, contextId)
    if (before.contextId === contextId) return { series: before, moved: [], stayed: [] }

    const [taken] = await tx
      .select({ id: series.id })
      .from(series)
      .where(and(eq(series.contextId, contextId), sql`lower(${series.name}) = lower(${before.name})`))
      .limit(1)
    if (taken) {
      throw new ValidationError(
        `There is already a series called ${before.name} in ${destination.name}.`,
      )
    }

    const occurrences = await tx
      .select()
      .from(meetings)
      .where(and(eq(meetings.seriesId, seriesId), isNull(meetings.parentMeetingId)))
    const moved: string[] = []
    const stayed: string[] = []
    for (const occurrence of occurrences) {
      const ids = await withSessions(tx, occurrence.id)
      if (await whyItStays(tx, ids, occurrence.title)) {
        stayed.push(occurrence.id)
      } else {
        await relocate(tx, actor, ids, contextId, { keepSeries: true })
        moved.push(occurrence.id)
      }
    }
    /* Whatever is still in the old context leaves the series: what stayed, and
       a session filed under the series whose own meeting is not in it. */
    await tx
      .update(meetings)
      .set({ seriesId: null, updatedAt: new Date() })
      .where(and(eq(meetings.seriesId, seriesId), ne(meetings.contextId, contextId)))

    await tx.delete(seriesProjects).where(eq(seriesProjects.seriesId, seriesId))
    const aimed = await tx
      .update(items)
      .set({ targetSeriesId: null, updatedAt: new Date() })
      .where(eq(items.targetSeriesId, seriesId))
      .returning({ id: items.id })
    if (aimed.length > 0) {
      await tx.insert(itemEvents).values(
        aimed.map((item) => ({
          itemId: item.id,
          type: 'targeted',
          data: { meetingId: null, seriesId: null },
          source: actor.source,
          requestId: actor.requestId,
        })),
      )
    }
    await tx
      .update(series)
      .set({ contextId, groupId: null, updatedAt: new Date() })
      .where(eq(series.id, seriesId))

    const views = async (ids: string[]) => {
      const list: MeetingView[] = []
      for (const id of ids) list.push(await getMeeting(tx, id))
      return list
    }
    return { series: await getSeries(tx, seriesId), moved: await views(moved), stayed: await views(stayed) }
  })
}
