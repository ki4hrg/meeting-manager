/*
 * Processing runs: one pass over one version of a note (docs/SPEC.md,
 * "Processing").
 *
 * A run reads the verbatim lines by code, then hands the note to the extractor
 * if there is one, and stores what comes back as proposals. It writes nothing
 * else: items, documents and meetings appear only when a proposal is accepted.
 *
 * The model is called outside any transaction and everything the run writes is
 * committed in one afterwards, so a note is never half processed. When the
 * model fails, the verbatim proposals are still stored (they never needed it)
 * and the run is marked failed, to be queued again.
 *
 * What the extractor returns is not trusted. Every draft is rebuilt and bound
 * to the meeting's context before it is stored; an id from another context is
 * a leak, and is dropped here rather than at review.
 */

import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm'
import { toLocalInput, todayIn } from '../core/dates'
import { normalise } from '../core/match'
import {
  NotFoundError,
  inTransaction,
  type ActorContext,
  type Executor,
} from '../core/types'
import { getAgenda } from '../agenda/lines'
import {
  agendaLines,
  groups,
  notes,
  people,
  processingRuns,
  projects,
  proposals,
  users,
  type ProposalPayload,
  type RunOutput,
} from '../db/schema'
import { findSelf } from '../directory/people'
import { isOpen, listItems, type ItemView } from '../items/items'
import { getMeeting, type MeetingView } from '../meetings/meetings'
import { getNote, listNotes, meetingOf } from '../notes/notes'
import { addProposals, cleanPayload, fingerprintOf, type ProposalDraft } from './proposals'
import type { ExtractionInput, ExtractionOutput, Extractor, VerbatimLine } from './types'
import { parseVerbatim, resolveVerbatim } from './verbatim'

export type Run = typeof processingRuns.$inferSelect

export type RunExtractor = { extractor: Extractor; model: string }

/* A run left "running" this long was abandoned by a process that died under
   it; the job picks it up again. */
const STALE_MINUTES = 15

async function getRun(exec: Executor, id: string): Promise<Run> {
  const [row] = await exec.select().from(processingRuns).where(eq(processingRuns.id, id)).limit(1)
  if (!row) throw new NotFoundError('Run', id)
  return row
}

/**
 * Queue a run for the note as it stands. Null when this version of the note
 * already has one, whatever became of it: the same content is not processed
 * twice unless `reprocessMeeting` asks. Null too while the note is unfiled.
 */
export async function queueRun(exec: Executor, noteId: string): Promise<Run | null> {
  const note = await getNote(exec, noteId)
  // An unfiled note has no context to be read against; it is run once filed.
  if (note.meetingId === null) return null
  const [row] = await exec
    .insert(processingRuns)
    .values({ noteId, contentHash: note.contentHash })
    .onConflictDoNothing({ target: [processingRuns.noteId, processingRuns.contentHash] })
    .returning()
  return row ?? null
}

/**
 * Queue every note of the meeting again, whatever its hash: after a failure,
 * after a model was configured, or after the people were corrected. What has
 * been accepted or rejected stays so, because proposals are matched by
 * fingerprint. A run already waiting or under way is left alone.
 */
export async function reprocessMeeting(
  exec: Executor,
  _actor: ActorContext,
  meetingId: string,
): Promise<Run[]> {
  await getMeeting(exec, meetingId)
  return inTransaction(exec, async (tx) => {
    const runs: Run[] = []
    for (const note of await listNotes(tx, meetingId)) {
      const [row] = await tx
        .insert(processingRuns)
        .values({ noteId: note.id, contentHash: note.contentHash })
        .onConflictDoUpdate({
          target: [processingRuns.noteId, processingRuns.contentHash],
          set: { status: 'queued', error: null, startedAt: null, finishedAt: null },
          setWhere: inArray(processingRuns.status, ['done', 'failed']),
        })
        .returning()
      // No row back: that version is already queued or running.
      if (row) runs.push(row)
    }
    return runs
  })
}

