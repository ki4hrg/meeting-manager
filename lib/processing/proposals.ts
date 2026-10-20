/*
 * Proposals: what processing suggests, and the review that settles each one
 * (docs/SPEC.md, "Processing" and "Review").
 *
 * The rules this file holds:
 *
 *   - Nothing reaches items, documents or meetings before a proposal is
 *     accepted. Accepting goes through the same functions the rest of the app
 *     uses, so an accepted item is an ordinary item that originates in the
 *     meeting.
 *   - A payload stays in its meeting's context. It is cleaned on the way in
 *     and checked again when accepted: a stored payload is not trusted.
 *   - The fingerprint says what a proposal is about, not how it is worded, and
 *     is unique per meeting. A rejected row is kept, which is how a rejection
 *     is remembered when the note is delivered or processed again.
 *   - Accepting records what it made, so it can be taken back while nothing
 *     has happened to it since.
 */

import { createHash } from 'node:crypto'
import { and, asc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm'
import { isDay } from '../core/dates'
import { isUuid, normalise } from '../core/match'
import {
  AppError,
  NotFoundError,
  ValidationError,
  inTransaction,
  type ActorContext,
  type Executor,
} from '../core/types'
import {
  agendaLines,
  documents,
  groups,
  itemEvents,
  items,
  meetings,
  notes,
  people,
  projects,
  proposals,
  series,
  type ProposalPayload,
  type ProposalResult,
  type ProposedParty,
} from '../db/schema'
import { createDocument, discardDocument } from '../documents/documents'
import { resolveParty, resolvePerson } from '../directory/resolve'
import {
  ITEM_KINDS,
  addNote,
  answerItem,
  completeItem,
  createItem,
  dropItem,
  getItem,
  isOpen,
  listItems,
  markDiscussed,
  removeItemEvent,
  reopenItem,
  restoreItemState,
  takeBackItem,
  type ItemEventType,
  type ItemStatus,
  type ItemView,
  type PartyInput,
} from '../items/items'
import { deleteMeeting } from '../meetings/meetings'
import { prepMeeting } from '../meetings/prep'
import { createProject, deleteEmptyProject, type ProjectStatus } from '../projects/projects'

export type Proposal = typeof proposals.$inferSelect
export type ProposalStatus = Proposal['status']

type ItemPayload = Extract<ProposalPayload, { type: 'item' }>
type UpdatePayload = Extract<ProposalPayload, { type: 'update' }>
type DocumentPayload = Extract<ProposalPayload, { type: 'document' }>
type StubPayload = Extract<ProposalPayload, { type: 'stub' }>

export type ProposalDraft = {
  payload: ProposalPayload
  verbatim?: boolean
  ownerGuessed?: boolean
  agendaLineId?: string | null
}

/** A party as the review screen shows it. `unresolved` is one John must still say who it is. */
export type ProposalParty = {
  role: 'owner' | 'with'
  name: string
  type: 'person' | 'group' | null
  id: string | null
  unresolved: boolean
}

export type ProposalView = {
  id: string
  meetingId: string
  noteId: string | null
  runId: string | null
  status: ProposalStatus
  payload: ProposalPayload
  verbatim: boolean
  ownerGuessed: boolean
  position: number
  /** An item's parties, or a stub's people, with their names as they stand now. */
  parties: ProposalParty[]
  /** Names still to be settled; accepting is refused while there are any. */
  unresolved: string[]
  project: { id: string; name: string } | null
  /** For an item: the series it is to be raised at. */
  series: { id: string; name: string } | null
  /** The agenda line this came up under. */
  agendaLine: { id: string; text: string } | null
  /** For an update: the item it would change, as it stands. */
  item: ItemView | null
  /** For an item that comes out of another: that one. */
  parent: ItemView | null
  /** Once accepted: what it made. */
  made: {
    item: ItemView | null
    document: { id: string; title: string } | null
    meeting: { id: string; title: string } | null
    project: { id: string; name: string } | null
  } | null
  result: ProposalResult | null
  resolvedAt: Date | null
  createdAt: Date
}

// ─── fingerprint ─────────────────────────────────────────────────────────────

/**
 * What a proposal is about, as a stable hash: the type, the kind and the
 * normalised text; for an update, the item and the change. Rewording the
 * capitals or the punctuation gives the same fingerprint.
 */
export function fingerprintOf(payload: ProposalPayload): string {
  let about: unknown[]
  switch (payload.type) {
    case 'item':
      about = ['item', payload.kind, normalise(payload.text)]
      break
    case 'update':
      // Two different notes on one item are two proposals; two completions are one.
      about = [
        'update',
        payload.itemId,
        payload.change,
        payload.change === 'note' ? normalise(payload.text ?? '') : '',
      ]
      break
    case 'document':
      about = ['document', normalise(payload.title)]
      break
    case 'stub': {
      /* A follow-up conversation is about who it is with; its title is the
         model's wording and changes from run to run. */
      const who = payload.people.map((person) => person.personId ?? normalise(person.name)).sort()
      about = ['stub', ...(who.length > 0 ? who : [normalise(payload.title)])]
      break
    }
  }
  return createHash('sha256').update(JSON.stringify(about)).digest('hex')
}

/** Named parties of a payload that point at no row yet. */
export function unresolvedIn(payload: ProposalPayload): string[] {
  if (payload.type === 'item') {
    return payload.parties.filter((party) => !party.personId && !party.groupId).map((p) => p.name)
  }
  if (payload.type === 'stub') {
    return payload.people.filter((person) => !person.personId).map((person) => person.name)
  }
  return []
}

// ─── cleaning a payload ──────────────────────────────────────────────────────

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const blank = (value: unknown): string | null => str(value).trim() || null
const uuid = (value: unknown): string | null => (isUuid(str(value)) ? str(value) : null)
const UPDATE_CHANGES: UpdatePayload['change'][] = ['complete', 'answer', 'drop', 'note', 'discussed']

async function personName(exec: Executor, id: string): Promise<string | null> {
  const [row] = await exec.select({ name: people.name }).from(people).where(eq(people.id, id)).limit(1)
  return row?.name ?? null
}

async function groupIn(exec: Executor, id: string, contextId: string): Promise<string | null> {
  const [row] = await exec
    .select({ name: groups.name })
    .from(groups)
    .where(and(eq(groups.id, id), eq(groups.contextId, contextId)))
    .limit(1)
  return row?.name ?? null
}

async function projectIn(exec: Executor, id: string, contextId: string): Promise<boolean> {
  const [row] = await exec
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.contextId, contextId)))
    .limit(1)
  return Boolean(row)
}

