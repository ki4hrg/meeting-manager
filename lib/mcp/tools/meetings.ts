/*
 * The meeting tools: prep, the agenda, the brief, and series.
 *
 * A meeting is named by its id, and everything asked of it happens in its own
 * context. Contexts, people, groups, projects and series can be named instead
 * of looked up, resolved the way the item tools resolve them. Moments go out as
 * ISO and as they read on the account's clock, never as a UTC rendering.
 */

import { z } from 'zod'
import { ValidationError, type Executor, type Tx } from '@/lib/core/types'
import {
  getCandidates,
  placeItem,
  restoreCandidate,
  type CandidateGroup,
  type Candidates,
} from '../../agenda/candidates'
import { renderBrief } from '../../agenda/brief'
import { computeBlocks } from '../../agenda/generated'
import {
  addLine,
  addSection,
  getAgenda,
  importOutline,
  moveLine,
  removeLine,
  updateLine,
  type Agenda,
  type AgendaLine,
} from '../../agenda/lines'
import { parseOutline } from '../../agenda/outline'
import type { GeneratedBlocks } from '../../agenda/types'
import { formatTime, formatWeekday, fromLocalInput, todayIn } from '../../core/dates'
import type { BlockSettings, SkeletonSection } from '../../db/schema'
import {
  inferContext,
  resolveGroup,
  resolvePerson,
  resolveProject,
  resolveSeries,
} from '../../directory/resolve'
import { getItem, type ItemView } from '../../items/items'
import {
  getMeeting,
  listMeetings,
  makeSessionOf,
  separateSession,
  setMeetingPeople,
  setMeetingProjects,
  sittingBefore,
  updateMeeting,
  type MeetingView,
} from '../../meetings/meetings'
import { takeRoll } from '../../meetings/attendance'
import { clearAbsences, joinRoster, recordAbsences } from '../../meetings/roster'
import { linkAttendees } from '../../processing/proposals'
import { moveMeeting, moveSeries } from '../../meetings/move'
import {
  ownMeetingFromNote,
  prepMeeting,
  prepNextInSeries,
  prepWithPerson,
  sessionFromNote,
} from '../../meetings/prep'
import { listNotes } from '../../notes/notes'
import {
  addToRoster,
  createSeries,
  getSeries,
  listSeries,
  setSeriesPeople,
  setSeriesProjects,
  updateSeries,
  type SeriesView,
} from '../../meetings/series'
import { clockFor, idempotencyKey, write, type Clock } from './shared'
import { defineTool, type ToolContext } from './types'

// ─── shared arguments ────────────────────────────────────────────────────────

const contextArg = z
  .string()
  .min(1)
  .optional()
  .describe('Context name or id. Needed when there are several.')

const meetingId = z.uuid().describe('Meeting id.')

const momentArg =
  'ISO 8601. With an offset or Z it is that instant; without one it is read on the account clock.'

const minutes = z.number().int().min(0).max(1440)

const pinnedStart = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM on the 24-hour clock.')

const blocksArg = z.strictObject({
  follow_ups: z.boolean().optional(),
  since_last: z.boolean().optional(),
  lookahead: z.boolean().optional(),
})

const BLOCKS_RULE =
  'blocks switches the generated blocks: follow_ups (what is owed, from placed items), ' +
  'since_last (against the previous occurrence), lookahead (milestones, deadlines and the ' +
  'next linked meetings).'

const agendaLineArg = z
  .strictObject({
    text: z.string().min(1).optional().describe('Free text, or the wording to show for an item.'),
    item_id: z.uuid().optional().describe('The item this line raises.'),
    minutes: minutes.optional(),
    description: z.string().optional().describe('Public: goes out with the agenda.'),
    leader: z.string().min(1).optional().describe('Who leads it: a person by name or id, or "me".'),
    private_note: z.string().optional(),
    pinned_start: pinnedStart.optional(),
  })
  .refine((line) => line.text !== undefined || line.item_id !== undefined, {
    message: 'A line needs text or an item_id.',
  })

const agendaSectionArg = z.strictObject({
  title: z.string().min(1),
  minutes: minutes
    .optional()
    .describe("A timebox: the section's length. Its lines with minutes use it up; the rest share what is left."),
  pinned_start: pinnedStart.optional(),
  lines: z.array(agendaLineArg).optional(),
})

const skeletonArg = z.array(
  z.strictObject({
    title: z.string().min(1),
    lines: z
      .array(z.strictObject({ text: z.string().min(1), minutes: minutes.optional() }))
      .optional(),
  }),
)

type BlocksInput = z.infer<typeof blocksArg>
type AgendaLineInput = z.infer<typeof agendaLineArg>

const MOVE_RULE =
  'A move leaves behind what belongs to the old context: projects, group, item lines and ' +
  'items aimed at it. A meeting that has produced items does not move.'

// ─── moments ─────────────────────────────────────────────────────────────────

const HAS_OFFSET = /T.*(?:Z|[+-]\d{2}:?\d{2})$/i

/* An instant when it carries an offset; otherwise a wall time in the account's zone. */
function momentFrom(value: string, clock: Clock): Date {
  const trimmed = value.trim()
  if (!HAS_OFFSET.test(trimmed)) return fromLocalInput(trimmed, clock.timeZone)
  const moment = new Date(trimmed)
  if (Number.isNaN(moment.getTime())) {
    throw new ValidationError(`${value} is not a date and time.`)
  }
  return moment
}

function momentArgFrom(value: string | null | undefined, clock: Clock): Date | null | undefined {
  return value === undefined || value === null ? value : momentFrom(value, clock)
}

/** "Tue, Oct 20, 3:05 PM" on the account's clock. */
function localOf(moment: Date | null, clock: Clock): string | null {
  if (!moment) return null
  const day = formatWeekday(todayIn(clock.timeZone, moment), clock.today)
  return `${day}, ${formatTime(moment, clock.timeZone)}`
}

// ─── wire shapes ─────────────────────────────────────────────────────────────

function blocksOut(blocks: BlockSettings) {
  return {
    follow_ups: blocks.followUps,
    since_last: blocks.sinceLast,
    lookahead: blocks.lookahead,
  }
}

/* Only what was said: an omitted block keeps whatever it is merged over. */
function blocksFrom(input: BlocksInput | undefined): Partial<BlockSettings> {
  const given: Partial<BlockSettings> = {}
  if (input?.follow_ups !== undefined) given.followUps = input.follow_ups
  if (input?.since_last !== undefined) given.sinceLast = input.since_last
  if (input?.lookahead !== undefined) given.lookahead = input.lookahead
  return given
}