/** The run that says where the meeting's processing stands: one waiting or under way, else the last to finish. */
export async function latestRun(exec: Executor, meetingId: string): Promise<Run | null> {
  const [row] = await exec
    .select({ run: processingRuns })
    .from(processingRuns)
    .innerJoin(notes, eq(notes.id, processingRuns.noteId))
    .where(eq(notes.meetingId, meetingId))
    .orderBy(
      sql`case when ${processingRuns.status} in ('queued', 'running') then 0 else 1 end`,
      sql`coalesce(${processingRuns.finishedAt}, ${processingRuns.createdAt}) desc`,
    )
    .limit(1)
  return row?.run ?? null
}

// ─── what the extractor is given ─────────────────────────────────────────────

/* One user; null means the instance's own zone. */
async function userTimeZone(exec: Executor): Promise<string | null> {
  const [row] = await exec.select({ timeZone: users.timeZone }).from(users).limit(1)
  return row?.timeZone ?? null
}

/* Open items the meeting could be about: on its agenda, or involving one of
   its people, its group or one of its projects. John is not among a meeting's
   people, so nothing is pulled in through him alone. Bound to the meeting's
   context by the query itself. */
async function openItemsFor(exec: Executor, meeting: MeetingView, placed: Set<string>): Promise<ItemView[]> {
  const personIds = new Set(meeting.people.map((person) => person.id))
  const projectIds = new Set(meeting.projects.map((project) => project.id))
  const open = await listItems(exec, { contextId: meeting.contextId, open: true })
  return open.filter(
    (item) =>
      placed.has(item.id) ||
      (item.project !== null && projectIds.has(item.project.id)) ||
      item.parties.some((party) =>
        party.type === 'person' ? personIds.has(party.id) : party.id === meeting.group?.id,
      ),
  )
}

function handledText(payload: ProposalPayload, itemText: Map<string, string>): string {
  switch (payload.type) {
    case 'item':
      return payload.text
    case 'update':
      return `${payload.change}: ${itemText.get(payload.itemId) ?? payload.itemId}`
    case 'document':
      return payload.title
    case 'stub':
      return payload.title
  }
}

/**
 * Everything the extractor sees for one note: the meeting, its agenda, the
 * open items it could be about, the directory names can resolve to, and what
 * is already captured or already proposed so it is not proposed again.
 */
export async function buildExtractionInput(exec: Executor, noteId: string): Promise<ExtractionInput> {
  const note = await getNote(exec, noteId)
  const meeting = await getMeeting(exec, meetingOf(note))
  const timeZone = await userTimeZone(exec)
  const self = await findSelf(exec)

  const agenda = await getAgenda(exec, meeting.id, { timeZone })
  const lines: ExtractionInput['agenda'] = []
  for (const node of agenda.nodes) {
    if (node.type === 'line') {
      lines.push({ lineId: node.id, section: null, text: node.text, itemId: node.item?.id ?? null })
      continue
    }
    // An empty section is still something the meeting set out to cover.
    if (node.lines.length === 0) {
      lines.push({ lineId: node.id, section: null, text: node.title, itemId: null })
    }
    for (const line of node.lines) {
      lines.push({ lineId: line.id, section: node.title, text: line.text, itemId: line.item?.id ?? null })
    }
  }
  const placed = new Set(lines.flatMap((line) => (line.itemId ? [line.itemId] : [])))

  const openItems = await openItemsFor(exec, meeting, placed)
  const captured = await listItems(exec, {
    contextId: meeting.contextId,
    originMeetingId: meeting.id,
  })

  const existing = await exec
    .select({ payload: proposals.payload })
    .from(proposals)
    .where(eq(proposals.meetingId, meeting.id))
    .orderBy(asc(proposals.position))
  const itemText = new Map(openItems.map((item) => [item.id, item.text]))

  const [allPeople, contextGroups, contextProjects] = await Promise.all([
    exec.select({ id: people.id, name: people.name }).from(people).orderBy(asc(people.name)),
    exec
      .select({ id: groups.id, name: groups.name })
      .from(groups)
      .where(eq(groups.contextId, meeting.contextId))
      .orderBy(asc(groups.name)),
    exec
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(eq(projects.contextId, meeting.contextId))
      .orderBy(asc(projects.name)),
  ])

  const names = (item: ItemView, role: 'owner' | 'with') =>
    item.parties.filter((party) => party.role === role).map((party) => party.name)

  return {
    meeting: {
      id: meeting.id,
      title: meeting.title,
      startsAt: meeting.startsAt ? toLocalInput(meeting.startsAt, timeZone).replace('T', ' ') : null,
      people: meeting.people,
      group: meeting.group,
      projects: meeting.projects,
    },
    self: self ? { id: self.id, name: self.name } : { id: '', name: 'Me' },
    today: todayIn(timeZone, meeting.startsAt ?? new Date()),
    note: { body: note.body, summary: note.summary, transcript: note.transcript },
    agenda: lines,
    openItems: openItems.map((item) => ({
      id: item.id,
      kind: item.kind,
      text: item.text,
      detail: item.detail,
      owners: names(item, 'owner'),
      with: names(item, 'with'),
      project: item.project?.name ?? null,
      dueOn: item.dueOn,
    })),
    directory: { people: allPeople, groups: contextGroups, projects: contextProjects },
    verbatim: parseVerbatim(note.body),
    captured: captured.map((item) => ({ kind: item.kind, text: item.text })),
    handled: existing.map((row) => handledText(row.payload, itemText)),
  }
}

