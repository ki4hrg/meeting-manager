/*
 * The processing tools: log a meeting, process its notes, review what was
 * proposed, and render the recap.
 *
 * Thin over the domain layer. A meeting is named by its id and everything asked
 * of it happens in its own context; a context given alongside is a check, and a
 * meeting from another one is refused. A proposal is only reachable through
 * the meeting it belongs to.
 *
 * Nothing is processed here. A tool that queues a run kicks the job once its
 * own write has committed, and returns the run as queued.
 */

import { z } from 'zod'
import { ValidationError, type Executor, type Tx } from '@/lib/core/types'
import {
  getRecap,
  recapSubject,
  renderPersonSnippet,
  renderRecap,
} from '../../agenda/recap'
import { formatTime, formatWeekday, fromLocalInput, todayIn } from '../../core/dates'
import type { ProposalPayload, ProposedParty } from '../../db/schema'
import { findSelf } from '../../directory/people'
import {
  inferContext,
  resolveGroup,
  resolveParty,
  resolvePerson,
  resolveProject,
} from '../../directory/resolve'
import { PROCESS_NOTES, kick } from '../../jobs'
import { dismissHeldNote, fileHeldNote, listUnfiledNotes } from '../../connect/granola/unfiled'
import { logMeeting } from '../../meetings/log'
import { getMeeting, type MeetingView } from '../../meetings/meetings'
import { listNotes } from '../../notes/notes'
import {
  acceptProposal,
  approveAll,
  editProposal,
  getProposal,
  listProposals,
  rejectProposal,
  undoProposal,
  type ProposalParty,
  type ProposalView,
} from '../../processing/proposals'
import { latestRun, reprocessMeeting, type Run } from '../../processing/run'
import { clockFor, idempotencyKey, itemOut, write, type Clock } from './shared'
import { defineTool } from './types'

// ─── shared arguments ────────────────────────────────────────────────────────

const meetingId = z.uuid().describe('Meeting id.')

const contextCheck = z
  .string()
  .min(1)
  .optional()
  .describe('Context name or id. Given, the meeting must be in it.')

const momentArg =
  'ISO 8601. With an offset or Z it is that instant; without one it is read on the account clock.'

// ─── moments ─────────────────────────────────────────────────────────────────

const HAS_OFFSET = /T.*(?:Z|[+-]\d{2}:?\d{2})$/i

/* As the meeting tools read one: an instant when it carries an offset,
   otherwise a wall time in the account's zone. */
function momentFrom(value: string, clock: Clock): Date {
  const trimmed = value.trim()
  if (!HAS_OFFSET.test(trimmed)) return fromLocalInput(trimmed, clock.timeZone)
  const moment = new Date(trimmed)
  if (Number.isNaN(moment.getTime())) {
    throw new ValidationError(`${value} is not a date and time.`)
  }
  return moment
}

/** "Tue, Oct 20, 3:05 PM" on the account's clock. */
function localOf(moment: Date | null, clock: Clock): string | null {
  if (!moment) return null
  const day = formatWeekday(todayIn(clock.timeZone, moment), clock.today)
  return `${day}, ${formatTime(moment, clock.timeZone)}`
}

// ─── the job ─────────────────────────────────────────────────────────────────

/*
 * Ask the job to run now instead of at its next tick. Called after the write
 * has committed, or the job would look before the run exists. Not awaited: with
 * a model configured a run takes longer than a tool call should.
 *
 * `kick` runs the job whatever the scheduler's own guards say, so the two that
 * matter are repeated here: under Vitest it would reach for whatever database
 * DATABASE_URL names, and with WORKER=off this process is not to process notes.
 * Either way the run stays queued for a process whose timer is running.
 */
function kickProcessing() {
  if (process.env.VITEST || process.env.WORKER === 'off') return
  try {
    void kick(PROCESS_NOTES)
  } catch (err) {
    // No such job in this process: the run waits for the timer of one that has it.
    console.error('[mcp] could not kick processing', err)
  }
}