const NO_BLOCKS: BlockSettings = { followUps: false, sinceLast: false, lookahead: false }

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
    /* Its people and, until its list is copied, its groups' members; here is
       whether I said they were there (false: not yet said). out: marked not there. */
    attendees: meeting.attendees.map(({ id, name, here }) => ({ id, name, here })),
    out: meeting.absent.map(({ id, name }) => ({ id, name })),
    projects: meeting.projects,
    parent_meeting_id: meeting.parentMeetingId,
  }
}

function lineOut(line: AgendaLine) {
  return {
    id: line.id,
    text: line.text,
    item_id: line.item?.id ?? null,
    item_kind: line.item?.kind ?? null,
    item_status: line.item?.status ?? null,
    minutes: line.minutes,
    pinned_start: line.pinnedStart,
    start: line.start,
    description: line.description,
    leader: line.leader ? { id: line.leader.id, name: line.leader.name } : null,
    private_note: line.privateNote,
    ...(line.overrunMinutes ? { overrun_minutes: line.overrunMinutes } : {}),
    ...(line.shareMinutes !== undefined ? { share_minutes: line.shareMinutes } : {}),
  }
}

function agendaOut(agenda: Agenda) {
  return {
    rows: agenda.nodes.map((node) =>
      node.type === 'line'
        ? { type: 'line' as const, ...lineOut(node) }
        : {
            type: 'section' as const,
            id: node.id,
            title: node.title,
            minutes: node.minutes,
            pinned_start: node.pinnedStart,
            start: node.start,
            ...(node.overrunMinutes ? { overrun_minutes: node.overrunMinutes } : {}),
            ...(node.usedMinutes !== undefined ? { used_minutes: node.usedMinutes } : {}),
            ...(node.overBudgetMinutes ? { over_budget_minutes: node.overBudgetMinutes } : {}),
            lines: node.lines.map(lineOut),
          },
    ),
    total_minutes: agenda.totalMinutes,
    end: agenda.end,
    overflow_minutes: agenda.overflowMinutes,
  }
}

function candidateOut(item: ItemView) {
  return { id: item.id, kind: item.kind, text: item.text, due_on: item.dueOn }
}

/* Under a person or a group, each item says where it stands between them and me. */
function groupsOut(groups: CandidateGroup[]) {
  return groups.map((group) => ({
    by: group.by,
    items: (group.bands ?? [{ stance: undefined, items: group.items }]).flatMap((band) =>
      band.items.map((item) => ({ ...candidateOut(item), ...(band.stance ? { stance: band.stance } : {}) })),
    ),
  }))
}

function candidatesOut(candidates: Candidates) {
  return {
    to_place: candidates.toPlace.map(candidateOut),
    suggested: groupsOut(candidates.suggested),
    more: groupsOut(candidates.more),
    dismissed: candidates.dismissed.map(candidateOut),
  }
}

function generatedOut(blocks: GeneratedBlocks, clock: Clock) {
  return {
    follow_ups:
      blocks.followUps?.map(({ party, items }) => ({
        party,
        items: items.map((item) => ({
          item_id: item.itemId,
          kind: item.kind,
          text: item.text,
          due_on: item.dueOn,
          overdue: item.overdue,
        })),
      })) ?? null,
    since_last: blocks.sinceLast
      ? {
          meeting: {
            id: blocks.sinceLast.meeting.id,
            title: blocks.sinceLast.meeting.title,
            starts_at: blocks.sinceLast.meeting.startsAt?.toISOString() ?? null,
            starts_at_local: localOf(blocks.sinceLast.meeting.startsAt, clock),
          },
          decisions: blocks.sinceLast.decisions.map((d) => ({ item_id: d.itemId, text: d.text })),
          closed: blocks.sinceLast.closed.map((c) => ({
            item_id: c.itemId,
            kind: c.kind,
            text: c.text,
            resolution: c.resolution,
          })),
          still_open: blocks.sinceLast.stillOpen.map((o) => ({
            item_id: o.itemId,
            kind: o.kind,
            text: o.text,
          })),
        }
      : null,
    lookahead: blocks.lookahead
      ? {
          milestones: blocks.lookahead.milestones.map((m) => ({
            id: m.id,
            project: m.projectName,
            title: m.title,
            due_on: m.dueOn,
          })),
          deadlines: blocks.lookahead.deadlines.map((d) => ({
            item_id: d.itemId,
            kind: d.kind,
            text: d.text,
            due_on: d.dueOn,
            project: d.projectName,
          })),
          meetings: blocks.lookahead.meetings.map((m) => ({
            id: m.id,
            title: m.title,
            starts_at: m.startsAt.toISOString(),
            starts_at_local: localOf(m.startsAt, clock),
          })),
        }
      : null,
  }
}

function seriesOut(series: SeriesView) {
  return {
    id: series.id,
    context_id: series.contextId,
    name: series.name,
    groups: series.groups,
    people: series.people,
    projects: series.projects,
    skeleton: series.skeleton.map((section) => ({
      title: section.title,
      lines: section.lines.map((line) => ({ text: line.text, minutes: line.minutes ?? null })),
    })),
    blocks: blocksOut(series.blocks),
  }
}

/** What get_meeting returns, and every tool that changes a meeting or its agenda. */
async function meetingView(exec: Executor, id: string, clock: Clock) {
  const meeting = await getMeeting(exec, id)
  const agenda = await getAgenda(exec, id, { timeZone: clock.timeZone })
  const candidates = await getCandidates(exec, id, clock.now)
  const notes = await listNotes(exec, id)
  const before = await sittingBefore(exec, meeting)
  return {
    meeting: {
      ...meetingOut(meeting, clock),
      sessions: meeting.sessions.map((session) => ({
        id: session.id,
        title: session.title,
        starts_at: session.startsAt?.toISOString() ?? null,
        starts_at_local: localOf(session.startsAt, clock),
        ends_at: session.endsAt?.toISOString() ?? null,
        ends_at_local: localOf(session.endsAt, clock),
      })),
      blocks: blocksOut(meeting.blocks),
      notes: notes.map((note) => {
        const at = (value: string | null | undefined) => (value ? new Date(value) : null)
        const from = at(note.filing?.startsAt)
        const to = at(note.filing?.recordedTo)
        return {
          id: note.id,
          title: note.title,
          source: note.source,
          started_at: from?.toISOString() ?? null,
          started_at_local: localOf(from, clock),
          recorded_to: to?.toISOString() ?? null,
          recorded_to_local: localOf(to, clock),
        }
      }),
      may_be_session_of: before,
    },
    agenda: agendaOut(agenda),
    candidates: candidatesOut(candidates),
  }
}