// ─── processing ──────────────────────────────────────────────────────────────

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 2000) || 'Processing failed.'
}

async function finish(
  exec: Executor,
  runId: string,
  patch: Pick<Run, 'status'> & Partial<Pick<Run, 'model' | 'error' | 'output'>>,
): Promise<Run> {
  const [row] = await exec
    .update(processingRuns)
    .set({ model: null, error: null, output: null, ...patch, finishedAt: new Date() })
    .where(eq(processingRuns.id, runId))
    .returning()
  return row!
}

/* The model's drafts, cut down to what may be stored: each bound to the
   meeting's context, none repeating a verbatim line or an item already
   captured in the meeting, none changing an item that is already closed. */
async function vetDrafts(
  exec: Executor,
  meeting: MeetingView,
  taken: Set<string>,
  drafts: unknown,
): Promise<ProposalDraft[]> {
  const kept: ProposalDraft[] = []
  for (const draft of Array.isArray(drafts) ? (drafts as Partial<ExtractionOutput['drafts'][number]>[]) : []) {
    if (!draft || typeof draft !== 'object' || !draft.payload || typeof draft.payload !== 'object') {
      continue
    }
    const { payload } = await cleanPayload(exec, meeting.contextId, draft.payload, {
      resolveNames: true,
    })
    if (!payload) continue
    if (payload.type === 'item' && taken.has(normalise(payload.text))) continue
    if (payload.type === 'update') {
      const [item] = await listItems(exec, { contextId: meeting.contextId, ids: [payload.itemId] })
      if (!item || !isOpen(item)) continue
    }
    kept.push({
      payload,
      lowConfidence: draft.lowConfidence === true,
      agendaLineId: typeof draft.agendaLineId === 'string' ? draft.agendaLineId : null,
    })
  }
  return kept
}

/* The model's account of the discussion around a verbatim line becomes that
   proposal's detail, while it is still pending and has none: the wording stays
   John's, and so does any detail he has written since. */
async function setVerbatimDetails(
  exec: Executor,
  meetingId: string,
  verbatim: ProposalDraft[],
  details: unknown,
) {
  for (const entry of Array.isArray(details) ? (details as ExtractionOutput['verbatimDetails']) : []) {
    const draft = verbatim[entry?.index]
    const detail = typeof entry?.detail === 'string' ? entry.detail.trim() : ''
    if (!draft || detail === '') continue

    const [row] = await exec
      .select()
      .from(proposals)
      .where(
        and(
          eq(proposals.meetingId, meetingId),
          eq(proposals.fingerprint, fingerprintOf(draft.payload)),
          eq(proposals.status, 'pending'),
          eq(proposals.verbatim, true),
        ),
      )
      .limit(1)
    if (!row || row.payload.type !== 'item' || row.payload.detail) continue
    await exec
      .update(proposals)
      .set({ payload: { ...row.payload, detail }, updatedAt: new Date() })
      .where(eq(proposals.id, row.id))
  }
}

async function runOutput(exec: Executor, meetingId: string, output: ExtractionOutput): Promise<RunOutput> {
  const own = new Set(
    (
      await exec
        .select({ id: agendaLines.id })
        .from(agendaLines)
        .where(eq(agendaLines.meetingId, meetingId))
    ).map((row) => row.id),
  )
  const lines = (Array.isArray(output.lines) ? output.lines : [])
    .filter((line) => line && own.has(line.lineId) && typeof line.summary === 'string')
    .map((line) => ({ lineId: line.lineId, summary: line.summary.trim() }))
    .filter((line) => line.summary !== '')
  const summary = typeof output.summary === 'string' ? output.summary.trim() || null : null
  return { summary, lines }
}