// ─── finding ─────────────────────────────────────────────────────────────────

/* The meeting, refused when a context was named and it is not that one's. */
async function meetingIn(
  exec: Executor,
  id: string,
  context: string | undefined,
): Promise<MeetingView> {
  const named = context === undefined ? null : await inferContext(exec, { context })
  const meeting = await getMeeting(exec, id)
  if (named && named.id !== meeting.contextId) {
    throw new ValidationError('That meeting belongs to another context.')
  }
  return meeting
}

/* A proposal id is only good on the meeting it was listed under: this is what
   keeps a review of one meeting from settling a proposal of another. */
async function proposalOn(exec: Executor, meeting: MeetingView, id: string): Promise<ProposalView> {
  const [found] = (await listProposals(exec, meeting.id)).filter((proposal) => proposal.id === id)
  if (!found) throw new ValidationError(`No proposal of this meeting has the id ${id}.`)
  return found
}

// ─── wire shapes ─────────────────────────────────────────────────────────────

function meetingOut(meeting: MeetingView, clock: Clock) {
  return {
    id: meeting.id,
    context_id: meeting.contextId,
    title: meeting.title,
    starts_at: meeting.startsAt?.toISOString() ?? null,
    starts_at_local: localOf(meeting.startsAt, clock),
    ends_at: meeting.endsAt?.toISOString() ?? null,
    ends_at_local: localOf(meeting.endsAt, clock),
    series: meeting.series,
    groups: meeting.groups,
    people: meeting.people,
    attendees: meeting.attendees,
    projects: meeting.projects,
    parent_meeting_id: meeting.parentMeetingId,
  }
}

function runOut(run: Run | null, clock: Clock) {
  if (!run) return null
  return {
    id: run.id,
    note_id: run.noteId,
    status: run.status,
    model: run.model,
    error: run.error,
    finished_at: run.finishedAt?.toISOString() ?? null,
    finished_at_local: localOf(run.finishedAt, clock),
  }
}

function partyOut(party: ProposalParty) {
  return {
    type: party.type,
    id: party.id,
    name: party.name,
    ...(party.unresolved ? { unresolved: true } : {}),
  }
}

function proposalOut(proposal: ProposalView, clock: Clock) {
  const { payload } = proposal
  const parties = (role: 'owner' | 'with') =>
    proposal.parties.filter((party) => party.role === role).map(partyOut)

  let about: Record<string, unknown>
  if (payload.type === 'item') {
    about = {
      kind: payload.kind,
      text: payload.text,
      detail: payload.detail ?? null,
      resolution: payload.resolution ?? null,
      owners: parties('owner'),
      with: parties('with'),
      project: proposal.project,
      due_on: payload.dueOn ?? null,
      parent_item: proposal.parent
        ? { id: proposal.parent.id, kind: proposal.parent.kind, text: proposal.parent.text }
        : null,
    }
  } else if (payload.type === 'update') {
    about = {
      change: payload.change,
      text: payload.text ?? null,
      item: proposal.item ? itemOut(proposal.item) : null,
    }
  } else if (payload.type === 'document') {
    about = { title: payload.title, body: payload.body, project: proposal.project }
  } else {
    about = { title: payload.title, people: proposal.parties.map(partyOut) }
  }

  return {
    id: proposal.id,
    status: proposal.status,
    type: payload.type,
    ...about,
    verbatim: proposal.verbatim,
    low_confidence: proposal.lowConfidence,
    unresolved: proposal.unresolved,
    agenda_line: proposal.agendaLine,
    made: proposal.made
      ? {
          item: proposal.made.item ? itemOut(proposal.made.item) : null,
          document: proposal.made.document,
          meeting: proposal.made.meeting,
        }
      : null,
    resolved_at: proposal.resolvedAt?.toISOString() ?? null,
    resolved_at_local: localOf(proposal.resolvedAt, clock),
  }
}