async function seriesIn(exec: Executor, id: string, contextId: string): Promise<boolean> {
  const [row] = await exec
    .select({ id: series.id })
    .from(series)
    .where(and(eq(series.id, id), eq(series.contextId, contextId)))
    .limit(1)
  return Boolean(row)
}

async function itemIn(exec: Executor, id: string, contextId: string): Promise<boolean> {
  const [row] = await exec
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.id, id), eq(items.contextId, contextId)))
    .limit(1)
  return Boolean(row)
}

async function quietly<T>(lookup: Promise<T>): Promise<T | null> {
  try {
    return await lookup
  } catch (error) {
    if (error instanceof ValidationError) return null
    throw error
  }
}

async function cleanProject(
  exec: Executor,
  contextId: string,
  value: unknown,
  problems: string[],
): Promise<string | null> {
  if (value == null || value === '') return null
  const id = uuid(value)
  if (id && (await projectIn(exec, id, contextId))) return id
  problems.push('That project is not in this context.')
  return null
}

/**
 * A payload as it may be stored: rebuilt field by field, so nothing a model
 * (or a tampered form) added rides along, and bound to one context. An id that
 * does not exist, or belongs to another context, is dropped and named in
 * `problems`; a party that loses its id stays as a name to be asked for. A
 * payload that is nothing without the id (an update to an item elsewhere, text
 * that is empty) comes back null.
 *
 * `resolveNames` looks a party given by name only up in the directory, the way
 * quick-add would; a name that matches no one, or several, stays unresolved.
 */
export async function cleanPayload(
  exec: Executor,
  contextId: string,
  raw: ProposalPayload,
  opts: { resolveNames?: boolean } = {},
): Promise<{ payload: ProposalPayload | null; problems: string[] }> {
  const problems: string[] = []
  const none = (problem: string) => ({ payload: null, problems: [...problems, problem] })
  const input = raw as Record<string, unknown>

  if (input.type === 'item') {
    const text = str(input.text).trim()
    if (text === '') return none('Enter some text.')
    const kind = ITEM_KINDS.find((known) => known === input.kind)
    if (!kind) return none('That is not a kind of item.')

    const parties: ProposedParty[] = []
    const seen = new Set<string>()
    for (const given of Array.isArray(input.parties) ? (input.parties as Record<string, unknown>[]) : []) {
      if (!given || typeof given !== 'object') continue
      const role = given.role === 'owner' ? 'owner' : 'with'
      const name = str(given.name).trim()
      let party: ProposedParty | null = null

      if (given.personId != null) {
        const id = uuid(given.personId)
        const found = id ? await personName(exec, id) : null
        if (found) party = { role, name: name || found, personId: id! }
        else problems.push(`${name || 'A person'} is not in the directory.`)
      } else if (given.groupId != null) {
        const id = uuid(given.groupId)
        const found = id ? await groupIn(exec, id, contextId) : null
        if (found) party = { role, name: name || found, groupId: id! }
        else problems.push(`${name || 'That group'} is not a group in this context.`)
      } else if (opts.resolveNames && name) {
        const found = await quietly(resolveParty(exec, contextId, name))
        if (found) {
          party =
            found.type === 'person'
              ? { role, name: found.name, personId: found.id }
              : { role, name: found.name, groupId: found.id }
        }
      }

      if (!party) {
        if (name === '') continue
        party = { role, name }
      }
      const key = party.personId ?? party.groupId ?? `?${normalise(party.name)}`
      if (seen.has(key)) continue
      seen.add(key)
      parties.push(party)
    }

    let parentItemId: string | null = null
    if (input.parentItemId != null && input.parentItemId !== '') {
      const id = uuid(input.parentItemId)
      if (id && (await itemIn(exec, id, contextId))) parentItemId = id
      else problems.push('The item this follows from is not in this context.')
    }

    let dueOn: string | null = null
    if (input.dueOn != null && input.dueOn !== '') {
      if (isDay(str(input.dueOn).trim())) dueOn = str(input.dueOn).trim()
      else problems.push(`${str(input.dueOn)} is not a date (use YYYY-MM-DD).`)
    }

    let seriesId: string | null = null
    if (input.seriesId != null && input.seriesId !== '') {
      const id = uuid(input.seriesId)
      if (id && (await seriesIn(exec, id, contextId))) seriesId = id
      else problems.push('That series is not in this context.')
    }

    const payload: ItemPayload = {
      type: 'item',
      kind,
      text,
      detail: blank(input.detail),
      resolution: blank(input.resolution),
      parties,
      projectId: await cleanProject(exec, contextId, input.projectId, problems),
      dueOn,
      parentItemId,
      seriesId,
      ...(kind === 'question' && input.ongoing === true ? { ongoing: true } : {}),
    }
    return { payload, problems }
  }

  if (input.type === 'update') {
    const itemId = uuid(input.itemId)
    if (!itemId || !(await itemIn(exec, itemId, contextId))) {
      return none('That item is not in this context.')
    }
    const change = UPDATE_CHANGES.find((known) => known === input.change)
    if (!change) return none('That is not a change an item can take.')
    const text = blank(input.text)
    if (change === 'note' && !text) return none('Enter a note.')
    const payload: UpdatePayload = { type: 'update', itemId, change, text }
    return { payload, problems }
  }

  if (input.type === 'document') {
    const body = str(input.body).trim()
    if (body === '') return none('A document needs some content.')
    const payload: DocumentPayload = {
      type: 'document',
      title: str(input.title).trim() || 'Untitled',
      body,
      projectId: await cleanProject(exec, contextId, input.projectId, problems),
    }
    return { payload, problems }
  }

  if (input.type === 'stub') {
    const who: StubPayload['people'] = []
    const seen = new Set<string>()
    for (const given of Array.isArray(input.people) ? (input.people as Record<string, unknown>[]) : []) {
      if (!given || typeof given !== 'object') continue
      const name = str(given.name).trim()
      let person: StubPayload['people'][number] | null = null

      if (given.personId != null) {
        const id = uuid(given.personId)
        const found = id ? await personName(exec, id) : null
        if (found) person = { name: name || found, personId: id! }
        else problems.push(`${name || 'A person'} is not in the directory.`)
      } else if (opts.resolveNames && name) {
        const found = await quietly(resolvePerson(exec, name))
        if (found) person = { name: found.name, personId: found.id }
      }

      if (!person) {
        if (name === '') continue
        person = { name }
      }
      const key = person.personId ?? `?${normalise(person.name)}`
      if (seen.has(key)) continue
      seen.add(key)
      who.push(person)
    }

    const title = str(input.title).trim() || who.map((person) => person.name).join(', ')
    if (title === '') return none('Say who the meeting is with.')
    const payload: StubPayload = { type: 'stub', title, people: who }
    return { payload, problems }
  }

  return none('That is not something a proposal can do.')
}

