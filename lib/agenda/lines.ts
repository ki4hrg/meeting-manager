/*
 * Agenda lines and sections in the database.
 *
 * An agenda is a two-level structure: top-level rows and rows that sit under
 * a section. A line is free text or a reference to a live item. An item can
 * be on an agenda only once. Removing a line that references an item records
 * a dismissal so automatic placement does not put it straight back.
 *
 * `position` orders siblings: the top-level rows together, a section's lines
 * together. Every write that changes an order renumbers the list it touched
 * from zero, so positions never collide or leave gaps.
 */

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  NotFoundError,
  ValidationError,
  inTransaction,
  type ActorContext,
  type Executor,
} from '../core/types'
import { agendaLines, itemEvents, items, meetingDismissals, meetings, people } from '../db/schema'
import { listItems, type ItemView } from '../items/items'
import { parseOutline } from './outline'
import { parseClock, scheduleAgenda } from './schedule'

export type AgendaLine = {
  id: string
  text: string // what to show: the override text, else the item's text
  ownText: string | null // the override as stored (null on an item line with no override)
  item: ItemView | null // the live item, when the line references one
  description: string | null // public: goes out with the agenda
  leader: { id: string; name: string; isSelf: boolean } | null
  privateNote: string | null
  minutes: number | null
  pinnedStart: string | null // 'HH:MM'
  start: string | null // computed 'HH:MM' in the user's zone; null when the agenda is untimed
  /** Set on a pinned row that what precedes it runs past, by this many minutes. */
  overrunMinutes?: number
  /** In a timeboxed section, a line with no minutes of its own: its share of what is left. */
  shareMinutes?: number
  /** The item was marked discussed in this meeting. */
  discussed?: boolean
}

export type AgendaSection = {
  id: string
  title: string
  pinnedStart: string | null
  start: string | null
  minutes: number | null /* its own (a timebox), else the sum of its lines' */
  /** The minutes stored on the section: its timebox, or null for none. */
  ownMinutes: number | null
  /** In a timebox, the minutes its lines set themselves. */
  usedMinutes?: number
  /** In a timebox, by how much its lines' minutes exceed it. */
  overBudgetMinutes?: number
  overrunMinutes?: number
  lines: AgendaLine[]
}

export type AgendaNode = ({ type: 'section' } & AgendaSection) | ({ type: 'line' } & AgendaLine)

export type Agenda = {
  meetingId: string
  nodes: AgendaNode[] // top level, in order: sections and loose lines
  totalMinutes: number
  end: string | null // computed end 'HH:MM'
  overflowMinutes: number // > 0 when the timed agenda runs past the meeting's endsAt or a pinned start
}

type Row = typeof agendaLines.$inferSelect

// ─── reading ─────────────────────────────────────────────────────────────────

/**
 * The agenda of a meeting, with live item text and computed start times.
 * Times are on the clock of `timeZone`; null means the instance's own.
 */
export async function getAgenda(
  exec: Executor,
  meetingId: string,
  opts?: { timeZone?: string | null },
): Promise<Agenda> {
  const [meeting] = await exec.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1)
  if (!meeting) throw new NotFoundError('Meeting', meetingId)

  const rows = await exec
    .select()
    .from(agendaLines)
    .where(eq(agendaLines.meetingId, meetingId))
    .orderBy(asc(agendaLines.position), asc(agendaLines.createdAt))

  // One query for every referenced item, bound to the meeting's context.
  const itemIds = [...new Set(rows.flatMap((row) => (row.itemId ? [row.itemId] : [])))]
  const live = new Map(
    (await listItems(exec, { contextId: meeting.contextId, ids: itemIds })).map((item) => [
      item.id,
      item,
    ]),
  )

  const leaderIds = [...new Set(rows.flatMap((row) => (row.leaderPersonId ? [row.leaderPersonId] : [])))]
  const leaders = new Map(
    (leaderIds.length === 0
      ? []
      : await exec
          .select({ id: people.id, name: people.name, isSelf: people.isSelf })
          .from(people)
          .where(inArray(people.id, leaderIds))
    ).map((person) => [person.id, person]),
  )

  const discussed = new Set(
    itemIds.length === 0
      ? []
      : (
          await exec
            .select({ itemId: itemEvents.itemId })
            .from(itemEvents)
            .where(
              and(
                inArray(itemEvents.itemId, itemIds),
                eq(itemEvents.type, 'discussed'),
                sql`${itemEvents.data}->>'meetingId' = ${meetingId}`,
              ),
            )
        ).map((row) => row.itemId),
  )

  const lineOf = (row: Row): AgendaLine => {
    const item = row.itemId ? (live.get(row.itemId) ?? null) : null
    return {
      ...(item && discussed.has(item.id) ? { discussed: true } : {}),
      id: row.id,
      text: row.text ?? item?.text ?? '',
      ownText: row.text,
      item,
      description: row.description,
      leader: row.leaderPersonId ? (leaders.get(row.leaderPersonId) ?? null) : null,
      privateNote: row.privateNote,
      minutes: row.minutes,
      pinnedStart: row.pinnedStart,
      start: null,
    }
  }

  const sections = new Map<string, { type: 'section' } & AgendaSection>()
  const nodes: AgendaNode[] = []
  for (const row of rows) {
    if (row.sectionId) continue
    if (row.isSection) {
      const section = {
        type: 'section' as const,
        id: row.id,
        title: row.text ?? '',
        pinnedStart: row.pinnedStart,
        start: null,
        minutes: row.minutes,
        ownMinutes: row.minutes,
        lines: [],
      }
      sections.set(row.id, section)
      nodes.push(section)
    } else {
      nodes.push({ type: 'line', ...lineOf(row) })
    }
  }
  for (const row of rows) {
    if (row.sectionId) sections.get(row.sectionId)?.lines.push(lineOf(row))
  }

  const schedule = scheduleAgenda(nodes, {
    startsAt: meeting.startsAt,
    endsAt: meeting.endsAt,
    timeZone: opts?.timeZone ?? null,
  })

  return { meetingId, nodes, ...schedule }
}