function countsOf(proposals: ProposalView[]) {
  const count = (status: ProposalView['status']) =>
    proposals.filter((proposal) => proposal.status === status).length
  return { pending: count('pending'), accepted: count('accepted'), rejected: count('rejected') }
}

// ─── logging and processing ──────────────────────────────────────────────────

const VERBATIM_RULE =
  'Lines of the notes that start D: (decision), Q: (question), A: (action) or T: (topic) are ' +
  'proposed in exactly that wording, with @person and #project read as quick-add reads them.'

export const logMeetingTool = defineTool({
  name: 'log_meeting',
  title: 'Log a meeting',
  description:
    'Record a meeting that has happened, from notes: for a conversation nobody recorded, or ' +
    'when Granola missed one. Creates the meeting with its people, saves the notes and queues ' +
    `processing. ${VERBATIM_RULE} Nothing becomes an item until its proposal is accepted: ` +
    'read them with list_proposals, whose run says whether processing has finished. starts_at ' +
    'defaults to now. With a group and no people, its members are who was there. This creates ' +
    'a meeting on every call, so pass idempotency_key.',
  scope: 'meetings:write',
  input: z.object({
    notes: z.string().min(1).describe('The notes, as written.'),
    context: z.string().min(1).optional().describe('Context name or id. Needed when there are several.'),
    title: z.string().min(1).optional().describe("Defaults to the people's names."),
    starts_at: z.string().min(1).optional().describe(momentArg),
    minutes: z.number().int().min(0).max(1440).optional().describe('How long it ran.'),
    people: z.array(z.string().min(1)).optional().describe('People, by name or id.'),
    group: z.string().min(1).optional().describe('Group name or id: one of groups.'),
    groups: z
      .array(z.string().min(1))
      .optional()
      .describe('Groups, by name or id. With nobody in people, their members were there.'),
    projects: z.array(z.string().min(1)).optional().describe('Projects, by name or id.'),
    idempotency_key: idempotencyKey,
  }),
  handler: async (input, context) => {
    const result = await write(context, 'log_meeting', input, async (tx) => {
      const clock = await clockFor(tx, context)
      const target = await inferContext(tx, {
        context: input.context,
        project: input.projects?.[0],
        parties: [...(input.group ? [input.group] : []), ...(input.groups ?? [])],
      })
      const groupIds: string[] = []
      for (const ref of [...(input.group ? [input.group] : []), ...(input.groups ?? [])]) {
        groupIds.push((await resolveGroup(tx, target.id, ref)).id)
      }

      const personIds: string[] = []
      for (const ref of input.people ?? []) personIds.push((await resolvePerson(tx, ref)).id)
      const projectIds: string[] = []
      for (const ref of input.projects ?? []) {
        projectIds.push((await resolveProject(tx, target.id, ref)).id)
      }

      const logged = await logMeeting(
        tx,
        context.actor,
        {
          contextId: target.id,
          title: input.title,
          startsAt: input.starts_at ? momentFrom(input.starts_at, clock) : null,
          minutes: input.minutes,
          personIds: [...new Set(personIds)],
          groupIds,
          projectIds: [...new Set(projectIds)],
          notes: input.notes,
        },
        clock.now,
      )
      return {
        context: { id: target.id, name: target.name },
        meeting: meetingOut(logged.meeting, clock),
        note_id: logged.noteId,
        run: runOut(await latestRun(tx, logged.meeting.id), clock),
      }
    })
    kickProcessing()
    return result
  },
})