// ─── reading ─────────────────────────────────────────────────────────────────

async function contextOf(exec: Executor, meetingId: string): Promise<string> {
  const [meeting] = await exec
    .select({ contextId: meetings.contextId })
    .from(meetings)
    .where(eq(meetings.id, meetingId))
    .limit(1)
  if (!meeting) throw new NotFoundError('Meeting', meetingId)
  return meeting.contextId
}

/* Every view is built here, in a handful of queries however many rows there
   are. Each lookup is bound to the meeting's context, so a payload pointing
   elsewhere shows as unresolved rather than showing another context's names. */
async function toViews(exec: Executor, rows: Proposal[]): Promise<ProposalView[]> {
  if (rows.length === 0) return []

  const meetingIds = [...new Set(rows.map((row) => row.meetingId))]
  const contexts = new Map(
    (
      await exec
        .select({ id: meetings.id, contextId: meetings.contextId })
        .from(meetings)
        .where(inArray(meetings.id, meetingIds))
    ).map((row) => [row.id, row.contextId]),
  )

  const personIds = new Set<string>()
  const groupIds = new Set<string>()
  const projectIds = new Set<string>()
  const seriesIds = new Set<string>()
  const itemIds = new Map<string, Set<string>>() // by context
  const lineIds = new Set<string>()
  const documentIds = new Set<string>()
  const madeMeetingIds = new Set<string>()

  const wantItem = (row: Proposal, id: string | null | undefined) => {
    if (!id) return
    const contextId = contexts.get(row.meetingId)!
    const set = itemIds.get(contextId) ?? new Set<string>()
    set.add(id)
    itemIds.set(contextId, set)
  }

  for (const row of rows) {
    const { payload } = row
    if (payload.type === 'item') {
      for (const party of payload.parties) {
        if (party.personId) personIds.add(party.personId)
        else if (party.groupId) groupIds.add(party.groupId)
      }
      if (payload.projectId) projectIds.add(payload.projectId)
      if (payload.seriesId) seriesIds.add(payload.seriesId)
      wantItem(row, payload.parentItemId)
      wantItem(row, row.result?.itemId)
      if (row.result?.projectId) projectIds.add(row.result.projectId)
    } else if (payload.type === 'update') {
      wantItem(row, payload.itemId)
    } else if (payload.type === 'document') {
      if (payload.projectId) projectIds.add(payload.projectId)
      if (row.result?.documentId) documentIds.add(row.result.documentId)
    } else {
      for (const person of payload.people) if (person.personId) personIds.add(person.personId)
      if (row.result?.meetingId) madeMeetingIds.add(row.result.meetingId)
    }
    if (row.agendaLineId) lineIds.add(row.agendaLineId)
  }

  const personNames = new Map(
    personIds.size === 0
      ? []
      : (
          await exec
            .select({ id: people.id, name: people.name })
            .from(people)
            .where(inArray(people.id, [...personIds]))
        ).map((row) => [row.id, row.name]),
  )
  const groupRows = new Map(
    groupIds.size === 0
      ? []
      : (
          await exec
            .select({ id: groups.id, name: groups.name, contextId: groups.contextId })
            .from(groups)
            .where(inArray(groups.id, [...groupIds]))
        ).map((row) => [row.id, row]),
  )
  const projectRows = new Map(
    projectIds.size === 0
      ? []
      : (
          await exec
            .select({ id: projects.id, name: projects.name, contextId: projects.contextId })
            .from(projects)
            .where(inArray(projects.id, [...projectIds]))
        ).map((row) => [row.id, row]),
  )

  const seriesRows = new Map(
    seriesIds.size === 0
      ? []
      : (
          await exec
            .select({ id: series.id, name: series.name, contextId: series.contextId })
            .from(series)
            .where(inArray(series.id, [...seriesIds]))
        ).map((row) => [row.id, row]),
  )

  const itemViews = new Map<string, ItemView>()
  for (const [contextId, ids] of itemIds) {
    for (const item of await listItems(exec, { contextId, ids: [...ids] })) {
      itemViews.set(item.id, item)
    }
  }

  const lines = new Map(
    lineIds.size === 0
      ? []
      : (
          await exec
            .select({
              id: agendaLines.id,
              meetingId: agendaLines.meetingId,
              text: agendaLines.text,
              itemText: items.text,
            })
            .from(agendaLines)
            .leftJoin(items, eq(items.id, agendaLines.itemId))
            .where(inArray(agendaLines.id, [...lineIds]))
        ).map((row) => [row.id, row]),
  )
  const documentRows = new Map(
    documentIds.size === 0
      ? []
      : (
          await exec
            .select({ id: documents.id, title: documents.title })
            .from(documents)
            .where(inArray(documents.id, [...documentIds]))
        ).map((row) => [row.id, row]),
  )
  const meetingRows = new Map(
    madeMeetingIds.size === 0
      ? []
      : (
          await exec
            .select({ id: meetings.id, title: meetings.title })
            .from(meetings)
            .where(inArray(meetings.id, [...madeMeetingIds]))
        ).map((row) => [row.id, row]),
  )

  return rows.map((row) => {
    const contextId = contexts.get(row.meetingId)!
    const { payload, result } = row

    const person = (role: 'owner' | 'with', name: string, id: string | undefined): ProposalParty => {
      const known = id ? personNames.get(id) : undefined
      return known
        ? { role, name: known, type: 'person', id: id!, unresolved: false }
        : { role, name, type: null, id: null, unresolved: true }
    }
    const group = (role: 'owner' | 'with', name: string, id: string): ProposalParty => {
      const known = groupRows.get(id)
      return known && known.contextId === contextId
        ? { role, name: known.name, type: 'group', id, unresolved: false }
        : { role, name, type: null, id: null, unresolved: true }
    }

    let parties: ProposalParty[] = []
    if (payload.type === 'item') {
      parties = payload.parties.map((party) =>
        party.groupId && !party.personId
          ? group(party.role, party.name, party.groupId)
          : person(party.role, party.name, party.personId),
      )
    } else if (payload.type === 'stub') {
      parties = payload.people.map((who) => person('with', who.name, who.personId))
    }

    const projectId =
      payload.type === 'item' || payload.type === 'document' ? (payload.projectId ?? null) : null
    const project = projectId ? projectRows.get(projectId) : undefined
    const raiseAt = payload.type === 'item' && payload.seriesId ? seriesRows.get(payload.seriesId) : undefined
    const line = row.agendaLineId ? lines.get(row.agendaLineId) : undefined

    return {
      id: row.id,
      meetingId: row.meetingId,
      noteId: row.noteId,
      runId: row.runId,
      status: row.status,
      payload,
      verbatim: row.verbatim,
      ownerGuessed: row.ownerGuessed,
      position: row.position,
      parties,
      unresolved: parties.filter((party) => party.unresolved).map((party) => party.name),
      project:
        project && project.contextId === contextId ? { id: project.id, name: project.name } : null,
      series:
        raiseAt && raiseAt.contextId === contextId ? { id: raiseAt.id, name: raiseAt.name } : null,
      agendaLine:
        line && line.meetingId === row.meetingId
          ? { id: line.id, text: line.text ?? line.itemText ?? '' }
          : null,
      item: payload.type === 'update' ? (itemViews.get(payload.itemId) ?? null) : null,
      parent:
        payload.type === 'item' && payload.parentItemId
          ? (itemViews.get(payload.parentItemId) ?? null)
          : null,
      made:
        row.status === 'accepted' && result
          ? {
              item:
                payload.type === 'item' && result.itemId
                  ? (itemViews.get(result.itemId) ?? null)
                  : null,
              document: result.documentId ? (documentRows.get(result.documentId) ?? null) : null,
              meeting: result.meetingId ? (meetingRows.get(result.meetingId) ?? null) : null,
              project: result.projectId ? (projectRows.get(result.projectId) ?? null) : null,
            }
          : null,
      result: result ?? null,
      resolvedAt: row.resolvedAt,
      createdAt: row.createdAt,
    }
  })
}