/**
 * Process one queued run. Claiming it (queued to running) is one statement, so
 * two workers cannot both take it; a run that is not queued is returned as it
 * is. With no extractor the run completes on the verbatim lines alone, with
 * `model` null.
 *
 * Never throws for a failure of the model or of the processing itself: the run
 * is marked failed with the message, and can be queued again.
 */
export async function processRun(
  exec: Executor,
  runId: string,
  extractor?: RunExtractor | null,
): Promise<Run> {
  const [claimed] = await exec
    .update(processingRuns)
    .set({
      status: 'running',
      attempts: sql`${processingRuns.attempts} + 1`,
      startedAt: new Date(),
      finishedAt: null,
      error: null,
    })
    .where(and(eq(processingRuns.id, runId), eq(processingRuns.status, 'queued')))
    .returning()
  if (!claimed) return getRun(exec, runId)

  try {
    const note = await getNote(exec, claimed.noteId)
    if (note.contentHash !== claimed.contentHash) {
      // The note was edited while this waited; the run for the new version does the work.
      return await finish(exec, runId, { status: 'done', error: 'The note changed before this ran.' })
    }

    const meeting = await getMeeting(exec, meetingOf(note))
    const where = { meetingId: meeting.id, noteId: note.id, runId }

    const lines: VerbatimLine[] = parseVerbatim(note.body)
    const verbatim: ProposalDraft[] = []
    for (const line of lines) {
      verbatim.push({
        payload: await resolveVerbatim(exec, meeting.contextId, line),
        verbatim: true,
      })
    }

    let output: ExtractionOutput | null = null
    if (extractor) {
      const input = await buildExtractionInput(exec, note.id)
      try {
        output = await extractor.extractor(input)
      } catch (error) {
        return await inTransaction(exec, async (tx) => {
          await addProposals(tx, where, verbatim)
          return finish(tx, runId, {
            status: 'failed',
            model: extractor.model,
            error: messageOf(error),
          })
        })
      }
    }

    return await inTransaction(exec, async (tx) => {
      await addProposals(tx, where, verbatim)
      if (!output || !extractor) return finish(tx, runId, { status: 'done' })

      const captured = await listItems(tx, {
        contextId: meeting.contextId,
        originMeetingId: meeting.id,
      })
      const taken = new Set([
        ...lines.map((line) => normalise(line.text)),
        ...verbatim.map((draft) => (draft.payload.type === 'item' ? normalise(draft.payload.text) : '')),
        ...captured.map((item) => normalise(item.text)),
      ])

      await addProposals(tx, where, await vetDrafts(tx, meeting, taken, output.drafts))
      await setVerbatimDetails(tx, meeting.id, verbatim, output.verbatimDetails)
      return finish(tx, runId, {
        status: 'done',
        model: extractor.model,
        output: await runOutput(tx, meeting.id, output),
      })
    })
  } catch (error) {
    return finish(exec, runId, { status: 'failed', error: messageOf(error) })
  }
}

/**
 * Every queued run, oldest first: what the job calls. A run abandoned while
 * running is put back in the queue first.
 */
export async function processQueued(
  exec: Executor,
  extractor?: RunExtractor | null,
): Promise<{ processed: number; failed: number }> {
  await exec
    .update(processingRuns)
    .set({ status: 'queued' })
    .where(
      and(
        eq(processingRuns.status, 'running'),
        lt(processingRuns.startedAt, new Date(Date.now() - STALE_MINUTES * 60_000)),
      ),
    )

  const queued = await exec
    .select({ id: processingRuns.id })
    .from(processingRuns)
    .where(eq(processingRuns.status, 'queued'))
    .orderBy(asc(processingRuns.createdAt), asc(processingRuns.id))

  let processed = 0
  let failed = 0
  for (const { id } of queued) {
    const run = await processRun(exec, id, extractor)
    if (run.status === 'done') processed++
    else if (run.status === 'failed') failed++
  }
  return { processed, failed }
}