export const processMeetingTool = defineTool({
  name: 'process_meeting',
  title: 'Process a meeting again',
  description:
    'Queue every note of a meeting for processing again: after a failed run, or after its ' +
    'people or the directory were corrected. Proposals already accepted or rejected stay so; ' +
    'only what is new is proposed. queued is how many notes were queued (0 when a run is ' +
    'already waiting or under way). Processing happens in the background: list_proposals ' +
    'shows the run and what it proposed.',
  scope: 'meetings:write',
  input: z.object({ id: meetingId, context: contextCheck, idempotency_key: idempotencyKey }),
  handler: async (input, context) => {
    const result = await write(context, 'process_meeting', input, async (tx) => {
      const clock = await clockFor(tx, context)
      const meeting = await meetingIn(tx, input.id, input.context)
      if ((await listNotes(tx, meeting.id)).length === 0) {
        throw new ValidationError('That meeting has no notes to process.')
      }
      const runs = await reprocessMeeting(tx, context.actor, meeting.id)
      return {
        meeting: meetingOut(meeting, clock),
        queued: runs.length,
        run: runOut(await latestRun(tx, meeting.id), clock),
      }
    })
    kickProcessing()
    return result
  },
})

// ─── the Inbox ───────────────────────────────────────────────────────────────

export const listUnfiledNotesTool = defineTool({
  name: 'list_unfiled_notes',
  title: 'List unfiled notes',
  description:
    'Granola notes waiting in the Inbox: from no folder that feeds a context, or from folders ' +
    'that feed two, and not on a meeting made for their calendar event. They belong to no ' +
    'context yet and nothing has been processed. Each has its title, when it was and who the ' +
    'note names. File one with file_note.',
  scope: 'meetings:read',
  input: z.object({}),
  annotations: { readOnlyHint: true },
  handler: async (_input, context) => {
    const clock = await clockFor(context.exec, context)
    return {
      notes: (await listUnfiledNotes(context.exec)).map((note) => ({
        id: note.id,
        title: note.title,
        starts_at: note.startsAt?.toISOString() ?? null,
        starts_at_local: localOf(note.startsAt, clock),
        ends_at: note.endsAt?.toISOString() ?? null,
        attendees: note.attendees,
      })),
    }
  },
})

export const fileNoteTool = defineTool({
  name: 'file_note',
  title: 'File a note from the Inbox',
  description:
    'File an unfiled note in a context: on the meeting there that holds its calendar event, ' +
    'else the one that was under way when it started, else a meeting of its own with the ' +
    'people it names who are in the directory. Or meeting: a meeting id to file it on instead ' +
    '(a session, if the meeting has sessions). It is then processed like any arriving note. ' +
    'Or dismiss: true takes it out of the Inbox. Returns the meeting it was filed on.',
  scope: 'meetings:write',
  input: z.object({
    id: z.uuid().describe('Note id, from list_unfiled_notes.'),
    context: z
      .string()
      .min(1)
      .optional()
      .describe('Context name or id. Needed when there are several and no meeting is given.'),
    meeting: z.uuid().optional().describe('Meeting id to file it on, instead of the match.'),
    dismiss: z.boolean().optional(),
    idempotency_key: idempotencyKey,
  }),
  handler: async (input, context) => {
    const result = await write(context, 'file_note', input, async (tx) => {
      if (input.dismiss) {
        if (input.context || input.meeting) {
          throw new ValidationError('A dismissed note goes to no context.')
        }
        await dismissHeldNote(tx, context.actor, input.id)
        return { dismissed: true }
      }
      const clock = await clockFor(tx, context)
      const chosen = input.meeting ? await getMeeting(tx, input.meeting) : null
      const target =
        chosen && !input.context
          ? { id: chosen.contextId }
          : await inferContext(tx, { context: input.context })
      const { meetingId, via } = await fileHeldNote(tx, context.actor, input.id, target.id, {
        meetingId: chosen?.id,
      })
      return { meeting: meetingOut(await getMeeting(tx, meetingId), clock), via }
    })
    if (!input.dismiss) kickProcessing()
    return result
  },
})

// ─── review ──────────────────────────────────────────────────────────────────

const PROPOSAL_SHAPE =
  'A proposal has a type. item: a new topic, question, action or decision (kind, text, ' +
  'detail, resolution when it was settled in the meeting, owners, with, project, due_on, ' +
  'parent_item). update: a change to an existing item (complete, answer, drop, note or ' +
  'discussed, with its text). document: drafted content to keep (title, body, project). ' +
  'stub: a follow-up meeting to schedule (title, people).'