export async function getProposal(exec: Executor, id: string): Promise<ProposalView> {
  const rows = await exec.select().from(proposals).where(eq(proposals.id, id)).limit(1)
  if (rows.length === 0) throw new NotFoundError('Proposal', id)
  return (await toViews(exec, rows))[0]!
}

/** A meeting's proposals: pending first, then accepted, then rejected, each in the order proposed. */
export async function listProposals(exec: Executor, meetingId: string): Promise<ProposalView[]> {
  await contextOf(exec, meetingId)
  const rows = await exec
    .select()
    .from(proposals)
    .where(eq(proposals.meetingId, meetingId))
    // The enum is declared pending, accepted, rejected.
    .orderBy(asc(proposals.status), asc(proposals.position), asc(proposals.createdAt))
  return toViews(exec, rows)
}

/** The meeting whose review an item's step was accepted from. */
export type AcceptedFrom = { meetingId: string; title: string }

/**
 * Which of an item's steps came from accepting a proposal, and from which
 * meeting's review: its creation (an item proposal) and each update's event.
 */
export async function acceptedSteps(
  exec: Executor,
  itemId: string,
): Promise<{ created: AcceptedFrom | null; events: Map<string, AcceptedFrom> }> {
  const rows = await exec
    .select({
      meetingId: proposals.meetingId,
      title: meetings.title,
      type: sql<string>`${proposals.payload}->>'type'`,
      eventId: sql<string | null>`${proposals.result}->>'eventId'`,
    })
    .from(proposals)
    .innerJoin(meetings, eq(meetings.id, proposals.meetingId))
    .where(and(eq(proposals.status, 'accepted'), sql`${proposals.result}->>'itemId' = ${itemId}`))
  let created: AcceptedFrom | null = null
  const events = new Map<string, AcceptedFrom>()
  for (const row of rows) {
    const from = { meetingId: row.meetingId, title: row.title }
    if (row.type === 'item') created = from
    else if (row.eventId) events.set(row.eventId, from)
  }
  return { created, events }
}

