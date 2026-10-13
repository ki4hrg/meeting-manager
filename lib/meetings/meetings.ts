/*
 * Meetings: created lazily, stubs or dated, solo or multi-day sessions.
 *
 * A meeting with sessions keeps its own start and end, so it shows as the
 * whole event wherever meetings are listed; its agenda is its sessions'.
 */

import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import {
  NotFoundError,
  ValidationError,
  inTransaction,
  type ActorContext,
  type Executor,
} from '../core/types'
import {
  groupMembers,
  groups,
  meetingAbsences,
  meetingGroups,
  meetings,
  meetingPeople,
  meetingProjects,
  people,
  projects,
  series,
  seriesGroups,
  seriesPeople,
  seriesProjects,
  type BlockSettings,
} from '../db/schema'
import { notDeleted, onShelf, type Shelf } from '../db/shelf'
import { getContext } from '../directory/contexts'
import { getProject } from '../projects/projects'

export type MeetingView = {
  id: string
  contextId: string
  title: string
  startsAt: Date | null
  endsAt: Date | null
  series: { id: string; name: string } | null
  /** Its groups. Until attendance is settled, each stands for its members as they are now. */
  groups: { id: string; name: string }[]
  parentMeetingId: string | null
  calendarId: string | null
  calendarEventId: string | null
  blocks: BlockSettings
  /** The people on it by name, without John. */
  people: { id: string; name: string }[]
  /**
   * Who is at it, without John: its people and, until attendance is settled,
   * its groups' members, less anyone left off it alone. Once settled, its
   * people are the record. `groupId` is the group that brought someone, null
   * for someone on it by name.
   */
  attendees: { id: string; name: string; groupId: string | null }[]
  /** When who was there was settled; null while its groups are live. */
  attendanceAt: Date | null
  projects: { id: string; name: string }[]
  sessions: { id: string; title: string; startsAt: Date | null; endsAt: Date | null }[]
  archivedAt: Date | null
}

// ─── reading ─────────────────────────────────────────────────────────────────

/* Every view is built here, so one read and a list give the same shape:
   people without John, projects, and the sessions under each meeting. */