export const listProposalsTool = defineTool({
  name: 'list_proposals',
  title: 'List proposals',
  description:
    'What processing proposed for one meeting, pending first, and where processing stands ' +
    `(run: queued, running, done or failed, with its error). ${PROPOSAL_SHAPE} verbatim marks ` +
    'my own D:/Q:/A:/T: line, kept in my wording. low_confidence marks a guess, usually at the ' +
    'owner. unresolved lists names that match nobody yet; such a proposal cannot be accepted ' +
    'until edited. made is what accepting it created.',
  scope: 'meetings:read',
  input: z.object({
    id: meetingId,
    context: contextCheck,
    status: z.enum(['pending', 'accepted', 'rejected']).optional().describe('Only these.'),
  }),
  annotations: { readOnlyHint: true },
  handler: async (input, context) => {
    const { exec } = context
    const clock = await clockFor(exec, context)
    const meeting = await meetingIn(exec, input.id, input.context)
    const all = await listProposals(exec, meeting.id)
    const shown = input.status ? all.filter((proposal) => proposal.status === input.status) : all
    return {
      meeting: meetingOut(meeting, clock),
      run: runOut(await latestRun(exec, meeting.id), clock),
      counts: countsOf(all),
      proposals: shown.map((proposal) => proposalOut(proposal, clock)),
    }
  },
})

const RESOLVE_OPS = ['accept', 'reject', 'undo', 'edit', 'approve_all'] as const

type ResolveOp = (typeof RESOLVE_OPS)[number]

const CHANGE_FIELDS = [
  'kind',
  'text',
  'detail',
  'resolution',
  'owners',
  'with',
  'project',
  'due_on',
  'parent_item_id',
  'change',
  'title',
  'body',
  'people',
] as const

type ChangeField = (typeof CHANGE_FIELDS)[number]

/* What each type of proposal can have changed. Anything else given with it is
   refused rather than ignored: a field that silently did nothing reads as a
   change that was made. */
const TYPE_TAKES: Record<ProposalPayload['type'], readonly ChangeField[]> = {
  item: ['kind', 'text', 'detail', 'resolution', 'owners', 'with', 'project', 'due_on', 'parent_item_id'],
  update: ['change', 'text'],
  document: ['title', 'body', 'project'],
  stub: ['title', 'people'],
}

const resolveInput = z.object({
  id: meetingId,
  context: contextCheck,
  op: z.enum(RESOLVE_OPS),
  proposal_id: z.uuid().optional().describe('A proposal of this meeting. Not with approve_all.'),
  kind: z.enum(['topic', 'question', 'action', 'decision']).optional(),
  text: z.string().nullable().optional().describe('The wording; on an update, its answer, outcome or note.'),
  detail: z.string().nullable().optional(),
  resolution: z.string().nullable().optional().describe('How it was settled in the meeting.'),
  owners: z.array(z.string().min(1)).optional().describe('People or groups, by name or id.'),
  with: z.array(z.string().min(1)).optional().describe('People or groups, by name or id.'),
  project: z.string().min(1).nullable().optional().describe('Project name or id.'),
  due_on: z.string().nullable().optional().describe('A deadline, YYYY-MM-DD.'),
  parent_item_id: z.uuid().nullable().optional().describe('The item this one came out of.'),
  change: z.enum(['complete', 'answer', 'drop', 'note', 'discussed']).optional(),
  title: z.string().min(1).optional(),
  body: z.string().min(1).optional(),
  people: z.array(z.string().min(1)).optional().describe('People, by name or id.'),
  idempotency_key: idempotencyKey,
})

type ResolveInput = z.infer<typeof resolveInput>

function changesIn(input: ResolveInput): ChangeField[] {
  return CHANGE_FIELDS.filter((field) => input[field] !== undefined)
}