/** Meetings of a context with pending proposals, and how many each has. */
export async function pendingByMeeting(exec: Executor, contextId: string): Promise<Map<string, number>> {
  const rows = await exec
    .select({ meetingId: proposals.meetingId, n: sql<number>`count(*)::int` })
    .from(proposals)
    .innerJoin(meetings, eq(meetings.id, proposals.meetingId))
    .where(and(eq(meetings.contextId, contextId), eq(proposals.status, 'pending')))
    .groupBy(proposals.meetingId)
  return new Map(rows.map((row) => [row.meetingId, row.n]))
}

/**
 * `pendingByMeeting` for a list of meeting cards: a meeting with sessions also
 * counts what its sessions have waiting, since the sessions are not listed.
 */
export async function pendingOnCards(exec: Executor, contextId: string): Promise<Map<string, number>> {
  const pending = await pendingByMeeting(exec, contextId)
  if (pending.size === 0) return pending
  const sessions = await exec
    .select({ id: meetings.id, parentId: meetings.parentMeetingId })
    .from(meetings)
    .where(and(inArray(meetings.id, [...pending.keys()]), isNotNull(meetings.parentMeetingId)))
  const cards = new Map(pending)
  for (const session of sessions) {
    cards.set(session.parentId!, (cards.get(session.parentId!) ?? 0) + pending.get(session.id)!)
  }
  return cards
}

// ─── adding ──────────────────────────────────────────────────────────────────

/**
 * Store what is new. Each draft is cleaned against the meeting's context
 * (names looked up, foreign ids dropped), then skipped when the meeting already
 * has a proposal with its fingerprint in any status, or when the same note has
 * one filed on another meeting of the same event. Returns how many went in.
 */
export async function addProposals(
  exec: Executor,
  where: { meetingId: string; noteId?: string; runId?: string },
  drafts: ProposalDraft[],
): Promise<number> {
  if (drafts.length === 0) return 0

  return inTransaction(exec, async (tx) => {
    const contextId = await contextOf(tx, where.meetingId)

    const known = new Set(
      (
        await tx
          .select({ fingerprint: proposals.fingerprint })
          .from(proposals)
          .where(
            where.noteId
              ? or(eq(proposals.meetingId, where.meetingId), eq(proposals.noteId, where.noteId))
              : eq(proposals.meetingId, where.meetingId),
          )
      ).map((row) => row.fingerprint),
    )
    const meetingLines = new Set(
      (
        await tx
          .select({ id: agendaLines.id })
          .from(agendaLines)
          .where(eq(agendaLines.meetingId, where.meetingId))
      ).map((row) => row.id),
    )
    const [last] = await tx
      .select({ max: sql<number | null>`max(${proposals.position})::int` })
      .from(proposals)
      .where(eq(proposals.meetingId, where.meetingId))
    let position = (last?.max ?? -1) + 1

    const values: (typeof proposals.$inferInsert)[] = []
    for (const draft of drafts) {
      const { payload } = await cleanPayload(tx, contextId, draft.payload, { resolveNames: true })
      if (!payload) continue
      const fingerprint = fingerprintOf(payload)
      if (known.has(fingerprint)) continue
      known.add(fingerprint)
      values.push({
        meetingId: where.meetingId,
        noteId: where.noteId ?? null,
        runId: where.runId ?? null,
        fingerprint,
        payload,
        verbatim: draft.verbatim ?? false,
        ownerGuessed: draft.ownerGuessed ?? false,
        agendaLineId:
          draft.agendaLineId && meetingLines.has(draft.agendaLineId) ? draft.agendaLineId : null,
        position: position++,
      })
    }
    if (values.length === 0) return 0

    const inserted = await tx
      .insert(proposals)
      .values(values)
      .onConflictDoNothing({ target: [proposals.meetingId, proposals.fingerprint] })
      .returning({ id: proposals.id })
    return inserted.length
  })
}

// ─── review ──────────────────────────────────────────────────────────────────

/* The row, locked, so two clicks cannot both accept it. */
async function lockProposal(exec: Executor, id: string): Promise<Proposal> {
  const [row] = await exec.select().from(proposals).where(eq(proposals.id, id)).for('update').limit(1)
  if (!row) throw new NotFoundError('Proposal', id)
  return row
}

