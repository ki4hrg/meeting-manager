/*
 * An agenda as it is exported (docs/SPEC.md, "Private and shareable").
 *
 * One outline holds everything: the agenda with planned start times, each
 * line's description and leader, John's private notes, who owes what, and the
 * generated blocks. What goes out is that outline filtered by the parts
 * chosen (lib/agenda/export.ts). Two presets cover the common cases: Private,
 * everything, for John's own notepad before the meeting; and Shareable, what
 * can be sent round: no private notes, nothing about who owes what.
 *
 * An item's kind is written as a word in brackets, never as a `Q:` or `A:`
 * prefix: those prefixes in a notepad mean "capture this line", and an export
 * must not read as a list of new items, whatever parts it holds.
 */

import { formatClock, formatDay, formatSpan, formatTime, todayIn } from '../core/dates'
import type { ItemView } from '../items/items'
import type { Agenda, AgendaLine } from './lines'
import {
  only,
  pick,
  preset,
  toHtml,
  toMarkdown,
  type Entry,
  type OutlineEntry,
  type OutlinePart,
  type Part,
  type Piece,
} from './export'
import type { GeneratedBlocks } from './types'

export { toHtml, toMarkdown, type Entry, type Part }

export type BriefInput = {
  meeting: {
    title: string
    startsAt: Date | null
    endsAt?: Date | null
    people: Array<{ name: string }>
  }
  agenda: Agenda
  /** A multi-day meeting's sessions, in order: its agenda is theirs, one after another. */
  sessions?: Array<{ title: string; startsAt: Date | null; endsAt: Date | null; agenda: Agenda }>
  blocks: GeneratedBlocks
  timeZone?: string | null | undefined
  /** 'YYYY-MM-DD' in the user's zone; decides whether dates carry a year. */
  today?: string
}

const leaf = (text: string): Entry => ({ text, sub: [] })
/* A row of long text: Markdown, so the HTML copy renders its bold and links. */
export const markdownLeaf = (text: string): Entry => ({ text, markdown: true, sub: [] })

const minutes = (value: number | null) => (value ? ` (${value} min)` : '')
const led = (line: AgendaLine) => (line.leader ? ` — ${line.leader.name}` : '')
/* Text written across several lines, as one bullet per line. A Markdown
   bullet's own marker is dropped: the line is already a bullet here. */
export const rows = (text: string | null) =>
  (text ?? '')
    .split('\n')
    .map((row) => row.trim().replace(/^[-*•]\s+/, ''))
    .filter(Boolean)
const at = (start: string | null) => (start ? `${formatClock(start)} · ` : '')

/* What an item line says beyond its text: its kind when something is owed, who owes it, and by when. */
function tag(item: ItemView | null, today: string): string {
  if (!item || item.kind === 'topic') return ''
  const owners = item.parties
    .filter((party) => party.role === 'owner')
    .map((party) => (party.isSelf ? 'me' : party.name))
  const bits = [item.kind, ...owners]
  if (item.dueOn) bits.push(`due ${formatDay(item.dueOn, today)}`)
  return ` [${bits.join(', ')}]`
}

function header(input: BriefInput, today: string): OutlinePart[] {
  const { meeting, agenda, timeZone } = input
  const facts: Piece[] = []
  if (meeting.startsAt) facts.push(formatSpan(meeting.startsAt, meeting.endsAt ?? null, timeZone, today))
  if (agenda.overflowMinutes > 0) facts.push(`${agenda.overflowMinutes} min over`)
  if (meeting.people.length > 0) {
    facts.push({ only: 'attendees', text: meeting.people.map((person) => person.name).join(', ') })
  }

  const parts: OutlinePart[] = [{ type: 'h1', text: meeting.title }]
  if (facts.length > 0) parts.push({ type: 'p', text: facts, join: ' · ' })
  return parts
}

function agendaParts(input: BriefInput, today: string): OutlinePart[] {
  const sessions = input.sessions ?? []
  if (sessions.length === 0) return agendaOf(input.agenda, 'Agenda', null, today)
  /* The meeting's own lines, from before it had sessions, then each session's. */
  return [
    ...agendaOf(input.agenda, 'Agenda', null, today),
    ...sessions.flatMap((session) =>
      agendaOf(
        session.agenda,
        session.title,
        session.startsAt ? formatSpan(session.startsAt, session.endsAt, input.timeZone, today) : null,
        today,
        { keepEmpty: true },
      ),
    ),
  ]
}