// ─── names ───────────────────────────────────────────────────────────────────

async function peopleFrom(exec: Executor, refs: string[]): Promise<string[]> {
  const ids: string[] = []
  for (const ref of refs) ids.push((await resolvePerson(exec, ref)).id)
  return [...new Set(ids)]
}

async function groupsFrom(exec: Executor, contextId: string, refs: string[]): Promise<string[]> {
  const ids: string[] = []
  for (const ref of refs) ids.push((await resolveGroup(exec, contextId, ref)).id)
  return [...new Set(ids)]
}

/* `groups` replaces the list; `group` is one, or none with null. Undefined: unchanged. */
async function groupIdsFrom(
  exec: Executor,
  contextId: string,
  input: { group?: string | null; groups?: string[] },
): Promise<string[] | undefined> {
  if (input.groups !== undefined) {
    return groupsFrom(exec, contextId, [...input.groups, ...(input.group ? [input.group] : [])])
  }
  if (input.group === undefined) return undefined
  return input.group === null ? [] : groupsFrom(exec, contextId, [input.group])
}

const groupsArg = z
  .array(z.string().min(1))
  .optional()
  .describe('Groups, by name or id. Each stands for its members until the meeting is over.')

async function projectsFrom(exec: Executor, contextId: string, refs: string[]): Promise<string[]> {
  const ids: string[] = []
  for (const ref of refs) ids.push((await resolveProject(exec, contextId, ref)).id)
  return [...new Set(ids)]
}

function skeletonFrom(input: {
  skeleton?: z.infer<typeof skeletonArg>
  skeleton_outline?: string
}): SkeletonSection[] | undefined {
  if (input.skeleton !== undefined && input.skeleton_outline !== undefined) {
    throw new ValidationError('Give the skeleton as sections or as outline text, not both.')
  }
  if (input.skeleton !== undefined) {
    return input.skeleton.map((section) => ({
      title: section.title.trim(),
      lines: (section.lines ?? []).map((line) => ({
        text: line.text.trim(),
        ...(line.minutes !== undefined ? { minutes: line.minutes } : {}),
      })),
    }))
  }
  if (input.skeleton_outline === undefined) return undefined

  /* A skeleton is sections with lines: top-level entries are the sections and
     whatever sits under one, at any depth, is a line of it. */
  const sections: SkeletonSection[] = []
  for (const entry of parseOutline(input.skeleton_outline)) {
    const section = sections[sections.length - 1]
    if (entry.depth === 0 || !section) {
      sections.push({ title: entry.title, lines: [] })
    } else {
      section.lines.push({
        text: entry.title,
        ...(entry.minutes !== null ? { minutes: entry.minutes } : {}),
      })
    }
  }
  if (sections.length === 0) {
    throw new ValidationError('That outline has no headings or bullets to make sections from.')
  }
  return sections
}

// ─── meetings ────────────────────────────────────────────────────────────────