/**
 * Replace a pending proposal's payload. Unlike a model's draft, John's edit is
 * refused rather than quietly trimmed when it points outside the context. A
 * name may still be left unresolved; it is asked for again on accept.
 *
 * The fingerprint is not recomputed: the row keeps standing for what the note
 * said, so an edited proposal still stops the original being proposed again. A
 * verbatim proposal stays verbatim (its wording is not the model's to change;
 * it is still John's). An edit settles a guessed owner.
 */
export async function editProposal(
  exec: Executor,
  _actor: ActorContext,
  id: string,
  payload: ProposalPayload,
): Promise<ProposalView> {
  return inTransaction(exec, async (tx) => {
    const row = await lockProposal(tx, id)
    if (row.status !== 'pending') {
      throw new ValidationError(`This proposal has been ${row.status}. Undo that before editing it.`)
    }
    if (payload.type !== row.payload.type) {
      throw new ValidationError('A proposal cannot become a different kind of thing. Reject it instead.')
    }

    const contextId = await contextOf(tx, row.meetingId)
    const cleaned = await cleanPayload(tx, contextId, payload)
    if (!cleaned.payload || cleaned.problems.length > 0) {
      throw new ValidationError(cleaned.problems[0] ?? 'That cannot be saved.')
    }

    await tx
      .update(proposals)
      .set({ payload: cleaned.payload, ownerGuessed: false, updatedAt: new Date() })
      .where(eq(proposals.id, id))
    return getProposal(tx, id)
  })
}

/**
 * Edit a pending proposal and accept it in one step: Accept from its edit
 * form, or from the short form asking what it leaves unsaid. If accepting is
 * refused, the edit is not kept either.
 */
export async function acceptEdited(
  exec: Executor,
  actor: ActorContext,
  id: string,
  payload: ProposalPayload,
): Promise<ProposalView> {
  return inTransaction(exec, async (tx) => {
    await editProposal(tx, actor, id, payload)
    return acceptProposal(tx, actor, id)
  })
}

/**
 * Accept an item proposal as a project of its own, as edited: named, within a
 * project, and with a status (proposed unless said otherwise), its detail as
 * the description. With `keepTopic`, a topic is made on the new project too,
 * from the proposal's text and people, as the next thing to raise about it.
 * The proposal is kept as the item it was, so Undo puts it back to review.
 */
export async function acceptAsProject(
  exec: Executor,
  actor: ActorContext,
  id: string,
  payload: ItemPayload,
  project: { name: string; parentId?: string | null; status?: ProjectStatus; keepTopic?: boolean },
): Promise<ProposalView> {
  return inTransaction(exec, async (tx) => {
    // Kept as a topic: what it was raised as, and what a kept topic becomes.
    const kept: ItemPayload = { ...payload, kind: 'topic', resolution: null, ongoing: false }
    await editProposal(tx, actor, id, kept)
    const row = await lockProposal(tx, id)
    if (row.status !== 'pending') throw new ValidationError('This proposal has already been handled.')
    const meeting = { id: row.meetingId, contextId: await contextOf(tx, row.meetingId) }

    const made = await createProject(tx, {
      contextId: meeting.contextId,
      name: project.name.trim() || kept.text,
      description: kept.detail ?? null,
      parentId: project.parentId || null,
      status: project.status ?? 'proposed',
    })
    const result: ProposalResult = project.keepTopic
      ? { ...(await acceptItem(tx, actor, meeting, { ...kept, projectId: made.id })), projectId: made.id }
      : { projectId: made.id }

    await tx
      .update(proposals)
      .set({ status: 'accepted', ownerGuessed: false, result, resolvedAt: new Date(), updatedAt: new Date() })
      .where(eq(proposals.id, id))
    return getProposal(tx, id)
  })
}

/* The history accepting an item proposal writes on the item it makes. Undo
   compares against it to tell whether anything has happened since. */
function madeEvents(payload: ItemPayload): ItemEventType[] {
  if (!payload.resolution || payload.kind === 'decision') return ['created']
  return ['created', payload.kind === 'question' ? 'answered' : 'completed']
}

async function acceptItem(
  exec: Executor,
  actor: ActorContext,
  meeting: { id: string; contextId: string },
  payload: ItemPayload,
): Promise<ProposalResult> {
  const missing = payload.parties.find((party) => !party.personId && !party.groupId)
  if (missing) throw new ValidationError(`Say who ${missing.name} is before accepting this.`)

  const parties: PartyInput[] = []
  for (const party of payload.parties) {
    const entry: PartyInput = party.personId
      ? { personId: party.personId, role: party.role }
      : { groupId: party.groupId!, role: party.role }
    const id = entry.personId ?? entry.groupId
    if (!parties.some((existing) => (existing.personId ?? existing.groupId) === id)) {
      parties.push(entry)
    }
  }

  const resolution = payload.resolution?.trim() || null
  /* createItem refuses a project, a group or a parent from another context,
     which is the check that matters: the stored payload is not trusted. */
  const item = await createItem(exec, actor, {
    contextId: meeting.contextId,
    kind: payload.kind,
    text: payload.text,
    // A decision has no resolution of its own; what was said about it is its detail.
    detail: payload.detail ?? (payload.kind === 'decision' ? resolution : null),
    projectId: payload.projectId ?? null,
    dueOn: payload.dueOn ?? null,
    parties,
    parentItemId: payload.parentItemId ?? null,
    ongoing: payload.ongoing === true,
    originMeetingId: meeting.id,
    ...(payload.seriesId ? { target: { seriesId: payload.seriesId } } : {}),
  })

  if (resolution && payload.kind === 'question') {
    await answerItem(exec, actor, item.id, { answer: resolution, meetingId: meeting.id })
  } else if (resolution && payload.kind !== 'decision') {
    await completeItem(exec, actor, item.id, { resolution })
  }
  return { itemId: item.id }
}