function agendaOf(
  agenda: Agenda,
  title: string,
  when: string | null,
  today: string,
  opts: { keepEmpty?: boolean } = {},
): OutlinePart[] {
  if (agenda.nodes.length === 0 && !opts.keepEmpty) return []

  const entry = (line: AgendaLine): OutlineEntry => ({
    text: [
      { only: 'times', text: at(line.start) },
      line.text,
      { only: 'details', text: led(line) },
      { only: 'owed', text: tag(line.item, today) },
      minutes(line.minutes ?? line.shareMinutes ?? null),
    ],
    sub: [
      ...only('details', rows(line.description).map(markdownLeaf)),
      ...only(
        'notes',
        rows(line.privateNote).map((row, index) => markdownLeaf(index === 0 ? `Note: ${row}` : row)),
      ),
    ],
  })

  const parts: OutlinePart[] = [{ type: 'h2', text: title }]
  if (when) parts.push({ type: 'p', text: when })
  if (agenda.nodes.length === 0) return parts
  parts.push(
    {
      type: 'list',
      entries: agenda.nodes.map((node) =>
        node.type === 'line'
          ? entry(node)
          : {
              text: [{ only: 'times', text: at(node.start) }, node.title, minutes(node.minutes)],
              bold: true,
              sub: node.lines.map(entry),
            },
      ),
    },
  )

  if (agenda.end && agenda.totalMinutes > 0) {
    parts.push({ only: 'times', type: 'p', text: `Ends ${formatClock(agenda.end)} · ${agenda.totalMinutes} min planned` })
  }
  return parts
}

function followUpParts(input: BriefInput, today: string): Part[] {
  const block = input.blocks.followUps
  if (!block) return []
  const parts: Part[] = [{ type: 'h2', text: 'Follow-ups due' }]
  for (const { party, items } of block) {
    parts.push({ type: 'label', text: party.name })
    parts.push({
      type: 'list',
      entries: items.map((item) => {
        const bits: string[] = [item.kind]
        if (item.dueOn) bits.push(`due ${formatDay(item.dueOn, today)}`)
        if (item.overdue) bits.push('overdue')
        return leaf(`${item.text} [${bits.join(', ')}]`)
      }),
    })
  }
  return parts
}

function sinceLastParts(input: BriefInput, today: string): Part[] {
  const block = input.blocks.sinceLast
  if (!block) return []
  const when = block.meeting.startsAt
    ? ` (${formatDay(todayIn(input.timeZone, block.meeting.startsAt), today)})`
    : ''
  const parts: Part[] = [{ type: 'h2', text: `Since last time${when}` }]
  const group = (label: string, entries: string[]) => {
    if (entries.length === 0) return
    parts.push({ type: 'label', text: label })
    parts.push({ type: 'list', entries: entries.map(leaf) })
  }
  group(
    'Decided',
    block.decisions.map((decision) => decision.text),
  )
  group(
    'Closed',
    block.closed.map((item) => (item.resolution ? `${item.text} — ${item.resolution}` : item.text)),
  )
  group(
    'Still open',
    block.stillOpen.map((item) => `${item.text}${item.kind === 'topic' ? '' : ` [${item.kind}]`}`),
  )
  return parts
}

export function lookaheadParts(
  input: Pick<BriefInput, 'blocks' | 'timeZone'>,
  today: string,
): Part[] {
  const block = input.blocks.lookahead
  if (!block) return []

  // Milestones and deadlines in one run, by date; then the meetings to come.
  const dated = [
    ...block.milestones.map((milestone) => ({
      dueOn: milestone.dueOn,
      text: `${milestone.projectName}: ${milestone.title} [milestone]`,
    })),
    ...block.deadlines.map((deadline) => ({
      dueOn: deadline.dueOn,
      text: `${deadline.projectName ? `${deadline.projectName}: ` : ''}${deadline.text} [${deadline.kind}]`,
    })),
  ].sort((a, b) => a.dueOn.localeCompare(b.dueOn))

  const entries = [
    ...dated.map((row) => leaf(`${formatDay(row.dueOn, today)} · ${row.text}`)),
    ...block.meetings.map((meeting) =>
      leaf(
        `${formatDay(todayIn(input.timeZone, meeting.startsAt), today)}, ${formatTime(meeting.startsAt, input.timeZone)} · ${meeting.title} [meeting]`,
      ),
    ),
  ]
  return [
    { type: 'h2', text: 'Lookahead' },
    { type: 'list', entries },
  ]
}

// ─── writing out ─────────────────────────────────────────────────────────────

/** Everything an agenda can export, each optional piece marked with its part. */
export function briefOutline(input: BriefInput): OutlinePart[] {
  const today = input.today ?? todayIn(input.timeZone)
  return [
    ...header(input, today),
    ...agendaParts(input, today),
    ...only('followUps', followUpParts(input, today)),
    ...only('sinceLast', sinceLastParts(input, today)),
    ...only('lookahead', lookaheadParts(input, today)),
  ]
}

const PRIVATE = preset('agenda', 'Private')
const SHAREABLE = preset('agenda', 'Shareable')

/** The Private preset as Markdown: private notes, owners and every block. */
export function renderBrief(input: BriefInput): string {
  return toMarkdown(pick(briefOutline(input), PRIVATE))
}

export function renderBriefHtml(input: BriefInput): string {
  return toHtml(pick(briefOutline(input), PRIVATE))
}

/** The Shareable preset: no private notes, nothing about who owes what. */
export function renderAgenda(input: BriefInput): string {
  return toMarkdown(pick(briefOutline(input), SHAREABLE))
}

export function renderAgendaHtml(input: BriefInput): string {
  return toHtml(pick(briefOutline(input), SHAREABLE))
}