export const listMeetingsTool = defineTool({
  name: 'list_meetings',
  title: 'List meetings',
  description:
    'Meetings in one context: upcoming (soonest first) by default, past (latest first), or ' +
    'stubs, which are prepped meetings with no date yet. Filter by a person at it, a project, ' +
    'its group or its series. Only meetings that have been prepped exist; the calendar is not ' +
    'listed here.',
  scope: 'meetings:read',
  input: z.object({
    context: contextArg,
    when: z.enum(['upcoming', 'past', 'stubs']).optional().describe('Defaults to upcoming.'),
    person: z.string().min(1).optional().describe('Person name or id.'),
    project: z.string().min(1).optional().describe('Project name or id.'),
    group: z.string().min(1).optional().describe('Group name or id.'),
    series: z.string().min(1).optional().describe('Series name or id.'),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  annotations: { readOnlyHint: true },
  handler: async (input, context) => {
    const { exec } = context
    const clock = await clockFor(exec, context)
    const target = await inferContext(exec, {
      context: input.context,
      project: input.project,
      series: input.series,
      parties: input.group ? [input.group] : [],
    })
    const person = input.person ? await resolvePerson(exec, input.person) : null
    const project = input.project ? await resolveProject(exec, target.id, input.project) : null
    const group = input.group ? await resolveGroup(exec, target.id, input.group) : null
    const series = input.series ? await resolveSeries(exec, target.id, input.series) : null

    const found = await listMeetings(exec, {
      contextId: target.id,
      when: input.when ?? 'upcoming',
      personId: person?.id,
      projectId: project?.id,
      groupId: group?.id,
      seriesId: series?.id,
      now: clock.now,
      limit: input.limit ?? 50,
    })
    return {
      context: { id: target.id, name: target.name },
      meetings: found.map((meeting) => meetingOut(meeting, clock)),
    }
  },
})

export const getMeetingTool = defineTool({
  name: 'get_meeting',
  title: 'Get a meeting',
  description:
    'One meeting with its agenda and its candidates. The agenda is rows in order, each a ' +
    'section with lines or a loose line; a line is free text or a live item (item_id), with ' +
    'minutes, its computed start on the account clock and my private note. candidates are open ' +
    'items not on the agenda: to_place (aimed here, placed by prep), suggested (through a ' +
    'project, the group or the other person in a 1:1; never placed on their own), more (matched by an attendee alone in a larger meeting; ' +
    'never raise these unasked) and dismissed (aimed here but taken off the agenda). Under a ' +
    'person or group, each candidate has a stance, in this order: theirs (they owe it to me), ' +
    'mine (mine to bring them), elsewhere (they owe it to someone else and report back), ' +
    'together (we are both on it, or it is to talk over).',
  scope: 'meetings:read',
  input: z.object({ id: meetingId }),
  annotations: { readOnlyHint: true },
  handler: async (input, context) =>
    meetingView(context.exec, input.id, await clockFor(context.exec, context)),
})

export const prepMeetingTool = defineTool({
  name: 'prep_meeting',
  title: 'Prep a meeting',
  description:
    'Start a meeting and its agenda, one of three ways. person: the undated 1:1 stub holding ' +
    'everything saved up to raise with them; asking again returns the same stub, topped up. ' +
    'series: its next occurrence, created with the standing agenda if nobody has prepped one. ' +
    'Otherwise a new meeting from title, starts_at, ends_at, people, projects, group and ' +
    'series (no starts_at makes a stub); this one creates a meeting on every call, so pass ' +
    'idempotency_key. With session_of, that new meeting is a session of a multi-day meeting, ' +
    'starting with its people, group and projects; the meeting keeps its own times, its ' +
    'agenda is its sessions, and what is aimed at it goes on its next session. Items aimed at the meeting ' +
    'or its series are placed. Returns what get_meeting returns.',
  scope: 'meetings:write',
  input: z.object({
    context: contextArg,
    person: z.string().min(1).optional().describe('Person name or id. On its own.'),
    series: z.string().min(1).optional().describe('Series name or id.'),
    title: z.string().min(1).optional(),
    starts_at: z.string().min(1).optional().describe(momentArg),
    ends_at: z.string().min(1).optional().describe(momentArg),
    people: z.array(z.string().min(1)).optional().describe('People, by name or id.'),
    here: z.array(z.string().min(1)).optional().describe('People who were there, by name or id.'),
    out: z.array(z.string().min(1)).optional().describe('People who were not there, by name or id.'),
    projects: z.array(z.string().min(1)).optional().describe('Projects, by name or id.'),
    group: z.string().min(1).optional().describe('Group name or id: one of groups.'),
    groups: groupsArg,
    session_of: z.uuid().optional().describe('The meeting this is a session of.'),
    idempotency_key: idempotencyKey,
  }),
  handler: async (input, context) =>
    write(context, 'prep_meeting', input, async (tx) => {
      const { actor } = context
      const clock = await clockFor(tx, context)
      if (input.session_of) {
        if (input.person || input.series || input.context || input.group || input.groups || input.people || input.projects) {
          throw new ValidationError('A session takes a title and times; the rest comes from its meeting.')
        }
        if (!input.title) throw new ValidationError('A session needs a title.')
        const parent = await getMeeting(tx, input.session_of)
        const session = await prepMeeting(
          tx,
          actor,
          {
            contextId: parent.contextId,
            parentMeetingId: parent.id,
            title: input.title,
            startsAt: input.starts_at ? momentFrom(input.starts_at, clock) : null,
            endsAt: input.ends_at ? momentFrom(input.ends_at, clock) : null,
            groupIds: parent.groups.map((group) => group.id),
            personIds: parent.people.map((person) => person.id),
            projectIds: parent.projects.map((project) => project.id),
          },
          clock.now,
        )
        return meetingView(tx, session.id, clock)
      }
      const explicit =
        input.title !== undefined ||
        input.starts_at !== undefined ||
        input.ends_at !== undefined ||
        input.people !== undefined ||
        input.projects !== undefined ||
        input.group !== undefined ||
        input.groups !== undefined

      if (input.person && (explicit || input.series)) {
        throw new ValidationError(
          'person preps the 1:1 stub and takes nothing else. For a new meeting, name them in people.',
        )
      }
      if (!input.person && !input.series && !explicit) {
        throw new ValidationError('Say what to prep: a person, a series, or a title, time or people.')
      }

      const target = await inferContext(tx, {
        context: input.context,
        project: input.projects?.[0],
        series: input.series,
        parties: [...(input.group ? [input.group] : []), ...(input.groups ?? [])],
      })

      if (input.person) {
        const person = await resolvePerson(tx, input.person)
        const stub = await prepWithPerson(
          tx,
          actor,
          { contextId: target.id, personId: person.id },
          clock.now,
        )
        return meetingView(tx, stub.id, clock)
      }

      const series = input.series ? await resolveSeries(tx, target.id, input.series) : null
      if (series && !explicit) {
        const next = await prepNextInSeries(tx, actor, series.id, clock.now)
        return meetingView(tx, next.id, clock)
      }

      const groupIds = await groupIdsFrom(tx, target.id, input)
      const meeting = await prepMeeting(
        tx,
        actor,
        {
          contextId: target.id,
          title: input.title,
          startsAt: input.starts_at ? momentFrom(input.starts_at, clock) : null,
          endsAt: input.ends_at ? momentFrom(input.ends_at, clock) : null,
          seriesId: series?.id,
          ...(groupIds ? { groupIds } : {}),
          // Left out, the roster, groups and projects come from the series.
          ...(input.people ? { personIds: await peopleFrom(tx, input.people) } : {}),
          ...(input.projects
            ? { projectIds: await projectsFrom(tx, target.id, input.projects) }
            : {}),
        },
        clock.now,
      )
      return meetingView(tx, meeting.id, clock)
    }),
})

export const updateMeetingTool = defineTool({
  name: 'update_meeting',
  title: 'Update a meeting',
  description:
    'Change a meeting: its title, times, people, projects, groups, series or generated blocks, ' +
    'or who was there. people, projects and groups each replace the whole list; here and out ' +
    'mark only the people named, joining the list if they were not on it. starts_at null takes the date off and ' +
    `makes it a stub again. ${BLOCKS_RULE} blocks null goes back to the series' settings. ` +
    'Pass null to clear ends_at, group or series. context moves it to another context, out ' +
    `of its series, before anything else is applied. ${MOVE_RULE} session_of makes it a ` +
    "session of that meeting (its next sitting: a debrief), after everything else, taking the " +
    "meeting's people, groups and projects beside its own; get_meeting's may_be_session_of " +
    'names the one it began during or just after. Never do this unasked. session_of null ' +
    'makes a session its own meeting again, taking off what joining added. Returns what get_meeting returns.',
  scope: 'meetings:write',
  input: z.object({
    id: meetingId,
    context: z.string().min(1).optional().describe('Context name or id to move it to.'),
    title: z.string().min(1).optional(),
    starts_at: z.string().min(1).nullable().optional().describe(momentArg),
    ends_at: z.string().min(1).nullable().optional().describe(momentArg),
    people: z.array(z.string().min(1)).optional().describe('People, by name or id.'),
    here: z.array(z.string().min(1)).optional().describe('People who were there, by name or id.'),
    out: z.array(z.string().min(1)).optional().describe('People who were not there, by name or id.'),
    projects: z.array(z.string().min(1)).optional().describe('Projects, by name or id.'),
    group: z.string().min(1).nullable().optional().describe('Group name or id: the only group, or none with null.'),
    groups: groupsArg,
    series: z.string().min(1).nullable().optional().describe('Series name or id.'),
    blocks: blocksArg.nullable().optional(),
    session_of: z
      .uuid()
      .nullable()
      .optional()
      .describe('Meeting id: this one becomes a session of it. null: a session becomes its own meeting.'),
    add_to_series: z
      .boolean()
      .optional()
      .describe("With people or groups: whoever they add joins the series' roster too."),
    idempotency_key: idempotencyKey,
  }),
  handler: async (input, context) =>
    write(context, 'update_meeting', input, async (tx) => {
      const { actor } = context
      const clock = await clockFor(tx, context)
      /* A move comes first, so the names that follow are read in the context
         the meeting ends up in. */
      const destination = input.context
        ? await inferContext(tx, { context: input.context })
        : null
      const before = destination
        ? await moveMeeting(tx, actor, input.id, destination.id)
        : await getMeeting(tx, input.id)
      const contextId = before.contextId

      const startsAt = momentArgFrom(input.starts_at, clock)
      let endsAt = momentArgFrom(input.ends_at, clock)
      // A stub has no end either.
      if (startsAt === null && endsAt === undefined) endsAt = null
      const start = startsAt === undefined ? before.startsAt : startsAt
      const end = endsAt === undefined ? before.endsAt : endsAt
      if (end && !start) throw new ValidationError('An end time requires a start time.')
      if (start && end && end < start) {
        throw new ValidationError('End time must not be before start time. Give both to move it.')
      }

      const groupIds = await groupIdsFrom(tx, contextId, input)
      const series =
        input.series === undefined || input.series === null
          ? input.series
          : (await resolveSeries(tx, contextId, input.series)).id
      const blocks =
        input.blocks === undefined || input.blocks === null
          ? input.blocks
          : { ...before.blocks, ...blocksFrom(input.blocks) }

      await updateMeeting(tx, actor, input.id, {
        title: input.title,
        startsAt,
        endsAt,
        groupIds,
        seriesId: series,
        blocks,
      })
      const people = input.people ? await peopleFrom(tx, input.people) : null
      if (people) {
        await setMeetingPeople(tx, actor, input.id, people)
        await linkAttendees(tx, input.id)
      }
      const inSeries = (await getMeeting(tx, input.id)).series
      if (input.add_to_series) {
        if (!inSeries) throw new ValidationError('add_to_series needs a meeting in a series.')
        await addToRoster(tx, inSeries.id, people ?? [], groupIds ?? [])
      }
      if (input.projects) {
        await setMeetingProjects(
          tx,
          actor,
          input.id,
          await projectsFrom(tx, contextId, input.projects),
        )
      }
      /* As in the edit form: people named within a series leave the rest of
         the roster off this meeting alone; a meeting newly in a series takes
         its roster. */
      const seriesNow = series === undefined ? (before.series?.id ?? null) : series
      if (seriesNow && seriesNow === (before.series?.id ?? null)) {
        if (input.people) await recordAbsences(tx, input.id)
      } else {
        await clearAbsences(tx, [input.id])
        if (seriesNow) await joinRoster(tx, actor, input.id)
      }
      if (input.here || input.out) {
        const here = input.here ? await peopleFrom(tx, input.here) : []
        const out = input.out ? await peopleFrom(tx, input.out) : []
        const now = await getMeeting(tx, input.id)
        // Only those named change; everyone else keeps their mark.
        await takeRoll(tx, input.id, {
          here: [...now.attendees.filter((one) => one.here).map((one) => one.id), ...here].filter(
            (id) => !out.includes(id),
          ),
          out: [...now.absent.map((one) => one.id), ...out].filter((id) => !here.includes(id)),
        })
      }
      if (input.session_of) await makeSessionOf(tx, actor, input.id, input.session_of)
      if (input.session_of === null) await separateSession(tx, actor, input.id)
      const view = await meetingView(tx, input.id, clock)
      return destination
        ? { ...view, context: { id: destination.id, name: destination.name } }
        : view
    }),
})

export const splitNoteTool = defineTool({
  name: 'split_note',
  title: 'Split a note off its meeting',
  description:
    "A note filed on a meeting (get_meeting's notes) that was a conversation of its own: " +
    "into session makes it a session of that meeting (it reconvened); into meeting gives it " +
    "a meeting of its own (a 1:1 straight after), with its title, times, the people it names " +
    "and the meeting's projects. It moves with its pending and rejected proposals; accepted " +
    'ones stay where their items were made. Never do this unasked. Returns what get_meeting ' +
    'returns, for the meeting it is now on.',
  scope: 'meetings:write',
  input: z.object({
    id: z.uuid().describe('Note id.'),
    into: z.enum(['session', 'meeting']),
    idempotency_key: idempotencyKey,
  }),
  handler: async (input, context) =>
    write(context, 'split_note', input, async (tx) => {
      const made =
        input.into === 'session'
          ? await sessionFromNote(tx, context.actor, input.id)
          : await ownMeetingFromNote(tx, context.actor, input.id)
      return meetingView(tx, made.id, await clockFor(tx, context))
    }),
})

// ─── the agenda ──────────────────────────────────────────────────────────────

/* Past the end of any list: moveLine clamps it to "last". */
const LAST = Number.MAX_SAFE_INTEGER

type Placed = { id: string; isSection: boolean; itemId: string | null; sectionId: string | null }

/* Every row of one meeting's agenda, in reading order. */
async function rowsOf(exec: Executor, id: string): Promise<Placed[]> {
  const agenda = await getAgenda(exec, id)
  const rows: Placed[] = []
  for (const node of agenda.nodes) {
    if (node.type === 'line') {
      rows.push({ id: node.id, isSection: false, itemId: node.item?.id ?? null, sectionId: null })
      continue
    }
    rows.push({ id: node.id, isSection: true, itemId: null, sectionId: null })
    for (const line of node.lines) {
      rows.push({ id: line.id, isSection: false, itemId: line.item?.id ?? null, sectionId: node.id })
    }
  }
  return rows
}

/* A line id is only good on the agenda it was read from: this is what keeps an
   edit to one meeting from reaching a row of another. */
async function rowOn(exec: Executor, id: string, lineId: string): Promise<Placed> {
  const row = (await rowsOf(exec, id)).find((candidate) => candidate.id === lineId)
  if (!row) throw new ValidationError(`No line or section on this agenda has the id ${lineId}.`)
  return row
}

/*
 * Clear what was typed and keep what is live: every item line comes out to the
 * top, in reading order, and then the sections and free-text lines go. Item
 * lines are moved rather than removed, so nothing is dismissed.
 */
async function clearFreeText(tx: Tx, context: ToolContext, id: string) {
  const before = await rowsOf(tx, id)
  const kept = before.filter((row) => row.itemId)
  for (const [position, row] of kept.entries()) {
    await moveLine(tx, context.actor, row.id, { sectionId: null, position })
  }
  for (const row of before) {
    // A section takes its remaining lines with it.
    if (!row.itemId && row.sectionId === null) await removeLine(tx, context.actor, row.id)
  }
}

async function buildAgenda(
  tx: Tx,
  context: ToolContext,
  id: string,
  input: { sections?: z.infer<typeof agendaSectionArg>[]; lines?: AgendaLineInput[] },
) {
  const { actor } = context
  const given = [...(input.lines ?? []), ...(input.sections ?? []).flatMap((s) => s.lines ?? [])]
  const itemIds = given.flatMap((line) => (line.item_id ? [line.item_id] : []))
  if (new Set(itemIds).size !== itemIds.length) {
    throw new ValidationError('An item can be on an agenda only once; one is listed twice.')
  }

  const placed = new Map(
    (await rowsOf(tx, id)).flatMap((row) => (row.itemId ? [[row.itemId, row.id] as const] : [])),
  )

  const put = async (line: AgendaLineInput, sectionId: string | null) => {
    const existing = line.item_id ? placed.get(line.item_id) : undefined
    const leaderPersonId = line.leader ? (await resolvePerson(tx, line.leader)).id : undefined
    if (existing) {
      // Already on the agenda: its line moves, keeping whatever is not restated.
      await moveLine(tx, actor, existing, { sectionId, position: LAST })
      await updateLine(tx, actor, existing, {
        text: line.text,
        description: line.description,
        leaderPersonId,
        privateNote: line.private_note,
        minutes: line.minutes,
        pinnedStart: line.pinned_start,
      })
      return
    }
    const lineId = await addLine(tx, actor, id, {
      text: line.text,
      itemId: line.item_id,
      sectionId,
      description: line.description,
      leaderPersonId,
      privateNote: line.private_note,
      minutes: line.minutes,
    })
    if (line.pinned_start) await updateLine(tx, actor, lineId, { pinnedStart: line.pinned_start })
  }

  for (const line of input.lines ?? []) await put(line, null)
  for (const section of input.sections ?? []) {
    const sectionId = await addSection(tx, actor, id, { title: section.title })
    if (section.minutes !== undefined || section.pinned_start !== undefined) {
      await updateLine(tx, actor, sectionId, {
        minutes: section.minutes,
        pinnedStart: section.pinned_start,
      })
    }
    for (const line of section.lines ?? []) await put(line, sectionId)
  }
}

export const setAgendaTool = defineTool({
  name: 'set_agenda',
  title: 'Write an agenda',
  description:
    'Write a whole agenda in one call. Either outline: text as it was written, where headings ' +
    '(or top-level bullets) become sections, what is under them lines, a trailing number ' +
    'minutes ("Budget 15") and text under a line its private note. Or lines (loose, first) and ' +
    'sections: [{ title, lines: [{ text, item_id, minutes, description, leader, private_note, ' +
    'pinned_start }] }], ' +
    'where a line is free text, an item, or an item shown in other wording. replace (the ' +
    'default) clears the free-text lines and sections first; items already placed are never ' +
    'dropped: one named in the input moves to where it is named, the rest stay loose above. ' +
    'replace false adds to what is there. Returns what get_meeting returns.',
  scope: 'meetings:write',
  input: z.object({
    id: meetingId,
    outline: z.string().min(1).optional().describe('The agenda as text: Markdown headings or bullets.'),
    lines: z.array(agendaLineArg).optional().describe('Loose lines, above the sections.'),
    sections: z.array(agendaSectionArg).optional(),
    replace: z.boolean().optional().describe('Defaults to true.'),
    idempotency_key: idempotencyKey,
  }),
  handler: async (input, context) =>
    write(context, 'set_agenda', input, async (tx) => {
      const clock = await clockFor(tx, context)
      const replace = input.replace ?? true
      const structured = input.sections !== undefined || input.lines !== undefined

      if (input.outline !== undefined && structured) {
        throw new ValidationError('Give the agenda as outline text or as sections and lines, not both.')
      }
      if (input.outline === undefined && !structured) {
        throw new ValidationError('Give the agenda as outline text, or as sections and lines.')
      }
      await getMeeting(tx, input.id)

      if (input.outline !== undefined) {
        await importOutline(tx, context.actor, input.id, input.outline, { replace })
      } else {
        if (replace) await clearFreeText(tx, context, input.id)
        await buildAgenda(tx, context, input.id, input)
      }
      return meetingView(tx, input.id, clock)
    }),
})

const EDIT_OPS = [
  'add_line',
  'update_line',
  'move_line',
  'remove_line',
  'place_item',
  'restore_item',
] as const

type EditOp = (typeof EDIT_OPS)[number]

const LINE_FIELDS = ['text', 'minutes', 'description', 'leader', 'private_note', 'pinned_start'] as const
const EDIT_FIELDS = [
  'line_id',
  'item_id',
  'as_section',
  'section_id',
  'position',
  ...LINE_FIELDS,
] as const

type EditField = (typeof EDIT_FIELDS)[number]

/* What each op reads. Anything else given with it is refused rather than
   ignored: a field that silently did nothing reads as a change that was made. */
const EDIT_TAKES: Record<EditOp, { needs: EditField[]; allows: readonly EditField[] }> = {
  add_line: { needs: [], allows: ['item_id', 'as_section', 'section_id', 'position', ...LINE_FIELDS] },
  update_line: { needs: ['line_id'], allows: LINE_FIELDS },
  move_line: { needs: ['line_id'], allows: ['section_id', 'position'] },
  remove_line: { needs: ['line_id'], allows: [] },
  place_item: {
    needs: ['item_id'],
    allows: ['section_id', 'position', 'minutes', 'description', 'leader', 'private_note', 'pinned_start'],
  },
  restore_item: { needs: ['item_id'], allows: [] },
}

export const editAgendaTool = defineTool({
  name: 'edit_agenda',
  title: 'Edit an agenda',
  description:
    'One small change to an agenda, chosen by op. add_line: text, or item_id, or both (the ' +
    'item in other wording); as_section makes it a section titled text. update_line: change ' +
    'text, minutes, description (public), leader (a person, or "me"), private_note or ' +
    'pinned_start of line_id (a section takes text, minutes and pinned_start); null clears. ' +
    'move_line: line_id to position (0 is first; omitted is last) in section_id (null is the ' +
    'top level; omitted keeps where it is). remove_line: line_id; a section goes with its ' +
    'lines; an item taken off that was aimed at this meeting alone loses its aim, one aimed ' +
    'at its series or project waits for the next meeting, and anything else goes back to the ' +
    'suggestions. place_item: put item_id on the agenda, as from a suggestion. ' +
    'restore_item: let an item taken off come back. A suggestion not wanted is left alone, ' +
    'or dropped with update_item. Line and section ids come from get_meeting. ' +
    'Returns what get_meeting returns.',
  scope: 'meetings:write',
  input: z.object({
    id: meetingId,
    op: z.enum(EDIT_OPS),
    line_id: z.uuid().optional().describe('A line or section of this agenda.'),
    item_id: z.uuid().optional(),
    text: z.string().nullable().optional(),
    as_section: z.boolean().optional().describe('With add_line: add a section.'),
    section_id: z.uuid().nullable().optional().describe('The section to put it in; null is the top level.'),
    position: z.number().int().min(0).optional().describe('Place among its siblings, from 0.'),
    minutes: minutes.nullable().optional(),
    description: z.string().nullable().optional().describe('Public: goes out with the agenda.'),
    leader: z.string().min(1).nullable().optional().describe('A person by name or id, or "me".'),
    private_note: z.string().nullable().optional(),
    pinned_start: pinnedStart.nullable().optional().describe('HH:MM: starts then, whatever precedes it.'),
    idempotency_key: idempotencyKey,
  }),
  handler: async (input, context) =>
    write(context, 'edit_agenda', input, async (tx) => {
      const { actor } = context
      const { id, op } = input
      const clock = await clockFor(tx, context)
      const meeting = await getMeeting(tx, id)

      const takes = EDIT_TAKES[op]
      for (const field of takes.needs) {
        if (input[field] == null) throw new ValidationError(`${op} needs ${field}.`)
      }
      const stray = EDIT_FIELDS.filter(
        (field) =>
          input[field] !== undefined && !takes.needs.includes(field) && !takes.allows.includes(field),
      )
      if (stray.length > 0) {
        throw new ValidationError(`${op} does not take ${stray.join(', ')}.`)
      }

      const lineFields = {
        description: input.description,
        leaderPersonId:
          input.leader === undefined || input.leader === null
            ? input.leader
            : (await resolvePerson(tx, input.leader)).id,
        privateNote: input.private_note,
        minutes: input.minutes,
        pinnedStart: input.pinned_start,
      }
      const hasLineFields = Object.values(lineFields).some((value) => value !== undefined)

      /* The item ops take any item id; an item of another context is refused
         here, in the same words whichever op it was. */
      const itemHere = async (itemId: string) => {
        const item = await getItem(tx, itemId)
        if (item.contextId !== meeting.contextId) {
          throw new ValidationError('That item belongs to another context.')
        }
        return item
      }
      const lineOfItem = async (itemId: string) =>
        (await rowsOf(tx, id)).find((row) => row.itemId === itemId)

      if (op === 'add_line') {
        if (input.as_section) {
          if (
            input.item_id ||
            input.section_id ||
            input.private_note != null ||
            input.description != null ||
            input.leader != null
          ) {
            throw new ValidationError('A section has a title, minutes and a pinned start, nothing else.')
          }
          const sectionId = await addSection(tx, actor, id, {
            title: input.text ?? '',
            position: input.position,
          })
          if (input.minutes != null || input.pinned_start != null) {
            await updateLine(tx, actor, sectionId, {
              minutes: input.minutes,
              pinnedStart: input.pinned_start,
            })
          }
        } else {
          const lineId = await addLine(tx, actor, id, {
            text: input.text,
            itemId: input.item_id,
            sectionId: input.section_id,
            description: lineFields.description,
            leaderPersonId: lineFields.leaderPersonId,
            privateNote: input.private_note,
            minutes: input.minutes,
            position: input.position,
          })
          if (input.pinned_start != null) {
            await updateLine(tx, actor, lineId, { pinnedStart: input.pinned_start })
          }
        }
      } else if (op === 'update_line') {
        const row = await rowOn(tx, id, input.line_id!)
        if (input.text === undefined && !hasLineFields) {
          throw new ValidationError('update_line needs something to change.')
        }
        if (row.isSection && input.private_note != null) {
          throw new ValidationError('A section has no private note.')
        }
        if (row.isSection && (input.description != null || input.leader != null)) {
          throw new ValidationError('A section has a title, minutes and a pinned start, nothing else.')
        }
        await updateLine(tx, actor, row.id, { text: input.text, ...lineFields })
      } else if (op === 'move_line') {
        const row = await rowOn(tx, id, input.line_id!)
        await moveLine(tx, actor, row.id, {
          sectionId: input.section_id === undefined ? row.sectionId : input.section_id,
          position: input.position ?? LAST,
        })
      } else if (op === 'remove_line') {
        const row = await rowOn(tx, id, input.line_id!)
        await removeLine(tx, actor, row.id)
      } else if (op === 'place_item') {
        await placeItem(tx, actor, id, input.item_id!)
        const row = (await lineOfItem(input.item_id!))!
        if (input.section_id !== undefined || input.position !== undefined) {
          await moveLine(tx, actor, row.id, {
            sectionId: input.section_id === undefined ? row.sectionId : input.section_id,
            position: input.position ?? LAST,
          })
        }
        if (hasLineFields) await updateLine(tx, actor, row.id, lineFields)
      } else {
        await itemHere(input.item_id!)
        await restoreCandidate(tx, actor, id, input.item_id!)
      }

      return meetingView(tx, id, clock)
    }),
})

export const getBriefingTool = defineTool({
  name: 'get_briefing',
  title: 'Get the brief for a meeting',
  description:
    'The brief for one meeting, as its private export: markdown with the agenda, ' +
    'planned starts, my private notes and the generated blocks, so it is for me and not for ' +
    'the room. Also the same blocks as data, and the suggested items not yet on the agenda. ' +
    `${BLOCKS_RULE} Given here, blocks overrides the meeting's settings for this one render. ` +
    'Follow-ups only ever come from items placed on the agenda or captured in the meeting. ' +
    'For a person, group or project, use list_items with party or project instead.',
  scope: 'meetings:read',
  input: z.object({ id: meetingId, blocks: blocksArg.optional() }),
  annotations: { readOnlyHint: true },
  handler: async (input, context) => {
    const { exec } = context
    const clock = await clockFor(exec, context)
    const meeting = await getMeeting(exec, input.id)
    const agenda = await getAgenda(exec, input.id, { timeZone: clock.timeZone })
    const blocks = await computeBlocks(exec, input.id, {
      today: clock.today,
      now: clock.now,
      force: blocksFrom(input.blocks),
    })
    const candidates = await getCandidates(exec, input.id, clock.now)

    return {
      meeting: meetingOut(meeting, clock),
      markdown: renderBrief({
        meeting,
        agenda,
        blocks,
        timeZone: clock.timeZone,
        today: clock.today,
      }),
      blocks: generatedOut(blocks, clock),
      suggested: groupsOut(candidates.suggested),
    }
  },
})

// ─── series ──────────────────────────────────────────────────────────────────

export const listSeriesTool = defineTool({
  name: 'list_series',
  title: 'List series',
  description:
    'The recurring meetings of a context, each with its roster, default projects, group, ' +
    'standing agenda (skeleton) and generated-block settings.',
  scope: 'meetings:read',
  input: z.object({ context: contextArg }),
  annotations: { readOnlyHint: true },
  handler: async (input, { exec }) => {
    const target = await inferContext(exec, { context: input.context })
    return {
      context: { id: target.id, name: target.name },
      series: (await listSeries(exec, target.id)).map(seriesOut),
    }
  },
})

const SKELETON_RULE =
  'The standing agenda is laid down on each new occurrence: skeleton as ' +
  '[{ title, lines: [{ text, minutes }] }], or skeleton_outline as text whose headings (or ' +
  'top-level bullets) are the sections and what is under them the lines.'

export const createSeriesTool = defineTool({
  name: 'create_series',
  title: 'Create a series',
  description:
    'Add a recurring meeting to a context: its people, default projects, groups, standing ' +
    `agenda and generated blocks. ${SKELETON_RULE} ${BLOCKS_RULE} All off unless switched on. ` +
    'Check list_series first to avoid a duplicate.',
  scope: 'meetings:write',
  input: z.object({
    name: z.string().min(1),
    context: contextArg,
    people: z.array(z.string().min(1)).optional().describe('People, by name or id.'),
    here: z.array(z.string().min(1)).optional().describe('People who were there, by name or id.'),
    out: z.array(z.string().min(1)).optional().describe('People who were not there, by name or id.'),
    projects: z.array(z.string().min(1)).optional().describe('Projects, by name or id.'),
    group: z.string().min(1).optional().describe('Group name or id: one of groups.'),
    groups: groupsArg,
    skeleton: skeletonArg.optional(),
    skeleton_outline: z.string().min(1).optional(),
    blocks: blocksArg.optional(),
    idempotency_key: idempotencyKey,
  }),
  handler: async (input, context) =>
    write(context, 'create_series', input, async (tx) => {
      const target = await inferContext(tx, {
        context: input.context,
        project: input.projects?.[0],
        parties: [...(input.group ? [input.group] : []), ...(input.groups ?? [])],
      })

      const series = await createSeries(tx, {
        contextId: target.id,
        name: input.name,
        groupIds: (await groupIdsFrom(tx, target.id, input)) ?? [],
        personIds: await peopleFrom(tx, input.people ?? []),
        projectIds: await projectsFrom(tx, target.id, input.projects ?? []),
        skeleton: skeletonFrom(input),
        blocks: { ...NO_BLOCKS, ...blocksFrom(input.blocks) },
      })
      return { series: seriesOut(series) }
    }),
})

export const updateSeriesTool = defineTool({
  name: 'update_series',
  title: 'Update a series',
  description:
    'Change a series: its name, people, default projects, groups, standing agenda or ' +
    'generated blocks. people, projects, groups and the skeleton each replace the whole of what was ' +
    `there; blocks changes only the ones given. ${SKELETON_RULE} Meetings already prepped keep ` +
    'the agenda they have. Pass null to clear group. move_to moves the series to another ' +
    'context with its meetings, before anything else is applied, and returns which moved and ' +
    `which stayed (out of the series). ${MOVE_RULE}`,
  scope: 'meetings:write',
  input: z.object({
    series: z.string().min(1).describe('Series name or id.'),
    context: contextArg,
    move_to: z.string().min(1).optional().describe('Context name or id to move it to.'),
    name: z.string().min(1).optional(),
    people: z.array(z.string().min(1)).optional().describe('People, by name or id.'),
    here: z.array(z.string().min(1)).optional().describe('People who were there, by name or id.'),
    out: z.array(z.string().min(1)).optional().describe('People who were not there, by name or id.'),
    projects: z.array(z.string().min(1)).optional().describe('Projects, by name or id.'),
    group: z.string().min(1).nullable().optional().describe('Group name or id: the only group, or none with null.'),
    groups: groupsArg,
    skeleton: skeletonArg.optional(),
    skeleton_outline: z.string().min(1).optional(),
    blocks: blocksArg.optional(),
    idempotency_key: idempotencyKey,
  }),
  handler: async (input, context) =>
    write(context, 'update_series', input, async (tx) => {
      const clock = await clockFor(tx, context)
      const found = await inferContext(tx, { context: input.context, series: input.series })
      const { id } = await resolveSeries(tx, found.id, input.series)

      /* A move comes first, so the names that follow are read in the context
         the series ends up in. */
      const destination = input.move_to ? await inferContext(tx, { context: input.move_to }) : null
      const move = destination ? await moveSeries(tx, context.actor, id, destination.id) : null
      const target = destination ?? found
      const before = await getSeries(tx, id)

      await updateSeries(tx, id, {
        name: input.name,
        groupIds: await groupIdsFrom(tx, target.id, input),
        skeleton: skeletonFrom(input),
        blocks: input.blocks ? { ...before.blocks, ...blocksFrom(input.blocks) } : undefined,
      })
      if (input.people) await setSeriesPeople(tx, id, await peopleFrom(tx, input.people))
      if (input.projects) {
        await setSeriesProjects(tx, id, await projectsFrom(tx, target.id, input.projects))
      }
      return {
        series: seriesOut(await getSeries(tx, id)),
        ...(move
          ? {
              moved: move.moved.map((meeting) => meetingOut(meeting, clock)),
              stayed: move.stayed.map((meeting) => meetingOut(meeting, clock)),
            }
          : {}),
      }
    }),
})

export const meetingTools = [
  listMeetingsTool,
  getMeetingTool,
  prepMeetingTool,
  updateMeetingTool,
  splitNoteTool,
  setAgendaTool,
  editAgendaTool,
  getBriefingTool,
  listSeriesTool,
  createSeriesTool,
  updateSeriesTool,
]
