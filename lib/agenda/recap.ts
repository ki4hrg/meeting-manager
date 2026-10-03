/*
 * The recap of a meeting (docs/SPEC.md, "Workflow" → Export): computed when it
 * is asked for, never stored. It is what goes to the attendees afterwards.
 *
 * The leak rule binds it harder than anything else, because a recap leaves the
 * building. Decisions, owed items and closed items are drawn only from items
 * that were put on this agenda or came out of this meeting (`itemsOf`), never
 * from the candidate pull and never from everything an attendee happens to
 * owe. The lookahead's deadlines are held to the same set: the agenda's own
 * lookahead lists every dated item on the meeting's projects, which is right
 * for John's brief and too wide for something that is sent round.
 *
 * John is an owner like any other here. "Matched only through John" is a rule
 * about what an agenda pulls in; a recap reports what the meeting produced,
 * and what John took away is part of that.
 *
 * Private notes on agenda lines are never read into a recap.
 */

import { and, asc, eq, inArray } from 'drizzle-orm'
import { formatDay, formatSpan, formatWeekday, todayIn } from '../core/dates'
import { NotFoundError, type Executor } from '../core/types'
import {
  meetingPeople,
  meetings,
  notes,
  people,
  personEmails,
  processingRuns,
} from '../db/schema'
import { onShelf } from '../db/shelf'
import { isOpen, listItems, type ItemKind, type ItemStatus, type ItemView } from '../items/items'
import { lookaheadParts, markdownLeaf, rows, toHtml, toMarkdown, type Entry, type Part } from './brief'
import { computeBlocks, itemsOf } from './generated'
import { getAgenda } from './lines'
import type { LookaheadBlock } from './types'

type Meeting = typeof meetings.$inferSelect

export type RecapParty = { type: 'person' | 'group'; id: string; name: string; isSelf: boolean }

export type RecapItem = {
  itemId: string
  kind: ItemKind
  text: string
  dueOn: string | null
  overdue: boolean
  owners: RecapParty[]
  /** Who it is raised with; on an item John owns, who it is owed to. */
  with: RecapParty[]
}

export type Recap = {
  meeting: {
    id: string
    title: string
    startsAt: Date | null
    endsAt: Date | null
    /** Without John, as everywhere. A meeting with sessions lists everyone who came to any. */
    people: { id: string; name: string }[]
  }
  /** From the latest finished run of each note, in note order. */
  summary: string | null
  /** What was said under an agenda line, in agenda order. Only lines still on the agenda. */
  /** Agenda lines the notes said something about, with the line's public description. */
  lines: { lineId: string; text: string; description: string | null; summary: string }[]
  decisions: { itemId: string; text: string }[]
  /** Open questions and actions by owner; an item with several owners is under each.
      A null party holds what nobody owns yet. */
  owed: { party: RecapParty | null; items: RecapItem[] }[]
  closed: {
    itemId: string
    kind: ItemKind
    status: ItemStatus
    text: string
    resolution: string | null
  }[]
  lookahead: LookaheadBlock | null
  recipients: { personId: string; name: string; email: string }[]
  /** Carried so the renderers format dates as the user reads them. */
  today: string
  timeZone: string | null
  selfId: string
}

export type RecapOpts = {
  /** 'YYYY-MM-DD' in the user's time zone. */
  today: string
  timeZone: string | null
  /** John's person row. */
  selfId: string
  now?: Date
}

const partyOf = (party: ItemView['parties'][number], selfId: string): RecapParty => ({
  type: party.type,
  id: party.id,
  name: party.name,
  isSelf: party.isSelf || (party.type === 'person' && party.id === selfId),
})

/**
 * The recap of one meeting. A meeting with sessions gets one recap covering
 * all of them; a session's own recap covers only itself.
 */