async function eventIds(exec: Executor, itemId: string): Promise<string[]> {
  const rows = await exec
    .select({ id: itemEvents.id })
    .from(itemEvents)
    .where(eq(itemEvents.itemId, itemId))
  return rows.map((row) => row.id)
}

async function acceptUpdate(
  exec: Executor,
  actor: ActorContext,
  meeting: { id: string; contextId: string },
  payload: UpdatePayload,
): Promise<ProposalResult> {
  const item = await getItem(exec, payload.itemId)
  if (item.contextId !== meeting.contextId) {
    throw new ValidationError('That item belongs to another context.')
  }

  const before = {
    status: item.status,
    resolution: item.resolution,
    closedAt: item.closedAt?.toISOString() ?? null,
  }
  const had = new Set(await eventIds(exec, item.id))
  const text = payload.text?.trim() || null

  switch (payload.change) {
    case 'complete':
    case 'answer':
      /* What closes an item follows from its kind, not from the word the model
         chose: a question takes an answer, anything else is done. */
      if (item.kind === 'question') {
        await answerItem(exec, actor, item.id, { answer: text ?? '', meetingId: meeting.id })
      }
      else await completeItem(exec, actor, item.id, { resolution: text })
      break
    case 'drop':
      await dropItem(exec, actor, item.id)
      break
    case 'note':
      await addNote(exec, actor, item.id, text ?? '')
      break
    case 'discussed':
      await markDiscussed(exec, actor, item.id, meeting.id)
      break
  }

  const eventId = (await eventIds(exec, item.id)).find((id) => !had.has(id))
  return { itemId: item.id, before, eventId }
}

async function acceptStub(
  exec: Executor,
  actor: ActorContext,
  meeting: { id: string; contextId: string },
  payload: StubPayload,
): Promise<ProposalResult> {
  const missing = payload.people.find((person) => !person.personId)
  if (missing) throw new ValidationError(`Say who ${missing.name} is before accepting this.`)

  /* Always a stub of its own, never the one "Prep a meeting with…" keeps for a
     person: undoing must be able to delete exactly what accepting made. Prep
     places what places itself and nothing more. */
  const stub = await prepMeeting(exec, actor, {
    contextId: meeting.contextId,
    title: payload.title,
    personIds: payload.people.map((person) => person.personId!),
  })
  return { meetingId: stub.id }
}

/**
 * Accept a pending proposal: make the item, apply the update, save the
 * document or create the stub, and record what was made. Refused while a party
 * is still only a name, and refused by the functions underneath when anything
 * in the payload belongs to another context.
 */
export async function acceptProposal(
  exec: Executor,
  actor: ActorContext,
  id: string,
): Promise<ProposalView> {
  return inTransaction(exec, async (tx) => {
    const row = await lockProposal(tx, id)
    if (row.status === 'accepted') return getProposal(tx, id)
    if (row.status === 'rejected') {
      throw new ValidationError('This proposal was rejected. Put it back before accepting it.')
    }

    const meeting = { id: row.meetingId, contextId: await contextOf(tx, row.meetingId) }
    const { payload } = row

    let result: ProposalResult
    if (payload.type === 'item') result = await acceptItem(tx, actor, meeting, payload)
    else if (payload.type === 'update') result = await acceptUpdate(tx, actor, meeting, payload)
    else if (payload.type === 'document') {
      const document = await createDocument(tx, actor, {
        contextId: meeting.contextId,
        projectId: payload.projectId ?? null,
        meetingId: meeting.id,
        title: payload.title,
        body: payload.body,
      })
      result = { documentId: document.id }
    } else result = await acceptStub(tx, actor, meeting, payload)

    await tx
      .update(proposals)
      // Accepting it confirms whatever was guessed: undone, it does not come back as a guess.
      .set({ status: 'accepted', ownerGuessed: false, result, resolvedAt: new Date(), updatedAt: new Date() })
      .where(eq(proposals.id, id))
    return getProposal(tx, id)
  })
}

/** Turn a pending proposal away. The row stays, so the same thing is not proposed again. */
export async function rejectProposal(
  exec: Executor,
  _actor: ActorContext,
  id: string,
): Promise<ProposalView> {
  return inTransaction(exec, async (tx) => {
    const row = await lockProposal(tx, id)
    if (row.status === 'rejected') return getProposal(tx, id)
    if (row.status === 'accepted') {
      throw new ValidationError('This proposal was accepted. Undo it before rejecting it.')
    }
    await tx
      .update(proposals)
      .set({ status: 'rejected', resolvedAt: new Date(), updatedAt: new Date() })
      .where(eq(proposals.id, id))
    return getProposal(tx, id)
  })
}