/*
 * The proposal's payload with the given fields laid over it. Names are resolved
 * here, the way the other tools resolve them, so an ambiguous one is refused
 * with its candidates; owners, with and people each replace their whole list,
 * which is also how a name the notes left unresolved gets settled.
 */
async function editedPayload(
  tx: Tx,
  contextId: string,
  proposal: ProposalView,
  input: ResolveInput,
): Promise<ProposalPayload> {
  const { payload } = proposal
  const stray = changesIn(input).filter((field) => !TYPE_TAKES[payload.type].includes(field))
  if (stray.length > 0) {
    const article = payload.type === 'stub' ? 'A' : 'An'
    throw new ValidationError(
      `${article} ${payload.type} proposal does not take ${stray.join(', ')}.`,
    )
  }

  const projectId = async (current: string | null | undefined) =>
    input.project === undefined
      ? current
      : input.project === null
        ? null
        : (await resolveProject(tx, contextId, input.project)).id

  if (payload.type === 'item') {
    const side = async (role: 'owner' | 'with', refs: string[] | undefined) => {
      if (refs === undefined) return payload.parties.filter((party) => party.role === role)
      const parties: ProposedParty[] = []
      for (const ref of refs) {
        const party = await resolveParty(tx, contextId, ref)
        parties.push(
          party.type === 'person'
            ? { role, name: party.name, personId: party.id }
            : { role, name: party.name, groupId: party.id },
        )
      }
      return parties
    }
    return {
      ...payload,
      kind: input.kind ?? payload.kind,
      text: input.text === undefined ? payload.text : (input.text ?? ''),
      detail: input.detail === undefined ? payload.detail : input.detail,
      resolution: input.resolution === undefined ? payload.resolution : input.resolution,
      parties: [...(await side('owner', input.owners)), ...(await side('with', input.with))],
      projectId: await projectId(payload.projectId),
      dueOn: input.due_on === undefined ? payload.dueOn : input.due_on,
      parentItemId:
        input.parent_item_id === undefined ? payload.parentItemId : input.parent_item_id,
    }
  }

  if (payload.type === 'update') {
    return {
      ...payload,
      change: input.change ?? payload.change,
      text: input.text === undefined ? payload.text : input.text,
    }
  }

  if (payload.type === 'document') {
    return {
      ...payload,
      title: input.title ?? payload.title,
      body: input.body ?? payload.body,
      projectId: await projectId(payload.projectId),
    }
  }

  let people = payload.people
  if (input.people !== undefined) {
    people = []
    for (const ref of input.people) {
      const person = await resolvePerson(tx, ref)
      people.push({ name: person.name, personId: person.id })
    }
  }
  return { ...payload, title: input.title ?? payload.title, people }
}

/* Which ops read the change fields. */
const TAKES_CHANGES: Record<ResolveOp, boolean> = {
  accept: true,
  edit: true,
  reject: false,
  undo: false,
  approve_all: false,
}

