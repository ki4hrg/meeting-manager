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
 *
 * Its prose (the summary and what was said under each line) is the model's
 * until John rewords it: his edits are kept on the meeting (`recap_edits`)
 * and stand over whatever a later run writes. Items are edited as items.
 */

import { and, asc, eq, inArray } from 'drizzle-orm'
import { dateRelativeDays, formatDay, formatSpan, formatWeekday, todayIn } from '../core/dates'
import { NotFoundError, type ActorContext, type Executor } from '../core/types'
import { meetings, notes, people, personEmails, processingRuns, type RecapEdits } from '../db/schema'
import { onShelf } from '../db/shelf'
import { getMeeting } from '../meetings/meetings'
import { isOpen, listItems, type ItemKind, type ItemStatus, type ItemView } from '../items/items'
import { isOwed, owersOf } from '../items/horizon'
import { decisionEntry, lookaheadParts, markdownLeaf, reportBack, rows } from './brief'
import {
  only,
  pick,
  preset,
  toHtml,
  toMarkdown,
  type Entry,
  type OutlinePart,
  type Part,
  type Piece,
} from './export'
import { computeBlocks, decisionSays, itemsOf } from './generated'
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
  /** Who owes it: on a topic, only its raiser. */
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
  /** `says`: the decision itself, when its text names only what it was about. */
  decisions: { itemId: string; text: string; says: string | null }[]
  /** What is owed, by who owes it (`owersOf`: a topic's raiser, never its collaborators);
      an item with several owners is under each.
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
  /** Whether John has reworded any of its prose. */
  edited: boolean
  /** Everyone invited, here or not, with an address. */
  recipients: Recipient[]
  /** Of them, who John said was there. */
  hereRecipients: Recipient[]
  /** Carried so the renderers format dates as the user reads them. */
  today: string
  timeZone: string | null
  selfId: string
  /** John's name, for a snippet that has to say who owes whom. */
  selfName: string
}

type Recipient = { personId: string; name: string; email: string }

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
    // What someone owes (`isOwed`): a topic only when someone other than John raises it.
    .filter((item) => isOpen(item) && isOwed(item))
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
      owners: owersOf(item).map((p) => partyOf(p, opts.selfId)),
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
  const edits: RecapEdits = meeting.recapEdits ?? {}
  /* Prose is written as of the meeting and read later, by people who were not
     all there: a "tomorrow" in it carries its date. */
  const meetingDay = meeting.startsAt ? todayIn(opts.timeZone, meeting.startsAt) : null
  const dated = (text: string | null) =>
    text && meetingDay ? dateRelativeDays(text, meetingDay, opts.today) : text
  const lines: Recap['lines'] = []
  if (said.size > 0 || Object.keys(edits.lines ?? {}).length > 0) {
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
        const own = edits.lines?.[id]
        const summary = own !== undefined ? own.trim() : (said.get(id) ?? []).join('\n\n')
        if (summary) lines.push({ lineId: id, text, description, summary: dated(summary)! })
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
  /* Everyone on it or any of its sessions: their people and, until the list
     is copied, their groups' members, here, not yet said or marked out. Who was
     there is those said to be here at any of them. John is never among them. */
  const byId = new Map<string, { id: string; name: string }>()
  const here = new Set<string>()
  for (const id of coveredIds) {
    const one = await getMeeting(exec, id)
    for (const person of one.attendees) {
      byId.set(person.id, { id: person.id, name: person.name })
      if (person.here) here.add(person.id)
    }
    for (const person of one.absent) if (!byId.has(person.id)) byId.set(person.id, { id: person.id, name: person.name })
  }
  const attendees = [...byId.values()]
    .filter((person) => person.id !== opts.selfId)
    .sort((a, b) => a.name.localeCompare(b.name))

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
    summary: dated(
      edits.summary !== undefined
        ? edits.summary.trim() || null
        : summaries.length > 0
          ? summaries.join('\n\n')
          : null,
    ),
    lines,
    decisions: decisions.map((item) => ({ itemId: item.id, text: item.text, says: decisionSays(item) })),
    owed,
    closed,
    lookahead,
    edited: edits.summary !== undefined || Object.keys(edits.lines ?? {}).length > 0,
    recipients,
    hereRecipients: recipients.filter((recipient) => here.has(recipient.personId)),
    today: opts.today,
    timeZone: opts.timeZone,
    selfId: opts.selfId,
    selfName: owed.flatMap((group) => group.items.flatMap((item) => [...item.owners, ...item.with]))
      .find((party) => party.isSelf)?.name ?? (await selfNameOf(exec, opts.selfId)),
  }
}

async function selfNameOf(exec: Executor, selfId: string): Promise<string> {
  const [row] = await exec.select({ name: people.name }).from(people).where(eq(people.id, selfId)).limit(1)
  return row?.name ?? 'John'
}

/**
 * Reword a recap's prose. Only what is given changes: a summary or a line's
 * text replaces the computed one, an empty string leaves it out, and null
 * clears every edit, so the recap is the runs' again.
 */
export async function setRecapEdits(
  exec: Executor,
  _actor: ActorContext,
  meetingId: string,
  change: RecapEdits | null,
): Promise<void> {
  const [meeting] = await exec.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1)
  if (!meeting) throw new NotFoundError('Meeting', meetingId)
  const was = meeting.recapEdits ?? {}
  const next: RecapEdits | null =
    change === null
      ? null
      : {
          ...(change.summary !== undefined
            ? { summary: change.summary }
            : was.summary !== undefined
              ? { summary: was.summary }
              : {}),
          lines: { ...was.lines, ...change.lines },
        }
  await exec
    .update(meetings)
    .set({ recapEdits: next, updatedAt: new Date() })
    .where(eq(meetings.id, meetingId))
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
  const bits: string[] = [
    item.kind === 'topic'
      ? reportBack(item.with.filter((party) => !party.isSelf).map((party) => party.name))
      : item.kind,
  ]
  if (item.dueOn) bits.push(`due ${formatDay(item.dueOn, today)}`)
  if (item.overdue) bits.push('overdue')
  return `${item.text} [${bits.join(', ')}]`
}