async function loadViews(
  exec: Executor,
  where: SQL | undefined,
  opts: { orderBy?: SQL[]; limit?: number } = {},
): Promise<MeetingView[]> {
  const query = exec
    .select({
      meeting: meetings,
      seriesName: series.name,
      seriesBlocks: series.blocks,
    })
    .from(meetings)
    .leftJoin(series, eq(series.id, meetings.seriesId))
    .where(where)
    .$dynamic()

  if (opts.orderBy?.length) query.orderBy(...opts.orderBy)
  if (opts.limit) query.limit(opts.limit)
  const rows = await query
  if (rows.length === 0) return []

  const meetingIds = rows.map((row) => row.meeting.id)

  const peopleRows = await exec
    .select({
      meetingId: meetingPeople.meetingId,
      personId: people.id,
      personName: people.name,
      isSelf: people.isSelf,
      groupId: meetingPeople.groupId,
    })
    .from(meetingPeople)
    .innerJoin(people, eq(people.id, meetingPeople.personId))
    .where(inArray(meetingPeople.meetingId, meetingIds))
    .orderBy(asc(people.name))

  const groupRows = await exec
    .select({ meetingId: meetingGroups.meetingId, groupId: groups.id, groupName: groups.name })
    .from(meetingGroups)
    .innerJoin(groups, eq(groups.id, meetingGroups.groupId))
    .where(inArray(meetingGroups.meetingId, meetingIds))
    .orderBy(asc(groups.name))

  /* Live groups' members, for the meetings whose attendance is not settled. */
  const live = rows.filter((row) => row.meeting.attendanceAt === null).map((row) => row.meeting.id)
  const liveGroupIds = [...new Set(groupRows.filter((row) => live.includes(row.meetingId)).map((row) => row.groupId))]
  const memberRows =
    liveGroupIds.length === 0
      ? []
      : await exec
          .select({ groupId: groupMembers.groupId, personId: people.id, name: people.name, isSelf: people.isSelf })
          .from(groupMembers)
          .innerJoin(people, eq(people.id, groupMembers.personId))
          .where(and(inArray(groupMembers.groupId, liveGroupIds), notDeleted(people)))
  const absenceRows =
    live.length === 0
      ? []
      : await exec
          .select({ meetingId: meetingAbsences.meetingId, personId: meetingAbsences.personId })
          .from(meetingAbsences)
          .where(inArray(meetingAbsences.meetingId, live))

  const projectRows = await exec
    .select({
      meetingId: meetingProjects.meetingId,
      projectId: projects.id,
      projectName: projects.name,
    })
    .from(meetingProjects)
    .innerJoin(projects, eq(projects.id, meetingProjects.projectId))
    .where(inArray(meetingProjects.meetingId, meetingIds))
    .orderBy(asc(projects.name))

  const sessionRows = await exec
    .select({
      id: meetings.id,
      title: meetings.title,
      startsAt: meetings.startsAt,
      endsAt: meetings.endsAt,
      parentMeetingId: meetings.parentMeetingId,
    })
    .from(meetings)
    .where(and(inArray(meetings.parentMeetingId, meetingIds), onShelf(meetings)))
    .orderBy(asc(meetings.startsAt), asc(meetings.createdAt))

  const byMeetingPeople = new Map<string, { id: string; name: string; groupId: string | null }[]>()
  for (const row of peopleRows) {
    /* John (is_self) is dropped: he's at every meeting */
    if (row.isSelf) continue
    const list = byMeetingPeople.get(row.meetingId) ?? []
    list.push({ id: row.personId, name: row.personName, groupId: row.groupId })
    byMeetingPeople.set(row.meetingId, list)
  }

  const byMeetingProjects = new Map<string, { id: string; name: string }[]>()
  for (const row of projectRows) {
    const list = byMeetingProjects.get(row.meetingId) ?? []
    list.push({ id: row.projectId, name: row.projectName })
    byMeetingProjects.set(row.meetingId, list)
  }

  const byMeetingGroups = new Map<string, { id: string; name: string }[]>()
  for (const row of groupRows) {
    const list = byMeetingGroups.get(row.meetingId) ?? []
    list.push({ id: row.groupId, name: row.groupName })
    byMeetingGroups.set(row.meetingId, list)
  }
  const attendeesOf = (meetingId: string, settled: boolean): MeetingView['attendees'] => {
    const own = byMeetingPeople.get(meetingId) ?? []
    if (settled) return own
    const absent = new Set(absenceRows.filter((row) => row.meetingId === meetingId).map((row) => row.personId))
    // In name order, so someone in two of its groups is shown under the first.
    const groupIds = (byMeetingGroups.get(meetingId) ?? []).map((group) => group.id)
    const byId = new Map(own.map((person) => [person.id, { ...person, groupId: null as string | null }]))
    for (const groupId of groupIds) {
      for (const member of memberRows) {
        if (member.groupId === groupId && !member.isSelf && !absent.has(member.personId) && !byId.has(member.personId)) {
          byId.set(member.personId, { id: member.personId, name: member.name, groupId })
        }
      }
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  const byParent = new Map<string, MeetingView['sessions']>()
  for (const row of sessionRows) {
    const list = byParent.get(row.parentMeetingId!) ?? []
    list.push({ id: row.id, title: row.title, startsAt: row.startsAt, endsAt: row.endsAt })
    byParent.set(row.parentMeetingId!, list)
  }

  return rows.map(({ meeting: m, seriesName, seriesBlocks }) => ({
    id: m.id,
    contextId: m.contextId,
    title: m.title,
    startsAt: m.startsAt,
    endsAt: m.endsAt,
    series: m.seriesId ? { id: m.seriesId, name: seriesName ?? '' } : null,
    groups: byMeetingGroups.get(m.id) ?? [],
    parentMeetingId: m.parentMeetingId,
    calendarId: m.calendarId,
    calendarEventId: m.calendarEventId,
    /* effective: meeting.blocks ?? series.blocks ?? all false */
    blocks:
      m.blocks ?? seriesBlocks ?? { followUps: false, sinceLast: false, lookahead: false },
    people: (byMeetingPeople.get(m.id) ?? []).map(({ id, name }) => ({ id, name })),
    attendees: attendeesOf(m.id, m.attendanceAt !== null),
    attendanceAt: m.attendanceAt,
    projects: byMeetingProjects.get(m.id) ?? [],
    sessions: byParent.get(m.id) ?? [],
    archivedAt: m.archivedAt,
  }))
}

/** How long a meeting with no end time is taken to run. */
const DEFAULT_MINUTES = 60

/**
 * Whether a meeting has finished: past its end, or an hour past its start when
 * it has no end. An undated stub is never over.
 */
export function isOver(
  meeting: { startsAt: Date | null; endsAt: Date | null },
  now: Date = new Date(),
): boolean {
  if (!meeting.startsAt) return false
  const end = meeting.endsAt ?? new Date(meeting.startsAt.getTime() + DEFAULT_MINUTES * 60_000)
  return end < now
}

export async function getMeeting(exec: Executor, id: string): Promise<MeetingView> {
  const [view] = await loadViews(exec, and(eq(meetings.id, id), notDeleted(meetings)))
  if (!view) throw new NotFoundError('Meeting', id)
  return view
}

export async function findMeetingByEvent(
  exec: Executor,
  calendarEventId: string,
): Promise<MeetingView | null> {
  /* An archived meeting still holds its event: archiving one is how an event is put away. */
  const [view] = await loadViews(exec, and(eq(meetings.calendarEventId, calendarEventId), notDeleted(meetings)))
  return view ?? null
}

export type MeetingFilter = {
  contextId: string
  when?: 'upcoming' | 'past' | 'stubs'
  seriesId?: string
  personId?: string
  projectId?: string
  groupId?: string
  topLevelOnly?: boolean
  /** Only meetings starting in [from, to). */
  between?: { from: Date; to: Date }
  now?: Date
  limit?: number
  /** Live by default; `archived` for the collapsed Archived section. */
  shelf?: Shelf
}

export async function listMeetings(
  exec: Executor,
  filter: MeetingFilter,
): Promise<MeetingView[]> {
  await getContext(exec, filter.contextId)
  const now = filter.now ?? new Date()
  const conditions: SQL[] = [eq(meetings.contextId, filter.contextId), onShelf(meetings, filter.shelf)]

  if (filter.topLevelOnly) {
    conditions.push(sql`${meetings.parentMeetingId} is null`)
  }

  /* A meeting is upcoming until it is over, not until it starts: one in
     progress is still the one being prepped and run. */
  const over = sql`coalesce(${meetings.endsAt}, ${meetings.startsAt} + interval '${sql.raw(String(DEFAULT_MINUTES))} minutes')`
  if (filter.when === 'upcoming') {
    conditions.push(sql`${over} >= ${now.toISOString()}::timestamp with time zone`)
  } else if (filter.when === 'past') {
    conditions.push(sql`${over} < ${now.toISOString()}::timestamp with time zone`)
  } else if (filter.when === 'stubs') {
    conditions.push(sql`${meetings.startsAt} is null`)
  }

  if (filter.between) {
    conditions.push(
      sql`${meetings.startsAt} >= ${filter.between.from.toISOString()}::timestamptz and ${meetings.startsAt} < ${filter.between.to.toISOString()}::timestamptz`,
    )
  }

  if (filter.seriesId) {
    conditions.push(eq(meetings.seriesId, filter.seriesId))
  }
  if (filter.groupId) {
    conditions.push(
      sql`exists (select 1 from ${meetingGroups} where ${meetingGroups.meetingId} = ${meetings.id} and ${meetingGroups.groupId} = ${filter.groupId})`,
    )
  }

  /* At it by name, or through one of its groups while those are live and
     they were not left off it. */
  if (filter.personId) {
    conditions.push(
      sql`(exists (select 1 from ${meetingPeople} where ${meetingPeople.meetingId} = ${meetings.id} and ${meetingPeople.personId} = ${filter.personId})
        or (${meetings.attendanceAt} is null
          and exists (select 1 from ${meetingGroups} join ${groupMembers} on ${groupMembers.groupId} = ${meetingGroups.groupId}
            where ${meetingGroups.meetingId} = ${meetings.id} and ${groupMembers.personId} = ${filter.personId})
          and not exists (select 1 from ${meetingAbsences} where ${meetingAbsences.meetingId} = ${meetings.id} and ${meetingAbsences.personId} = ${filter.personId})))`,
    )
  }

  if (filter.projectId) {
    conditions.push(
      sql`exists (select 1 from ${meetingProjects} where ${meetingProjects.meetingId} = ${meetings.id} and ${meetingProjects.projectId} = ${filter.projectId})`,
    )
  }

  /* upcoming: soonest first; past: latest first; stubs: newest first;
     no when: dated soonest-first then stubs */
  const orderBy =
    filter.when === 'upcoming'
      ? [asc(meetings.startsAt)]
      : filter.when === 'past'
        ? [desc(meetings.startsAt)]
        : filter.when === 'stubs'
          ? [desc(meetings.createdAt)]
          : [sql`${meetings.startsAt} asc nulls last`, desc(meetings.createdAt)]

  return loadViews(exec, and(...conditions), { orderBy, limit: filter.limit })
}

/**
 * The meetings of a context nearest a moment, for a picker: top-level ones
 * dated within `days` either side, closest first, then undated ones. Each
 * carries its sessions, so a picker can offer those instead.
 */
export async function meetingsNear(
  exec: Executor,
  contextId: string,
  at: Date,
  opts: { days?: number; limit?: number } = {},
): Promise<MeetingView[]> {
  const days = opts.days ?? 30
  const from = new Date(at.getTime() - days * 86_400_000).toISOString()
  const to = new Date(at.getTime() + days * 86_400_000).toISOString()
  return loadViews(
    exec,
    and(
      eq(meetings.contextId, contextId),
      onShelf(meetings),
      sql`${meetings.parentMeetingId} is null`,
      sql`(${meetings.startsAt} is null or ${meetings.startsAt} between ${from}::timestamptz and ${to}::timestamptz)`,
    ),
    {
      orderBy: [
        sql`abs(extract(epoch from ${meetings.startsAt} - ${at.toISOString()}::timestamptz)) asc nulls last`,
        desc(meetings.createdAt),
      ],
      limit: opts.limit ?? 30,
    },
  )
}

// ─── writing ─────────────────────────────────────────────────────────────────

async function assertGroupIn(exec: Executor, groupId: string, contextId: string) {
  const [group] = await exec
    .select({ contextId: groups.contextId })
    .from(groups)
    .where(eq(groups.id, groupId))
    .limit(1)
  if (!group) throw new NotFoundError('Group', groupId)
  if (group.contextId !== contextId) {
    throw new ValidationError('That group belongs to another context.')
  }
}

async function assertProjectIn(exec: Executor, projectId: string, contextId: string) {
  const project = await getProject(exec, projectId)
  if (project.contextId !== contextId) {
    throw new ValidationError('That project belongs to another context.')
  }
}

async function assertSeriesIn(exec: Executor, seriesId: string, contextId: string) {
  const [s] = await exec
    .select({ contextId: series.contextId })
    .from(series)
    .where(eq(series.id, seriesId))
    .limit(1)
  if (!s) throw new NotFoundError('Series', seriesId)
  if (s.contextId !== contextId) {
    throw new ValidationError('That series belongs to another context.')
  }
}

async function assertMeetingIn(exec: Executor, meetingId: string, contextId: string) {
  const [m] = await exec
    .select({ contextId: meetings.contextId })
    .from(meetings)
    .where(eq(meetings.id, meetingId))
    .limit(1)
  if (!m) throw new NotFoundError('Meeting', meetingId)
  if (m.contextId !== contextId) {
    throw new ValidationError('That meeting belongs to another context.')
  }
}

/* Compute title from series name, people names, or group name, or default to "Meeting" */
async function defaultTitle(
  exec: Executor,
  seriesId: string | undefined,
  groupIds: string[],
  personIds: string[] | undefined,
): Promise<string> {
  if (seriesId) {
    const [s] = await exec.select({ name: series.name }).from(series).where(eq(series.id, seriesId))
    if (s) return s.name
  }

  if (personIds && personIds.length > 0) {
    const people_ = await exec
      .select({ id: people.id, name: people.name })
      .from(people)
      .where(inArray(people.id, personIds))
      .orderBy(asc(people.name))

    if (people_.length === 1) return people_[0]!.name
    if (people_.length === 2) return `${people_[0]!.name} & ${people_[1]!.name}`
    if (people_.length > 2) {
      const names = people_.slice(0, 2).map((p) => p.name).join(', ')
      return `${names} & ${people_.length - 2} more`
    }
  }

  if (groupIds.length > 0) {
    const named = await exec
      .select({ name: groups.name })
      .from(groups)
      .where(inArray(groups.id, groupIds))
      .orderBy(asc(groups.name))
    if (named.length > 0) return named.map((g) => g.name).join(' & ')
  }

  return 'Meeting'
}

export async function createMeeting(
  exec: Executor,
  _actor: ActorContext,
  input: {
    contextId: string
    title?: string | null
    startsAt?: Date | null
    endsAt?: Date | null
    seriesId?: string
    /** Its groups; `groupId` is one. Without either, a series' own. */
    groupIds?: string[]
    groupId?: string
    parentMeetingId?: string
    personIds?: string[]
    projectIds?: string[]
    calendarId?: string
    calendarEventId?: string
    blocks?: BlockSettings | null
  },
): Promise<MeetingView> {
  await getContext(exec, input.contextId)

  if (input.seriesId) await assertSeriesIn(exec, input.seriesId, input.contextId)
  const askedGroups =
    input.groupIds !== undefined || input.groupId !== undefined
      ? [...new Set([...(input.groupIds ?? []), ...(input.groupId ? [input.groupId] : [])])]
      : undefined
  for (const groupId of askedGroups ?? []) await assertGroupIn(exec, groupId, input.contextId)
  if (input.parentMeetingId) {
    await assertMeetingIn(exec, input.parentMeetingId, input.contextId)
    const [parent] = await exec
      .select({ parentId: meetings.parentMeetingId })
      .from(meetings)
      .where(eq(meetings.id, input.parentMeetingId))
      .limit(1)
    if (parent?.parentId) {
      throw new ValidationError('A session cannot itself have a session.')
    }
  }

  if (input.projectIds) {
    for (const projectId of input.projectIds) {
      await assertProjectIn(exec, projectId, input.contextId)
    }
  }

  /* John is silently dropped from people lists */
  let initialPersonIds = input.personIds ?? []
  if (initialPersonIds.length > 0) {
    const people_ = await exec
      .select({ id: people.id, isSelf: people.isSelf })
      .from(people)
      .where(inArray(people.id, initialPersonIds))
    initialPersonIds = people_.filter((p) => !p.isSelf).map((p) => p.id)
  }

  if (input.startsAt && input.endsAt && input.endsAt < input.startsAt) {
    throw new ValidationError('End time must not be before start time.')
  }
  if (input.endsAt && !input.startsAt) {
    throw new ValidationError('An end time requires a start time.')
  }

  if (input.calendarEventId) {
    const existing = await findMeetingByEvent(exec, input.calendarEventId)
    if (existing) {
      throw new ValidationError('That calendar event already has a meeting.')
    }
  }

  /* Defaults from the series */
  let groupIds = askedGroups ?? []
  let personIds = initialPersonIds
  let projectIds = input.projectIds ?? []

  if (input.seriesId) {
    const s = await exec.select().from(series).where(eq(series.id, input.seriesId)).limit(1)
    if (s[0]) {
      if (askedGroups === undefined) {
        const sg = await exec
          .select({ groupId: seriesGroups.groupId })
          .from(seriesGroups)
          .where(eq(seriesGroups.seriesId, input.seriesId))
        groupIds = sg.map((x) => x.groupId)
      }
      if (!input.personIds) {
        const sp = await exec
          .select({ personId: seriesPeople.personId })
          .from(seriesPeople)
          .where(eq(seriesPeople.seriesId, input.seriesId))
        personIds = sp.map((x) => x.personId)
      }
      if (!input.projectIds) {
        const sproj = await exec
          .select({ projectId: seriesProjects.projectId })
          .from(seriesProjects)
          .where(eq(seriesProjects.seriesId, input.seriesId))
        projectIds = sproj.map((x) => x.projectId)
      }
    }
  }

  /* A group stands for its members while the meeting is to come; they are
     not copied onto it until its attendance is settled. */
  const title = input.title ? input.title.trim() : await defaultTitle(exec, input.seriesId, groupIds, personIds)

  return inTransaction(exec, async (tx) => {
    const [m] = await tx
      .insert(meetings)
      .values({
        contextId: input.contextId,
        seriesId: input.seriesId,
        parentMeetingId: input.parentMeetingId,
        title,
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
        calendarId: input.calendarId ?? null,
        calendarEventId: input.calendarEventId ?? null,
        ...(input.calendarEventId
          ? { calendarStartsAt: input.startsAt ?? null, calendarEndsAt: input.endsAt ?? null }
          : {}),
        blocks: input.blocks ?? null,
      })
      .returning()

    if (personIds.length > 0) {
      await tx.insert(meetingPeople).values(
        personIds.map((personId) => ({ meetingId: m!.id, personId })),
      )
    }

    if (projectIds.length > 0) {
      await tx.insert(meetingProjects).values(
        projectIds.map((projectId) => ({ meetingId: m!.id, projectId })),
      )
    }

    if (groupIds.length > 0) {
      await tx.insert(meetingGroups).values(groupIds.map((groupId) => ({ meetingId: m!.id, groupId })))
    }

    return getMeeting(tx, m!.id)
  })
}

export async function updateMeeting(
  exec: Executor,
  _actor: ActorContext,
  id: string,
  input: {
    title?: string
    startsAt?: Date | null
    endsAt?: Date | null
    seriesId?: string | null
    /** Replaces its groups; `groupId` sets one, or none with null. */
    groupIds?: string[]
    groupId?: string | null
    blocks?: BlockSettings | null
  },
): Promise<MeetingView> {
  const m = await getMeeting(exec, id)
  const groupIds =
    input.groupIds !== undefined
      ? [...new Set(input.groupIds)]
      : input.groupId !== undefined
        ? input.groupId
          ? [input.groupId]
          : []
        : undefined

  if (input.seriesId !== undefined && input.seriesId !== null) {
    await assertSeriesIn(exec, input.seriesId, m.contextId)
  }

  for (const groupId of groupIds ?? []) await assertGroupIn(exec, groupId, m.contextId)

  /* Checked against what the meeting will hold once the patch is applied, so
     clearing the start, or moving only one end, cannot leave an end without a
     start or before it. */
  const start = input.startsAt !== undefined ? input.startsAt : m.startsAt
  /* Clearing the start makes a stub, and a stub has no end: the stored end
     goes with it unless the caller says otherwise. */
  const end =
    input.endsAt !== undefined ? input.endsAt : input.startsAt === null ? null : m.endsAt
  if (end && !start) throw new ValidationError('An end time requires a start time.')
  if (start && end && end < start) {
    throw new ValidationError('End time must not be before start time.')
  }

  const patch: Partial<typeof meetings.$inferInsert> = {}

  if (input.title !== undefined) {
    const title = input.title.trim()
    if (title === '') throw new ValidationError('Enter a title.')
    patch.title = title
  }
  if (input.startsAt !== undefined) patch.startsAt = input.startsAt
  if (end !== m.endsAt) patch.endsAt = end
  if (input.seriesId !== undefined) patch.seriesId = input.seriesId
  if (input.blocks !== undefined) patch.blocks = input.blocks

  return inTransaction(exec, async (tx) => {
    await tx
      .update(meetings)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(meetings.id, id))
    if (groupIds !== undefined) await setGroupsOf(tx, id, groupIds)
    return getMeeting(tx, id)
  })
}

async function setGroupsOf(exec: Executor, meetingId: string, groupIds: string[]) {
  await exec.delete(meetingGroups).where(eq(meetingGroups.meetingId, meetingId))
  if (groupIds.length > 0) {
    await exec.insert(meetingGroups).values(groupIds.map((groupId) => ({ meetingId, groupId })))
  }
}

export async function setMeetingPeople(
  exec: Executor,
  _actor: ActorContext,
  id: string,
  personIds: string[],
): Promise<MeetingView> {
  await getMeeting(exec, id)

  /* John is silently dropped from people lists */
  let filtered = personIds
  if (filtered.length > 0) {
    const people_ = await exec
      .select({ id: people.id, isSelf: people.isSelf })
      .from(people)
      .where(inArray(people.id, filtered))
    filtered = people_.filter((p) => !p.isSelf).map((p) => p.id)
  }

  return inTransaction(exec, async (tx) => {
    // Whoever stays keeps the group that brought them.
    const was = await tx
      .select({ personId: meetingPeople.personId, groupId: meetingPeople.groupId })
      .from(meetingPeople)
      .where(eq(meetingPeople.meetingId, id))
    const broughtBy = new Map(was.map((row) => [row.personId, row.groupId]))
    await tx.delete(meetingPeople).where(eq(meetingPeople.meetingId, id))
    if (filtered.length > 0) {
      await tx.insert(meetingPeople).values(
        filtered.map((personId) => ({ meetingId: id, personId, groupId: broughtBy.get(personId) ?? null })),
      )
    }
    return getMeeting(tx, id)
  })
}

export async function setMeetingProjects(
  exec: Executor,
  _actor: ActorContext,
  id: string,
  projectIds: string[],
): Promise<MeetingView> {
  const m = await getMeeting(exec, id)

  for (const projectId of projectIds) {
    await assertProjectIn(exec, projectId, m.contextId)
  }

  return inTransaction(exec, async (tx) => {
    await tx.delete(meetingProjects).where(eq(meetingProjects.meetingId, id))
    if (projectIds.length > 0) {
      await tx.insert(meetingProjects).values(
        projectIds.map((projectId) => ({ meetingId: id, projectId })),
      )
    }
    return getMeeting(tx, id)
  })
}

export async function attachToEvent(
  exec: Executor,
  _actor: ActorContext,
  id: string,
  input: {
    calendarId: string
    calendarEventId: string
    startsAt: Date
    endsAt?: Date
    seriesId?: string
  },
): Promise<MeetingView> {
  const m = await getMeeting(exec, id)

  const existing = await findMeetingByEvent(exec, input.calendarEventId)
  if (existing) {
    throw new ValidationError('That calendar event already has a meeting.')
  }

  if (input.seriesId) {
    await assertSeriesIn(exec, input.seriesId, m.contextId)
  }

  if (input.endsAt && input.endsAt < input.startsAt) {
    throw new ValidationError('End time must not be before start time.')
  }

  const patch: Partial<typeof meetings.$inferInsert> = {
    calendarId: input.calendarId,
    calendarEventId: input.calendarEventId,
    startsAt: input.startsAt,
    calendarStartsAt: input.startsAt,
    calendarEndsAt: input.endsAt ?? null,
  }

  if (input.endsAt !== undefined) patch.endsAt = input.endsAt
  if (input.seriesId !== undefined) patch.seriesId = input.seriesId

  return inTransaction(exec, async (tx) => {
    await tx
      .update(meetings)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(meetings.id, id))
    return getMeeting(tx, id)
  })
}