// ─── ordering ────────────────────────────────────────────────────────────────

const within = (meetingId: string, sectionId: string | null) =>
  and(
    eq(agendaLines.meetingId, meetingId),
    sectionId ? eq(agendaLines.sectionId, sectionId) : isNull(agendaLines.sectionId),
  )

async function siblings(exec: Executor, meetingId: string, sectionId: string | null): Promise<Row[]> {
  return exec
    .select()
    .from(agendaLines)
    .where(within(meetingId, sectionId))
    .orderBy(asc(agendaLines.position), asc(agendaLines.createdAt))
}

/* Write a list back in the order given, numbered from zero. */
async function renumber(exec: Executor, ids: string[], sectionId: string | null) {
  for (const [position, id] of ids.entries()) {
    await exec
      .update(agendaLines)
      .set({ position, sectionId, updatedAt: new Date() })
      .where(eq(agendaLines.id, id))
  }
}

async function nextPosition(exec: Executor, meetingId: string, sectionId: string | null) {
  const [last] = await exec
    .select({ max: sql<number | null>`max(${agendaLines.position})::int` })
    .from(agendaLines)
    .where(within(meetingId, sectionId))
  return (last?.max ?? -1) + 1
}

/* Insert a row at the end of its list, or at `position`, shifting what follows. */
async function insertRow(
  exec: Executor,
  values: typeof agendaLines.$inferInsert,
  position: number | undefined,
): Promise<string> {
  const sectionId = values.sectionId ?? null
  const [row] = await exec
    .insert(agendaLines)
    .values({ ...values, position: await nextPosition(exec, values.meetingId, sectionId) })
    .returning({ id: agendaLines.id })

  if (position !== undefined) {
    const others = (await siblings(exec, values.meetingId, sectionId))
      .map((sibling) => sibling.id)
      .filter((id) => id !== row!.id)
    others.splice(Math.max(0, Math.min(position, others.length)), 0, row!.id)
    await renumber(exec, others, sectionId)
  }
  return row!.id
}

async function loadMeeting(exec: Executor, meetingId: string) {
  const [meeting] = await exec
    .select({ id: meetings.id, contextId: meetings.contextId })
    .from(meetings)
    .where(eq(meetings.id, meetingId))
    .limit(1)
  if (!meeting) throw new NotFoundError('Meeting', meetingId)
  return meeting
}

async function loadRow(exec: Executor, lineId: string): Promise<Row> {
  const [row] = await exec.select().from(agendaLines).where(eq(agendaLines.id, lineId)).limit(1)
  if (!row) throw new NotFoundError('Line', lineId)
  return row
}

/* A section a line may be put in: a section row of the same meeting. */
async function assertSectionOf(exec: Executor, sectionId: string, meetingId: string) {
  const section = await loadRow(exec, sectionId)
  if (!section.isSection || section.meetingId !== meetingId) {
    throw new ValidationError('That section is not on this agenda.')
  }
}