async function undoUpdate(
  exec: Executor,
  actor: ActorContext,
  payload: UpdatePayload,
  result: ProposalResult,
) {
  const itemId = result.itemId ?? payload.itemId
  const [item] = await exec.select().from(items).where(eq(items.id, itemId)).limit(1)
  if (!item) return

  if (payload.change === 'note' || payload.change === 'discussed') {
    // Each is only an entry in the item's history.
    if (result.eventId) await removeItemEvent(exec, itemId, result.eventId)
    return
  }

  // Already reopened by hand: there is nothing left to take back.
  if (isOpen(item)) return

  if (result.eventId) {
    const [later] = await exec
      .select({ id: itemEvents.id })
      .from(itemEvents)
      .where(
        and(
          eq(itemEvents.itemId, itemId),
          sql`${itemEvents.createdAt} > (select created_at from item_events where id = ${result.eventId})`,
        ),
      )
      .limit(1)
    if (later) {
      throw new ValidationError(
        'This item has changed since it was accepted. Reopen it from its own page instead.',
      )
    }
  }

  await reopenItem(exec, actor, itemId)
  const before = result.before
  if (before && (before.status !== 'open' || before.resolution !== null)) {
    await restoreItemState(exec, itemId, {
      status: before.status as ItemStatus,
      resolution: before.resolution,
      closedAt: before.closedAt ? new Date(before.closedAt) : null,
    })
  }
}

async function undoDocument(exec: Executor, actor: ActorContext, documentId: string) {
  const [document] = await exec.select().from(documents).where(eq(documents.id, documentId)).limit(1)
  if (!document) return
  if (document.updatedAt.getTime() !== document.createdAt.getTime()) {
    throw new ValidationError(
      'This document has been edited since it was accepted. Delete it from its project instead.',
    )
  }
  await discardDocument(exec, documentId)
}

/* A stub is untouched while it is still undated and holds nothing but what
   prep placed on it by itself. */
async function undoStub(exec: Executor, actor: ActorContext, meetingId: string) {
  const [stub] = await exec.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1)
  if (!stub) return

  const edited =
    stub.startsAt !== null ||
    stub.calendarEventId !== null ||
    stub.updatedAt.getTime() !== stub.createdAt.getTime()
  const [written] = await exec
    .select({ id: agendaLines.id })
    .from(agendaLines)
    .where(
      and(
        eq(agendaLines.meetingId, meetingId),
        sql`(${agendaLines.itemId} is null or ${agendaLines.text} is not null
          or ${agendaLines.privateNote} is not null or ${agendaLines.minutes} is not null)`,
      ),
    )
    .limit(1)
  const [noted] = await exec.select({ id: notes.id }).from(notes).where(eq(notes.meetingId, meetingId)).limit(1)
  const [session] = await exec
    .select({ id: meetings.id })
    .from(meetings)
    .where(eq(meetings.parentMeetingId, meetingId))
    .limit(1)
  const [aimed] = await exec
    .select({ id: items.id })
    .from(items)
    .where(or(eq(items.targetMeetingId, meetingId), eq(items.originMeetingId, meetingId)))
    .limit(1)

  if (edited || written || noted || session || aimed) {
    throw new ValidationError(
      'This meeting has been worked on since it was accepted. Delete it from its own page instead.',
    )
  }
  await deleteMeeting(exec, actor, meetingId)
}

/**
 * Back to pending. A rejection is simply lifted. An acceptance is taken back:
 * the item it made is removed, the update it applied is reverted, the document
 * or stub it created is deleted, each only while nothing has happened to it
 * since; otherwise the undo is refused and says why.
 */
export async function undoProposal(
  exec: Executor,
  actor: ActorContext,
  id: string,
): Promise<ProposalView> {
  return inTransaction(exec, async (tx) => {
    const row = await lockProposal(tx, id)
    if (row.status === 'pending') return getProposal(tx, id)

    if (row.status === 'accepted') {
      const { payload } = row
      const result = row.result ?? {}
      if (payload.type === 'item' && (result.itemId || result.projectId)) {
        if (result.itemId) await takeBackItem(tx, result.itemId, madeEvents(payload))
        if (result.projectId) await deleteEmptyProject(tx, result.projectId)
      } else if (payload.type === 'update') {
        await undoUpdate(tx, actor, payload, result)
      } else if (payload.type === 'document' && result.documentId) {
        await undoDocument(tx, actor, result.documentId)
      } else if (payload.type === 'stub' && result.meetingId) {
        await undoStub(tx, actor, result.meetingId)
      }
    }

    await tx
      .update(proposals)
      .set({ status: 'pending', result: null, resolvedAt: null, updatedAt: new Date() })
      .where(eq(proposals.id, id))
    return getProposal(tx, id)
  })
}

/**
 * Accept every pending proposal that needs no thought: no guessed owner, no
 * party still to be named. Each is its own transaction, so one refusal (an
 * item that was closed in the meantime, say) leaves the rest accepted. `left`
 * is how many are still pending afterwards; `refused` says why for those that
 * were tried.
 */
export async function approveAll(
  exec: Executor,
  actor: ActorContext,
  meetingId: string,
): Promise<{ accepted: number; left: number; refused: { id: string; message: string }[] }> {
  await contextOf(exec, meetingId)
  const pending = await exec
    .select()
    .from(proposals)
    .where(and(eq(proposals.meetingId, meetingId), eq(proposals.status, 'pending')))
    .orderBy(asc(proposals.position), asc(proposals.createdAt))

  let accepted = 0
  const refused: { id: string; message: string }[] = []
  for (const row of pending) {
    if (row.ownerGuessed || unresolvedIn(row.payload).length > 0) continue
    try {
      const view = await acceptProposal(exec, actor, row.id)
      if (view.status === 'accepted') accepted++
    } catch (error) {
      if (!(error instanceof AppError)) throw error
      refused.push({ id: row.id, message: error.message })
    }
  }

  const [left] = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(proposals)
    .where(and(eq(proposals.meetingId, meetingId), eq(proposals.status, 'pending')))
  return { accepted, left: left?.n ?? 0, refused }
}