function day(recap: Recap): string | null {
  return recap.meeting.startsAt ? todayIn(recap.timeZone, recap.meeting.startsAt) : null
}

/* A line that was discussed: its text, its public description, then what was said. */
const lineEntry = (line: Recap['lines'][number]): Entry => ({
  text: line.text,
  bold: true,
  sub: [...rows(line.description).map(markdownLeaf), ...rows(line.summary).map(leaf)],
})

/** Everything a recap can export, each section marked with its part. */
export function recapOutline(recap: Recap): OutlinePart[] {
  const { meeting, today, timeZone } = recap
  const parts: OutlinePart[] = [{ type: 'h1', text: meeting.title }]

  const facts: Piece[] = []
  if (meeting.startsAt) facts.push(formatSpan(meeting.startsAt, meeting.endsAt, timeZone, today))
  if (meeting.people.length > 0) {
    facts.push({ only: 'attendees', text: meeting.people.map((person) => person.name).join(', ') })
  }
  if (facts.length > 0) parts.push({ type: 'p', text: facts, join: ' · ' })

  if (recap.summary) parts.push(...only('summary', [{ type: 'h2', text: 'Summary' }, ...prose(recap.summary)]))

  if (recap.lines.length > 0) {
    parts.push(
      ...only<OutlinePart>('discussed', [
        { type: 'h2', text: 'Discussed' },
        { type: 'list', entries: recap.lines.map(lineEntry) },
      ]),
    )
  }

  if (recap.decisions.length > 0) {
    parts.push(
      ...only<OutlinePart>('decisions', [
        { type: 'h2', text: 'Decisions' },
        { type: 'list', entries: recap.decisions.map(decisionEntry) },
      ]),
    )
  }

  if (recap.owed.length > 0) {
    parts.push(
      ...only<OutlinePart>('followUps', [
        { type: 'h2', text: 'Follow-ups' },
        ...recap.owed.flatMap(({ party, items }): Part[] => [
          { type: 'label', text: party?.name ?? 'Unassigned' },
          { type: 'list', entries: items.map((item) => leaf(owedText(item, today))) },
        ]),
      ]),
    )
  }

  if (recap.closed.length > 0) {
    parts.push(
      ...only<OutlinePart>('closed', [
        { type: 'h2', text: 'Closed' },
        {
        type: 'list',
        entries: recap.closed.map((item) => {
          const how = item.resolution ?? (item.status === 'dropped' ? 'dropped' : null)
          return leaf(how ? `${item.text} — ${how}` : item.text)
        }),
        },
      ]),
    )
  }

  if (recap.lookahead) {
    parts.push(
      ...only(
        'lookahead',
        lookaheadParts(
          { blocks: { followUps: null, sinceLast: null, lookahead: recap.lookahead }, timeZone },
          today,
        ),
      ),
    )
  }
  return parts
}

const WHOLE = preset('recap', 'Shareable')

/** The recap as Markdown. Sections with nothing in them are left out. */
export function renderRecap(recap: Recap): string {
  return toMarkdown(pick(recapOutline(recap), WHOLE))
}

/** The same as rich text, for the clipboard's text/html. */
export function renderRecapHtml(recap: Recap): string {
  return toHtml(pick(recapOutline(recap), WHOLE))
}

/**
 * The shareable recap as HTML in the pieces its page edits in place: the
 * heading, the summary, each line discussed, and the rest after them.
 */
export function recapPieces(recap: Recap): {
  head: string
  summary: string | null
  lines: Array<Recap['lines'][number] & { html: string }>
  rest: string
} {
  const kept = pick(recapOutline({ ...recap, summary: null, lines: [] }), WHOLE)
  const split = kept.findIndex((part) => part.type === 'h2')
  const at = split === -1 ? kept.length : split
  return {
    head: toHtml(kept.slice(0, at)),
    summary: recap.summary ? toHtml(prose(recap.summary)) : null,
    lines: recap.lines.map((line) => ({ ...line, html: toHtml([{ type: 'list', entries: [lineEntry(line)] }]) })),
    rest: toHtml(kept.slice(at)),
  }
}

/**
 * "Your items" for one person or group, as Markdown: what they owe from this
 * meeting, and what John owes them. Empty when there is neither. Each list
 * names who owes whom, so it reads the same to John and to them.
 */
export function renderPersonSnippet(
  recap: Recap,
  party: { type: 'person' | 'group'; id: string; name?: string },
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
  const name =
    party.name ?? recap.owed.find((one) => one.party && is(one.party))?.party?.name ?? toYou[0]?.with.find(is)?.name ?? ''
  group(`${name} owes`, yours)
  group(`${recap.selfName} owes ${name}`, toYou)
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
export function recapMailto(recap: Recap, to: 'invited' | 'here' = 'invited'): string {
  const list = to === 'here' ? recap.hereRecipients : recap.recipients
  // `@` is left readable; everything else that could end the address list is encoded.
  const addresses = list.map((r) => encodeURIComponent(r.email).replace(/%40/g, '@')).join(',')
  return `mailto:${addresses}?subject=${encodeURIComponent(recapSubject(recap))}`
}