/* A leader is anyone in the directory: people are global, so no context check. */
async function assertPerson(exec: Executor, personId: string) {
  const [person] = await exec.select({ id: people.id }).from(people).where(eq(people.id, personId)).limit(1)
  if (!person) throw new NotFoundError('Person', personId)
}

// ─── writing ─────────────────────────────────────────────────────────────────

/** Add a section. Returns its id. */
export async function addSection(
  exec: Executor,
  _actor: ActorContext,
  meetingId: string,
  input: { title: string; position?: number },
): Promise<string> {
  const title = input.title.trim()
  if (title === '') throw new ValidationError('Enter a title.')

  return inTransaction(exec, async (tx) => {
    await loadMeeting(tx, meetingId)
    return insertRow(tx, { meetingId, isSection: true, text: title }, input.position)
  })
}

/**
 * Add a line: free text, or a reference to an item in the meeting's context.
 * An item goes on an agenda once; placing it takes back a "not this time".
 */
export async function addLine(
  exec: Executor,
  _actor: ActorContext,
  meetingId: string,
  input: {
    text?: string | null
    itemId?: string
    sectionId?: string | null
    description?: string | null
    leaderPersonId?: string | null
    privateNote?: string | null
    minutes?: number | null
    position?: number
  },
): Promise<string> {
  const text = (input.text ?? '').trim() || null
  const { itemId } = input
  const sectionId = input.sectionId ?? null
  if (!text && !itemId) throw new ValidationError('A line needs text or an item reference.')
  if (input.minutes != null && input.minutes < 0) {
    throw new ValidationError('Minutes must be non-negative.')
  }

  return inTransaction(exec, async (tx) => {
    const meeting = await loadMeeting(tx, meetingId)
    if (sectionId) await assertSectionOf(tx, sectionId, meetingId)
    if (input.leaderPersonId) await assertPerson(tx, input.leaderPersonId)

    if (itemId) {
      const [item] = await tx
        .select({ contextId: items.contextId })
        .from(items)
        .where(eq(items.id, itemId))
        .limit(1)
      if (!item) throw new NotFoundError('Item', itemId)
      if (item.contextId !== meeting.contextId) {
        throw new ValidationError('This item is from a different context.')
      }

      const [existing] = await tx
        .select({ id: agendaLines.id })
        .from(agendaLines)
        .where(and(eq(agendaLines.meetingId, meetingId), eq(agendaLines.itemId, itemId)))
        .limit(1)
      if (existing) throw new ValidationError('This item is already on this agenda.')

      await tx
        .delete(meetingDismissals)
        .where(and(eq(meetingDismissals.meetingId, meetingId), eq(meetingDismissals.itemId, itemId)))
    }

    return insertRow(
      tx,
      {
        meetingId,
        sectionId,
        text,
        itemId: itemId ?? null,
        description: input.description?.trim() || null,
        leaderPersonId: input.leaderPersonId || null,
        privateNote: input.privateNote?.trim() || null,
        minutes: input.minutes ?? null,
      },
      input.position,
    )
  })
}

/**
 * Change a line's or a section's own fields. On an item line the text is an
 * override: empty, or the same as the item's, and the line follows the item
 * again.
 */
export async function updateLine(
  exec: Executor,
  _actor: ActorContext,
  lineId: string,
  input: {
    text?: string | null
    description?: string | null
    leaderPersonId?: string | null
    privateNote?: string | null
    minutes?: number | null
    pinnedStart?: string | null
  },
): Promise<void> {
  await inTransaction(exec, async (tx) => {
    const row = await loadRow(tx, lineId)
    const patch: Partial<typeof agendaLines.$inferInsert> = {}

    if (input.text !== undefined) {
      let text = (input.text ?? '').trim() || null
      if (row.itemId && text) {
        const [item] = await tx
          .select({ text: items.text })
          .from(items)
          .where(eq(items.id, row.itemId))
          .limit(1)
        if (item?.text === text) text = null
      }
      if (!text && !row.itemId) throw new ValidationError('Enter some text.')
      patch.text = text
    }
    const lineOnly = input.description != null || input.leaderPersonId != null
    if (row.isSection && lineOnly) {
      throw new ValidationError('A section has a title, minutes and a pinned start, nothing else.')
    }
    if (input.description !== undefined) patch.description = input.description?.trim() || null
    if (input.leaderPersonId !== undefined) {
      if (input.leaderPersonId) await assertPerson(tx, input.leaderPersonId)
      patch.leaderPersonId = input.leaderPersonId || null
    }
    if (input.privateNote !== undefined) patch.privateNote = input.privateNote?.trim() || null
    if (input.minutes !== undefined) {
      if (input.minutes !== null && (!Number.isInteger(input.minutes) || input.minutes < 0)) {
        throw new ValidationError('Minutes must be non-negative.')
      }
      patch.minutes = input.minutes
    }
    if (input.pinnedStart !== undefined) {
      if (input.pinnedStart !== null) {
        if (!/^\d{2}:\d{2}$/.test(input.pinnedStart) || parseClock(input.pinnedStart) === null) {
          throw new ValidationError('Pinned start must be HH:MM format.')
        }
      }
      patch.pinnedStart = input.pinnedStart
    }

    if (Object.keys(patch).length === 0) return
    await tx
      .update(agendaLines)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(agendaLines.id, lineId))
  })
}