export async function detachFromEvent(
  exec: Executor,
  _actor: ActorContext,
  id: string,
): Promise<MeetingView> {
  await getMeeting(exec, id)

  await exec
    .update(meetings)
    .set({ calendarId: null, calendarEventId: null, calendarStartsAt: null, calendarEndsAt: null, updatedAt: new Date() })
    .where(eq(meetings.id, id))

  return getMeeting(exec, id)
}

/**
 * Gone at once, for a meeting an accepted proposal made and then took back.
 * What a person removes is archived, then deleted (lib/archive).
 */
export async function deleteMeeting(
  exec: Executor,
  _actor: ActorContext,
  id: string,
): Promise<void> {
  await getMeeting(exec, id)
  await exec.delete(meetings).where(eq(meetings.id, id))
  /* Cascade deletes sessions via parent_meeting_id, and sets item.target_meeting_id and
     item.origin_meeting_id to null via the foreign key's onDelete: 'set null' */
}

export async function previousOccurrence(
  exec: Executor,
  meeting: MeetingView,
): Promise<MeetingView | null> {
  if (!meeting.series) return null
  if (!meeting.startsAt) {
    /* For a stub: latest dated one before now */
    const now = new Date()
    const [row] = await exec
      .select({ id: meetings.id })
      .from(meetings)
      .where(
        and(
          eq(meetings.seriesId, meeting.series.id),
          onShelf(meetings),
          sql`${meetings.startsAt} < ${now.toISOString()}::timestamp with time zone`,
          sql`${meetings.startsAt} is not null`,
        ),
      )
      .orderBy(desc(meetings.startsAt))
      .limit(1)
    if (!row) return null
    const [prev] = await loadViews(exec, eq(meetings.id, row.id))
    return prev ?? null
  }
  /* Same series, latest startsAt before this one's */
  const [row] = await exec
    .select({ id: meetings.id })
    .from(meetings)
    .where(
      and(
        eq(meetings.seriesId, meeting.series.id),
        onShelf(meetings),
        sql`${meetings.startsAt} < ${meeting.startsAt?.toISOString()}::timestamp with time zone`,
      ),
    )
    .orderBy(desc(meetings.startsAt))
    .limit(1)
  if (!row) return null
  const [prev] = await loadViews(exec, eq(meetings.id, row.id))
  return prev ?? null
}

export async function nextOccurrence(
  exec: Executor,
  seriesId: string,
  now?: Date,
): Promise<MeetingView | null> {
  const then = now ?? new Date()
  const [row] = await exec
    .select({ id: meetings.id })
    .from(meetings)
    .where(
      and(
        eq(meetings.seriesId, seriesId),
        onShelf(meetings),
        sql`${meetings.startsAt} >= ${then.toISOString()}::timestamp with time zone`,
      ),
    )
    .orderBy(asc(meetings.startsAt))
    .limit(1)
  if (!row) return null
  const [next] = await loadViews(exec, eq(meetings.id, row.id))
  return next ?? null
}