export async function getRecap(exec: Executor, meetingId: string, opts: RecapOpts): Promise<Recap> {
  const [meeting] = await exec.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1)
  if (!meeting) throw new NotFoundError('Meeting', meetingId)

  const sessions = await exec
    .select()
    .from(meetings)
    .where(
      and(eq(meetings.parentMeetingId, meeting.id), eq(meetings.contextId, meeting.contextId), onShelf(meetings)),
    )
    .orderBy(asc(meetings.startsAt), asc(meetings.createdAt))
  const covered: Meeting[] = [meeting, ...sessions]
  const coveredIds = covered.map((row) => row.id)
  const now = opts.now ?? new Date()

  const starts = covered.flatMap((row) => (row.startsAt ? [row.startsAt.getTime()] : []))
  const since = starts.length > 0 ? new Date(Math.min(...starts)) : null

  // ─── the only items this recap may speak about ─────────────────────────────
  const mine = new Map<string, ItemView>()
  for (const list of await Promise.all(covered.map((row) => itemsOf(exec, row)))) {
    for (const item of list) mine.set(item.id, item)
  }
  const inOrder = (list: ItemView[]) =>
    list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))

  /* A decision recorded afterwards on something raised here belongs to the
     meeting too (as in "since last time"), and so does what superseded it:
     unless it was made in another meeting, or before this one. */
  const made = new Map(
    [...mine.values()]
      .filter((item) => item.kind === 'decision' && coveredIds.includes(item.originMeetingId ?? ''))
      .map((item) => [item.id, item]),
  )
  const thread = new Set(mine.keys())
  const others = (
    await listItems(exec, { contextId: meeting.contextId, kinds: ['decision'] })
  ).filter(
    (item) => !mine.has(item.id) && item.originMeetingId === null && (!since || item.createdAt >= since),
  )
  for (let grew = true; grew; ) {
    grew = false
    for (const item of others) {
      if (thread.has(item.id) || !item.parentItemId || !thread.has(item.parentItemId)) continue
      thread.add(item.id)
      made.set(item.id, item)
      grew = true
    }
  }
  const decisions = inOrder([...made.values()].filter((item) => item.status === 'decided'))

  const owedItems = [...mine.values()]
    .filter((item) => isOpen(item) && (item.kind === 'question' || item.kind === 'action'))
    // Deadlines first, soonest first; then in the order they were raised.
    .sort(
      (a, b) =>
        (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999') ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    )
  const byParty = new Map<string, Recap['owed'][number]>()
  for (const item of owedItems) {
    const entry: RecapItem = {
      itemId: item.id,
      kind: item.kind,
      text: item.text,
      dueOn: item.dueOn,
      overdue: item.dueOn !== null && item.dueOn < opts.today,
      owners: item.parties.filter((p) => p.role === 'owner').map((p) => partyOf(p, opts.selfId)),
      with: item.parties.filter((p) => p.role === 'with').map((p) => partyOf(p, opts.selfId)),
    }
    for (const party of entry.owners.length > 0 ? entry.owners : [null]) {
      const key = party ? `${party.type}:${party.id}` : ''
      const group = byParty.get(key) ?? { party, items: [] }
      group.items.push(entry)
      byParty.set(key, group)
    }
  }
  const owed = [...byParty.values()].sort((a, b) =>
    a.party && b.party ? a.party.name.localeCompare(b.party.name) : a.party ? -1 : b.party ? 1 : 0,
  )

  const closed = inOrder(
    [...mine.values()].filter(
      (item) =>
        item.kind !== 'decision' &&
        !isOpen(item) &&
        item.closedAt !== null &&
        (!since || item.closedAt >= since),
    ),
  ).map((item) => ({
    itemId: item.id,
    kind: item.kind,
    status: item.status,
    text: item.text,
    resolution: item.resolution,
  }))

  // ─── the summary, from the runs ────────────────────────────────────────────
  const noteRows = await exec
    .select({ id: notes.id, meetingId: notes.meetingId })
    .from(notes)
    .where(inArray(notes.meetingId, coveredIds))
    .orderBy(asc(notes.createdAt), asc(notes.id))
  // The meeting's own notes, then each session's in turn.
  noteRows.sort((a, b) => coveredIds.indexOf(a.meetingId!) - coveredIds.indexOf(b.meetingId!))

  const runs =
    noteRows.length === 0
      ? []
      : await exec
          .select()
          .from(processingRuns)
          .where(
            and(
              inArray(
                processingRuns.noteId,
                noteRows.map((note) => note.id),
              ),
              eq(processingRuns.status, 'done'),
            ),
          )
  const finished = (run: (typeof runs)[number]) => (run.finishedAt ?? run.createdAt).getTime()
  const outputs = noteRows.flatMap((note) => {
    const latest = runs
      .filter((run) => run.noteId === note.id)
      .sort((a, b) => finished(b) - finished(a))[0]
    return latest?.output ? [latest.output] : []
  })

  const summaries = outputs.map((output) => (output.summary ?? '').trim()).filter(Boolean)

  const said = new Map<string, string[]>()
  for (const output of outputs) {
    for (const line of output.lines ?? []) {
      const text = (line.summary ?? '').trim()
      if (text) said.set(line.lineId, [...(said.get(line.lineId) ?? []), text])
    }
  }
  const lines: Recap['lines'] = []
  if (said.size > 0) {
    for (const row of covered) {
      const agenda = await getAgenda(exec, row.id, { timeZone: opts.timeZone })
      const listed = agenda.nodes.flatMap((node) =>
        node.type === 'section'
          ? [
              { id: node.id, text: node.title, description: null },
              ...node.lines.map(({ id, text, description }) => ({ id, text, description })),
            ]
          : [{ id: node.id, text: node.text, description: node.description }],
      )
      for (const { id, text, description } of listed) {
        const summary = said.get(id)
        if (summary) lines.push({ lineId: id, text, description, summary: summary.join('\n\n') })
      }
    }
  }

  // ─── lookahead ─────────────────────────────────────────────────────────────
  const block = (
    await computeBlocks(exec, meeting.id, {
      today: opts.today,
      now,
      force: { followUps: false, sinceLast: false, lookahead: true },
    })
  ).lookahead
  const listed = new Set(owedItems.map((item) => item.id))
  const ahead: LookaheadBlock = {
    milestones: block?.milestones ?? [],
    // Only what this meeting raised, and not what "owed" has already said.
    deadlines: (block?.deadlines ?? []).filter(
      (deadline) => mine.has(deadline.itemId) && !listed.has(deadline.itemId),
    ),
    // Its own sessions are not "next", and neither is anything already past.
    meetings: (block?.meetings ?? []).filter(
      (next) => !coveredIds.includes(next.id) && next.startsAt > now,
    ),
  }
  const lookahead =
    ahead.milestones.length + ahead.deadlines.length + ahead.meetings.length > 0 ? ahead : null

  // ─── who it goes to ────────────────────────────────────────────────────────
  const attendeeRows = await exec
    .selectDistinct({ id: people.id, name: people.name, isSelf: people.isSelf })
    .from(meetingPeople)
    .innerJoin(people, eq(people.id, meetingPeople.personId))
    .where(inArray(meetingPeople.meetingId, coveredIds))
    .orderBy(asc(people.name))
  const attendees = attendeeRows
    .filter((person) => !person.isSelf && person.id !== opts.selfId)
    .map(({ id, name }) => ({ id, name }))

  const emails =
    attendees.length === 0
      ? []
      : await exec
          .select()
          .from(personEmails)
          .where(
            inArray(
              personEmails.personId,
              attendees.map((person) => person.id),
            ),
          )
          .orderBy(asc(personEmails.createdAt))
  const recipients = attendees.flatMap((person) => {
    const own = emails.filter((email) => email.personId === person.id)
    // The primary address; one that was never marked is still better than none.
    const address = own.find((email) => email.isPrimary) ?? own[0]
    return address ? [{ personId: person.id, name: person.name, email: address.email }] : []
  })

  return {
    meeting: {
      id: meeting.id,
      title: meeting.title,
      startsAt: meeting.startsAt,
      endsAt: meeting.endsAt,
      people: attendees,
    },
    summary: summaries.length > 0 ? summaries.join('\n\n') : null,
    lines,
    decisions: decisions.map((item) => ({ itemId: item.id, text: item.text })),
    owed,
    closed,
    lookahead,
    recipients,
    today: opts.today,
    timeZone: opts.timeZone,
    selfId: opts.selfId,
  }
}

// ─── writing out ─────────────────────────────────────────────────────────────

const leaf = (text: string): Entry => ({ text, sub: [] })

/* Prose a model wrote: paragraphs, and runs of `- ` lines as lists. */
function prose(text: string): Part[] {
  const parts: Part[] = []
  for (const paragraph of text.split(/\n\s*\n/)) {
    let words: string[] = []
    let bullets: Entry[] = []
    const flush = () => {
      if (words.length > 0) parts.push({ type: 'p', text: words.join(' ') })
      if (bullets.length > 0) parts.push({ type: 'list', entries: bullets })
      words = []
      bullets = []
    }
    for (const line of paragraph.split('\n').map((row) => row.trim())) {
      if (line === '') continue
      const bullet = /^[-*•]\s+(.*)$/.exec(line)
      if (bullet) {
        if (words.length > 0) flush()
        bullets.push(leaf(bullet[1]!))
      } else {
        if (bullets.length > 0) flush()
        words.push(line)
      }
    }
    flush()
  }
  return parts
}

function owedText(item: RecapItem, today: string): string {
  const bits: string[] = [item.kind]
  if (item.dueOn) bits.push(`due ${formatDay(item.dueOn, today)}`)
  if (item.overdue) bits.push('overdue')
  return `${item.text} [${bits.join(', ')}]`
}

function day(recap: Recap): string | null {
  return recap.meeting.startsAt ? todayIn(recap.timeZone, recap.meeting.startsAt) : null
}

function recapParts(recap: Recap): Part[] {
  const { meeting, today, timeZone } = recap
  const parts: Part[] = [{ type: 'h1', text: meeting.title }]

  const facts: string[] = []
  if (meeting.startsAt) facts.push(formatSpan(meeting.startsAt, meeting.endsAt, timeZone, today))
  if (meeting.people.length > 0) facts.push(meeting.people.map((person) => person.name).join(', '))
  if (facts.length > 0) parts.push({ type: 'p', text: facts.join(' · ') })

  if (recap.summary) parts.push({ type: 'h2', text: 'Summary' }, ...prose(recap.summary))

  if (recap.lines.length > 0) {
    parts.push(
      { type: 'h2', text: 'Discussed' },
      {
        type: 'list',
        entries: recap.lines.map((line) => ({
          text: line.text,
          bold: true,
          sub: [...rows(line.description).map(markdownLeaf), ...rows(line.summary).map(leaf)],
        })),
      },
    )
  }

  if (recap.decisions.length > 0) {
    parts.push(
      { type: 'h2', text: 'Decisions' },
      { type: 'list', entries: recap.decisions.map((decision) => leaf(decision.text)) },
    )
  }

  if (recap.owed.length > 0) {
    parts.push({ type: 'h2', text: 'Follow-ups' })
    for (const { party, items } of recap.owed) {
      parts.push(
        { type: 'label', text: party?.name ?? 'Unassigned' },
        { type: 'list', entries: items.map((item) => leaf(owedText(item, today))) },
      )
    }
  }

  if (recap.closed.length > 0) {
    parts.push(
      { type: 'h2', text: 'Closed' },
      {
        type: 'list',
        entries: recap.closed.map((item) => {
          const how = item.resolution ?? (item.status === 'dropped' ? 'dropped' : null)
          return leaf(how ? `${item.text} — ${how}` : item.text)
        }),
      },
    )
  }

  if (recap.lookahead) {
    parts.push(
      ...lookaheadParts(
        { blocks: { followUps: null, sinceLast: null, lookahead: recap.lookahead }, timeZone },
        today,
      ),
    )
  }
  return parts
}

/** The recap as Markdown. Sections with nothing in them are left out. */
export function renderRecap(recap: Recap): string {
  return toMarkdown(recapParts(recap))
}

/** The same as rich text, for the clipboard's text/html. */
export function renderRecapHtml(recap: Recap): string {
  return toHtml(recapParts(recap))
}

/**
 * "Your items" for one person or group, as Markdown: what they owe from this
 * meeting, and what John owes them. Empty when there is neither.
 */
export function renderPersonSnippet(
  recap: Recap,
  party: { type: 'person' | 'group'; id: string },
): string {
  const is = (other: RecapParty) => other.type === party.type && other.id === party.id
  const yours = recap.owed.find((group) => group.party && is(group.party))?.items ?? []

  // `with` on an item John owns is who it is owed to; on anyone else's it is not.
  const seen = new Set<string>()
  const toYou = recap.owed
    .flatMap((group) => group.items)
    .filter((item) => {
      if (seen.has(item.itemId)) return false
      seen.add(item.itemId)
      return item.with.some(is) && item.owners.some((owner) => owner.isSelf) && !item.owners.some(is)
    })
  if (yours.length + toYou.length === 0) return ''

  const when = day(recap)
  const parts: Part[] = [
    { type: 'p', text: `${recap.meeting.title}${when ? ` · ${formatWeekday(when, recap.today)}` : ''}` },
  ]
  const group = (label: string, items: RecapItem[]) => {
    if (items.length === 0) return
    parts.push(
      { type: 'label', text: label },
      { type: 'list', entries: items.map((item) => leaf(owedText(item, recap.today))) },
    )
  }
  group('Yours', yours)
  group('Owed to you', toYou)
  return toMarkdown(parts)
}

/** The subject line of the recap email. */
export function recapSubject(recap: Recap): string {
  const when = day(recap)
  return `Recap: ${recap.meeting.title}${when ? `, ${formatDay(when, recap.today)}` : ''}`
}

/**
 * A `mailto:` with the recipients and the subject and no body: the body goes
 * to the clipboard, because a URL cannot carry rich text.
 */
export function recapMailto(recap: Recap): string {
  // `@` is left readable; everything else that could end the address list is encoded.
  const to = recap.recipients.map((r) => encodeURIComponent(r.email).replace(/%40/g, '@')).join(',')
  return `mailto:${to}?subject=${encodeURIComponent(recapSubject(recap))}`
}