/**
 * Put a row at `position` among the top-level rows (`sectionId` null) or the
 * lines of a section. A section stays at the top level.
 */
export async function moveLine(
  exec: Executor,
  _actor: ActorContext,
  lineId: string,
  input: { sectionId: string | null; position: number },
): Promise<void> {
  await inTransaction(exec, async (tx) => {
    const row = await loadRow(tx, lineId)
    if (row.isSection && input.sectionId !== null) {
      throw new ValidationError('Sections can only be moved to the top level.')
    }
    if (input.sectionId) await assertSectionOf(tx, input.sectionId, row.meetingId)

    const target = (await siblings(tx, row.meetingId, input.sectionId))
      .map((sibling) => sibling.id)
      .filter((id) => id !== lineId)
    target.splice(Math.max(0, Math.min(input.position, target.length)), 0, lineId)
    await renumber(tx, target, input.sectionId)

    if (row.sectionId !== input.sectionId) {
      const left = (await siblings(tx, row.meetingId, row.sectionId)).map((sibling) => sibling.id)
      await renumber(tx, left, row.sectionId)
    }
  })
}

/**
 * One step up or down the agenda as it reads on the page. A line steps over
 * its neighbour; at the edge of a section it steps out of it, and a loose line
 * next to a section steps into it. A section steps over its neighbour whole.
 */
export async function nudgeLine(
  exec: Executor,
  actor: ActorContext,
  lineId: string,
  direction: 'up' | 'down',
): Promise<void> {
  await inTransaction(exec, async (tx) => {
    const row = await loadRow(tx, lineId)
    const up = direction === 'up'
    const top = await siblings(tx, row.meetingId, null)

    if (row.sectionId) {
      const inside = await siblings(tx, row.meetingId, row.sectionId)
      const index = inside.findIndex((sibling) => sibling.id === lineId)
      const atEdge = up ? index === 0 : index === inside.length - 1
      if (!atEdge) {
        await moveLine(tx, actor, lineId, { sectionId: row.sectionId, position: index + (up ? -1 : 1) })
        return
      }
      // Out of the section: just above it, or just below.
      const sectionIndex = top.findIndex((sibling) => sibling.id === row.sectionId)
      await moveLine(tx, actor, lineId, { sectionId: null, position: sectionIndex + (up ? 0 : 1) })
      return
    }

    const index = top.findIndex((sibling) => sibling.id === lineId)
    const neighbour = top[index + (up ? -1 : 1)]
    if (!neighbour) return

    if (neighbour.isSection && !row.isSection) {
      // Into the section: at its end coming from below, at its start from above.
      const inside = await siblings(tx, row.meetingId, neighbour.id)
      await moveLine(tx, actor, lineId, { sectionId: neighbour.id, position: up ? inside.length : 0 })
      return
    }
    await moveLine(tx, actor, lineId, { sectionId: null, position: index + (up ? -1 : 1) })
  })
}

/**
 * Take a row off the agenda. An item line leaves a dismissal behind, so the
 * automatic placement does not put it straight back; removing a section does
 * the same for every item line in it.
 */
export async function removeLine(exec: Executor, _actor: ActorContext, lineId: string): Promise<void> {
  await inTransaction(exec, async (tx) => {
    const row = await loadRow(tx, lineId)
    const gone = row.isSection
      ? await tx.select().from(agendaLines).where(eq(agendaLines.sectionId, lineId))
      : [row]

    const itemIds = gone.flatMap((line) => (line.itemId ? [line.itemId] : []))
    if (itemIds.length > 0) {
      await tx
        .insert(meetingDismissals)
        .values(itemIds.map((itemId) => ({ meetingId: row.meetingId, itemId })))
        .onConflictDoNothing()
    }

    // A section's lines go with it (the foreign key cascades).
    await tx.delete(agendaLines).where(eq(agendaLines.id, lineId))
    const left = (await siblings(tx, row.meetingId, row.sectionId)).map((sibling) => sibling.id)
    await renumber(tx, left, row.sectionId)
  })
}

