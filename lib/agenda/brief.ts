/*
 * The two things an agenda is copied out as (docs/SPEC.md, "Brief for Granola").
 *
 * The brief is John's own: the agenda with planned start times, his private
 * notes, who owes what, and the generated blocks. It is pasted into Granola's
 * notepad before the meeting. The public agenda is what can be sent round: no
 * private notes, nothing about who owes what. A line's description and its
 * leader go out in both.
 *
 * Both are built once as a small outline and written out twice, as Markdown
 * (text/plain) and as HTML (text/html), so a paste keeps its headings and
 * nesting wherever it lands.
 *
 * An item's kind is written as a word in brackets, never as a `Q:` or `A:`
 * prefix: those prefixes in Granola's notepad mean "capture this line", and a
 * brief must not read as a list of new items.
 */

import { formatClock, formatDay, formatSpan, formatTime, todayIn } from '../core/dates'
import type { ItemView } from '../items/items'
import type { Agenda, AgendaLine } from './lines'
import type { GeneratedBlocks } from './types'

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

/* A bullet, with whatever is nested under it. A section is a bold bullet whose
   lines are nested, so it is plain where it ends and the loose lines resume. */
export type Entry = { text: string; bold?: boolean; sub: Entry[] }

export type Part =
  | { type: 'h1' | 'h2' | 'p' | 'label'; text: string }
  | { type: 'list'; entries: Entry[] }

const leaf = (text: string): Entry => ({ text, sub: [] })

const minutes = (value: number | null) => (value ? ` (${value} min)` : '')
const led = (line: AgendaLine) => (line.leader ? ` — ${line.leader.name}` : '')
/* Text written across several lines, as one bullet per line. A Markdown
   bullet's own marker is dropped: the line is already a bullet here. */
const rows = (text: string | null) =>
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

function header(input: BriefInput, today: string): Part[] {
  const { meeting, agenda, timeZone } = input
  const facts: string[] = []
  if (meeting.startsAt) facts.push(formatSpan(meeting.startsAt, meeting.endsAt ?? null, timeZone, today))
  if (agenda.overflowMinutes > 0) facts.push(`${agenda.overflowMinutes} min over`)
  if (meeting.people.length > 0) facts.push(meeting.people.map((person) => person.name).join(', '))

  const parts: Part[] = [{ type: 'h1', text: meeting.title }]
  if (facts.length > 0) parts.push({ type: 'p', text: facts.join(' · ') })
  return parts
}

function agendaParts(input: BriefInput, today: string, opts: { private: boolean }): Part[] {
  const sessions = input.sessions ?? []
  if (sessions.length === 0) return agendaOf(input.agenda, 'Agenda', null, today, opts)
  /* The meeting's own lines, from before it had sessions, then each session's. */
  return [
    ...agendaOf(input.agenda, 'Agenda', null, today, opts),
    ...sessions.flatMap((session) =>
      agendaOf(
        session.agenda,
        session.title,
        session.startsAt ? formatSpan(session.startsAt, session.endsAt, input.timeZone, today) : null,
        today,
        { ...opts, keepEmpty: true },
      ),
    ),
  ]
}

function agendaOf(
  agenda: Agenda,
  title: string,
  when: string | null,
  today: string,
  opts: { private: boolean; keepEmpty?: boolean },
): Part[] {
  if (agenda.nodes.length === 0 && !opts.keepEmpty) return []

  const entry = (line: AgendaLine): Entry => ({
    text: `${at(line.start)}${line.text}${led(line)}${opts.private ? tag(line.item, today) : ''}${minutes(line.minutes)}`,
    sub: [
      ...rows(line.description).map(leaf),
      ...(opts.private
        ? rows(line.privateNote).map((row, index) => leaf(index === 0 ? `Note: ${row}` : row))
        : []),
    ],
  })

  const parts: Part[] = [{ type: 'h2', text: title }]
  if (when) parts.push({ type: 'p', text: when })
  if (agenda.nodes.length === 0) return parts
  parts.push(
    {
      type: 'list',
      entries: agenda.nodes.map((node) =>
        node.type === 'line'
          ? entry(node)
          : {
              text: `${at(node.start)}${node.title}${minutes(node.minutes)}`,
              bold: true,
              sub: node.lines.map(entry),
            },
      ),
    },
  )

  if (agenda.end && agenda.totalMinutes > 0) {
    parts.push({ type: 'p', text: `Ends ${formatClock(agenda.end)} · ${agenda.totalMinutes} min planned` })
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

function briefParts(input: BriefInput): Part[] {
  const today = input.today ?? todayIn(input.timeZone)
  return [
    ...header(input, today),
    ...agendaParts(input, today, { private: true }),
    ...followUpParts(input, today),
    ...sinceLastParts(input, today),
    ...lookaheadParts(input, today),
  ]
}

function publicParts(input: BriefInput): Part[] {
  const today = input.today ?? todayIn(input.timeZone)
  return [
    ...header(input, today),
    ...agendaParts(input, today, { private: false }),
    ...lookaheadParts(input, today),
  ]
}

// ─── writing out ─────────────────────────────────────────────────────────────

export function toMarkdown(parts: Part[]): string {
  const out: string[] = []
  const bullets = (entries: Entry[], indent: string) => {
    for (const entry of entries) {
      out.push(`${indent}- ${entry.bold ? `**${entry.text}**` : entry.text}`)
      bullets(entry.sub, `${indent}  `)
    }
  }

  let previous: Part['type'] | null = null
  for (const part of parts) {
    if (part.type === 'list') bullets(part.entries, '')
    else if (part.type === 'h1') out.push(`# ${part.text}`)
    else if (part.type === 'h2') out.push('', `## ${part.text}`)
    else if (part.type === 'label') out.push('', `**${part.text}**`)
    // A paragraph straight after a list would read as part of its last bullet,
    // and one after another paragraph as the same paragraph.
    else if (previous === 'list' || previous === 'p') out.push('', part.text)
    else out.push(part.text)
    previous = part.type
  }
  return out.join('\n')
}

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function toHtml(parts: Part[]): string {
  const bullets = (entries: Entry[]): string =>
    entries.length === 0
      ? ''
      : `<ul>${entries
          .map((entry) => {
            const text = entry.bold ? `<strong>${escape(entry.text)}</strong>` : escape(entry.text)
            return `<li>${text}${bullets(entry.sub)}</li>`
          })
          .join('')}</ul>`

  return parts
    .map((part) => {
      if (part.type === 'list') return bullets(part.entries)
      if (part.type === 'label') return `<p><strong>${escape(part.text)}</strong></p>`
      return `<${part.type}>${escape(part.text)}</${part.type}>`
    })
    .join('')
}

/** The brief for Granola, as Markdown: private notes, owners and every block. */
export function renderBrief(input: BriefInput): string {
  return toMarkdown(briefParts(input))
}

export function renderBriefHtml(input: BriefInput): string {
  return toHtml(briefParts(input))
}

/** The agenda as it can be sent round: no private notes, nothing about who owes what. */
export function renderAgenda(input: BriefInput): string {
  return toMarkdown(publicParts(input))
}

export function renderAgendaHtml(input: BriefInput): string {
  return toHtml(publicParts(input))
}