export const resolveProposalTool = defineTool({
  name: 'resolve_proposal',
  title: 'Resolve a proposal',
  description:
    'Settle what processing proposed for a meeting, chosen by op. accept: make it real (the ' +
    'item, the change to an item, the document or the follow-up meeting); refused while a ' +
    'party is only a name. reject: turn it away; it is remembered and not proposed again. ' +
    'undo: an accepted or rejected proposal back to pending, taking back what accepting made, ' +
    'while nothing has happened to that since. edit: change a pending proposal and leave it ' +
    'pending. accept with any of the same fields edits first, then accepts, in one step. The ' +
    'fields by type: an item takes kind, text, detail, resolution, owners, with, project, ' +
    'due_on, parent_item_id; an update takes change, text; a document takes title, body, ' +
    'project; a stub takes title, people. owners, with and people each replace the whole ' +
    'list; null clears detail, resolution, project, due_on or parent_item_id. approve_all: ' +
    'accept every pending proposal that is not low_confidence and has nobody unresolved, and ' +
    'say how many are left and which were refused. Proposal ids come from list_proposals.',
  scope: 'meetings:write',
  input: resolveInput,
  handler: async (input, context) =>
    write(context, 'resolve_proposal', input, async (tx) => {
      const { actor } = context
      const { op } = input
      const clock = await clockFor(tx, context)
      const meeting = await meetingIn(tx, input.id, input.context)
      const changes = changesIn(input)

      if (!TAKES_CHANGES[op] && changes.length > 0) {
        throw new ValidationError(`${op} does not take ${changes.join(', ')}.`)
      }

      if (op === 'approve_all') {
        if (input.proposal_id !== undefined) {
          throw new ValidationError('approve_all does not take proposal_id.')
        }
        const done = await approveAll(tx, actor, meeting.id)
        return {
          accepted: done.accepted,
          left: done.left,
          refused: done.refused.map(({ id, message }) => ({ proposal_id: id, message })),
          proposals: (await listProposals(tx, meeting.id)).map((proposal) =>
            proposalOut(proposal, clock),
          ),
        }
      }

      if (input.proposal_id === undefined) throw new ValidationError(`${op} needs proposal_id.`)
      const proposal = await proposalOn(tx, meeting, input.proposal_id)

      if (op === 'edit' && changes.length === 0) {
        throw new ValidationError('edit needs something to change.')
      }
      if (changes.length > 0) {
        await editProposal(
          tx,
          actor,
          proposal.id,
          await editedPayload(tx, meeting.contextId, proposal, input),
        )
      }

      if (op === 'accept') await acceptProposal(tx, actor, proposal.id)
      else if (op === 'reject') await rejectProposal(tx, actor, proposal.id)
      else if (op === 'undo') await undoProposal(tx, actor, proposal.id)

      return {
        proposal: proposalOut(await getProposal(tx, proposal.id), clock),
        counts: countsOf(await listProposals(tx, meeting.id)),
      }
    }),
})

// ─── the recap ───────────────────────────────────────────────────────────────

export const renderRecapTool = defineTool({
  name: 'render_recap',
  title: 'Render the recap of a meeting',
  description:
    'The recap of one meeting as markdown, as it goes to the attendees: the summary, what was ' +
    'said under each agenda line, decisions, open questions and actions by owner, what was ' +
    'closed, and the lookahead. It is computed now, from accepted proposals only, and only ' +
    'from items placed on the agenda or captured in the meeting; my private notes never ' +
    'appear. A meeting with sessions gets one recap covering them. Also the subject line and ' +
    'the recipients with an address. for: a person or group, to add their "your items" ' +
    'snippet (what they owe from this meeting and what I owe them; empty when neither).',
  scope: 'meetings:read',
  input: z.object({
    id: meetingId,
    context: contextCheck,
    for: z.string().min(1).optional().describe('Person or group, by name or id.'),
  }),
  annotations: { readOnlyHint: true },
  handler: async (input, context) => {
    const { exec } = context
    const clock = await clockFor(exec, context)
    const meeting = await meetingIn(exec, input.id, input.context)
    const party = input.for ? await resolveParty(exec, meeting.contextId, input.for) : null
    const self = await findSelf(exec)

    const recap = await getRecap(exec, meeting.id, {
      today: clock.today,
      timeZone: clock.timeZone,
      // No person row for the account yet: nobody is "me", and nothing is hidden by it.
      selfId: self?.id ?? '',
      now: clock.now,
    })

    return {
      meeting: meetingOut(meeting, clock),
      subject: recapSubject(recap),
      markdown: renderRecap(recap),
      recipients: recap.recipients.map(({ name, email }) => ({ name, email })),
      ...(party ? { snippet: { for: party, markdown: renderPersonSnippet(recap, party) } } : {}),
    }
  },
})

export const processingTools = [
  logMeetingTool,
  processMeetingTool,
  listUnfiledNotesTool,
  fileNoteTool,
  listProposalsTool,
  resolveProposalTool,
  renderRecapTool,
]