type OutlineSection = {
  title: string
  minutes?: number | null
  lines: Array<{ text: string; minutes?: number | null; privateNote?: string | null }>
}

async function appendSections(exec: Executor, meetingId: string, sections: OutlineSection[]) {
  let position = await nextPosition(exec, meetingId, null)
  for (const section of sections) {
    const [row] = await exec
      .insert(agendaLines)
      .values({
        meetingId,
        isSection: true,
        position: position++,
        text: section.title.trim(),
        minutes: section.minutes ?? null,
      })
      .returning({ id: agendaLines.id })

    if (section.lines.length > 0) {
      await exec.insert(agendaLines).values(
        section.lines.map((line, index) => ({
          meetingId,
          sectionId: row!.id,
          position: index,
          text: line.text.trim(),
          minutes: line.minutes ?? null,
          privateNote: line.privateNote ?? null,
        })),
      )
    }
  }
}

/** Lay a series' standing agenda down at the end of a meeting's agenda. */
export async function applySkeleton(
  exec: Executor,
  _actor: ActorContext,
  meetingId: string,
  skeleton: Array<{ title: string; lines: Array<{ text: string; minutes?: number | null }> }>,
): Promise<void> {
  await inTransaction(exec, (tx) => appendSections(tx, meetingId, skeleton))
}

/**
 * An agenda pasted as text (see outline.ts). Top-level entries become sections
 * and what is under them lines; a flat list with nothing nested becomes loose
 * lines. Whatever was written under a line is kept as its private note.
 *
 * With `replace`, the free-text rows already there are cleared first. Item
 * lines are kept, loose at the top: they are live items, not text to retype.
 */
export async function importOutline(
  exec: Executor,
  _actor: ActorContext,
  meetingId: string,
  text: string,
  opts?: { replace?: boolean },
): Promise<{ sections: number; lines: number }> {
  const outline = parseOutline(text)
  if (outline.length === 0) throw new ValidationError('Paste an outline: headings or a bulleted list.')

  return inTransaction(exec, async (tx) => {
    await loadMeeting(tx, meetingId)

    if (opts?.replace) {
      /* Item lines come out of their sections before the sections go, or the
         cascade would take them along. They keep the order they read in:
         down the top level, into each section where it stands. */
      const kept: string[] = []
      for (const row of await siblings(tx, meetingId, null)) {
        if (row.itemId) kept.push(row.id)
        if (!row.isSection) continue
        for (const line of await siblings(tx, meetingId, row.id)) {
          if (line.itemId) kept.push(line.id)
        }
      }
      await renumber(tx, kept, null)
      await tx
        .delete(agendaLines)
        .where(and(eq(agendaLines.meetingId, meetingId), isNull(agendaLines.itemId)))
    }

    if (outline.every((entry) => entry.depth === 0)) {
      let position = await nextPosition(tx, meetingId, null)
      await tx.insert(agendaLines).values(
        outline.map((entry) => ({
          meetingId,
          position: position++,
          text: entry.title,
          minutes: entry.minutes,
          privateNote: entry.body || null,
        })),
      )
      return { sections: 0, lines: outline.length }
    }

    const sections: OutlineSection[] = []
    for (const entry of outline) {
      if (entry.depth === 0) {
        sections.push({ title: entry.title, minutes: entry.minutes, lines: [] })
      } else {
        sections[sections.length - 1]!.lines.push({
          text: entry.title,
          minutes: entry.minutes,
          privateNote: entry.body || null,
        })
      }
    }
    await appendSections(tx, meetingId, sections)
    return {
      sections: sections.length,
      lines: sections.reduce((sum, section) => sum + section.lines.length, 0),
    }
  })
}

/** How many rows each meeting's agenda has, sections included: none means not yet prepped. */
export async function agendaCounts(exec: Executor, meetingIds: string[]): Promise<Map<string, number>> {
  if (meetingIds.length === 0) return new Map()
  const rows = await exec
    .select({ meetingId: agendaLines.meetingId, n: sql<number>`count(*)::int` })
    .from(agendaLines)
    .where(inArray(agendaLines.meetingId, meetingIds))
    .groupBy(agendaLines.meetingId)
  return new Map(rows.map((row) => [row.meetingId, row.n]))
}
