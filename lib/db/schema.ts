/*
 * Drizzle table definitions.
 *
 * Sign-in, the OAuth authorization server, and the domain model through phase 2
 * (docs/SPEC.md): contexts, the directory, projects, items, series, meetings
 * and agendas, the calendar connection, and notes and processing. The Todoist
 * links arrive with their phase.
 *
 * Conventions: snake_case in Postgres, camelCase in TypeScript.
 */

import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  primaryKey,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

export const oauthTokenKind = pgEnum('oauth_token_kind', ['access', 'refresh'])

export const oauthRegistrationSource = pgEnum('oauth_registration_source', ['dcr', 'manual'])

export const itemKind = pgEnum('item_kind', ['topic', 'question', 'action', 'decision'])

/* open, done and dropped for topics, questions and actions; decided and
   superseded for decisions. needs_answer is a question ticked off in Todoist
   with no answer recorded; nothing sets it before phase 4. */
export const itemStatus = pgEnum('item_status', [
  'open',
  'needs_answer',
  'done',
  'dropped',
  'decided',
  'superseded',
])

export const partyRole = pgEnum('party_role', ['owner', 'with'])

export const projectStatus = pgEnum('project_status', ['active', 'paused', 'done'])

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}

/* Archive, then delete (docs/SPEC.md, item 9). Archived, a row leaves every
   list, picker and name lookup, but what points at it still reads it.
   Deleted, it is gone from every screen and query, and is removed for good
   30 days later (lib/archive/purge.ts). */
const shelved = {
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}

/* Kept 30 days after a delete, for Restore; no archive step of its own. */
const deletable = {
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}

// ─── sign-in ─────────────────────────────────────────────────────────────────

/* One user. /setup creates it and then closes; nothing assumes the count beyond that. */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    /* IANA name; null means the instance's TZ. Dates sent to Todoist and shown
       in agendas are computed in this zone, not UTC. */
    timeZone: text('time_zone'),
    ...timestamps,
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('users_email_key')
      .on(sql`lower(${t.email})`)
      .where(sql`${t.deletedAt} is null`),
  ],
)

export const sessions = pgTable(
  'sessions',
  {
    /* HMAC-SHA256(SESSION_SECRET, token), never the token itself. Keyed, so
       rotating SESSION_SECRET invalidates every session. */
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
)

// ─── OAuth authorization server ──────────────────────────────────────────────

export const oauthClients = pgTable('oauth_clients', {
  id: text('id').primaryKey(),
  clientName: text('client_name').notNull(),
  logoUri: text('logo_uri'),
  /* An allowlist, checked exactly. No prefix matching, no wildcards. */
  redirectUris: text('redirect_uris').array().notNull(),
  registrationSource: oauthRegistrationSource('registration_source').notNull().default('dcr'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
})

export const oauthAuthorizationCodes = pgTable('oauth_authorization_codes', {
  codeHash: text('code_hash').primaryKey(),
  clientId: text('client_id')
    .notNull()
    .references(() => oauthClients.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  redirectUri: text('redirect_uri').notNull(),
  scope: text('scope').notNull(),
  resource: text('resource'),
  codeChallenge: text('code_challenge').notNull(),
  codeChallengeMethod: text('code_challenge_method').notNull().default('S256'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  /* Single-use; a second exchange revokes the whole grant. */
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
})

export const oauthTokens = pgTable(
  'oauth_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull(),
    kind: oauthTokenKind('kind').notNull(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    resource: text('resource'),
    /* Refresh rotation chain: reuse of a rotated token revokes the chain. */
    parentId: uuid('parent_id').references((): AnyPgColumn => oauthTokens.id),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('oauth_tokens_hash_key').on(t.tokenHash),
    index('oauth_tokens_user_idx').on(t.userId),
    index('oauth_tokens_client_idx').on(t.clientId),
  ],
)

// ─── MCP ─────────────────────────────────────────────────────────────────────

/*
 * Idempotency receipts for MCP writes. A key reused with different arguments
 * is refused by name rather than answered with the first call's result. The
 * receipt is written in the same transaction as the work it describes.
 */
export const mcpWriteReceipts = pgTable(
  'mcp_write_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /* Nullable for first-party callers; keys are namespaced per client. */
    clientId: text('client_id'),
    idempotencyKey: text('idempotency_key').notNull(),
    tool: text('tool').notNull(),
    argumentHash: text('argument_hash').notNull(),
    result: jsonb('result').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    /* `coalesce`, because NULL is not equal to itself in a unique index. */
    uniqueIndex('mcp_write_receipts_key').on(sql`coalesce(${t.clientId}, '')`, t.idempotencyKey),
    index('mcp_write_receipts_expiry_idx').on(t.expiresAt),
  ],
)

// ─── contexts and the directory ──────────────────────────────────────────────

/* A hard boundary: projects, groups and items carry a context and nothing
   crosses between two of them. */
export const contexts = pgTable(
  'contexts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps,
    ...shelved,
  },
  (t) => [uniqueIndex('contexts_name_key').on(sql`lower(${t.name})`)],
)

/* People are global: the same person can be met in two contexts. */
export const people = pgTable(
  'people',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /* The one row that is John. "I owe" and "owed to me" are read against it. */
    isSelf: boolean('is_self').notNull().default(false),
    ...timestamps,
    ...shelved,
  },
  (t) => [
    uniqueIndex('people_self_key').on(t.isSelf).where(sql`${t.isSelf}`),
    index('people_name_idx').on(sql`lower(${t.name})`),
  ],
)

export const personEmails = pgTable(
  'person_emails',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    personId: uuid('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('person_emails_email_key').on(sql`lower(${t.email})`),
    index('person_emails_person_idx').on(t.personId),
  ],
)

export const groups = pgTable(
  'groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contextId: uuid('context_id')
      .notNull()
      .references(() => contexts.id),
    name: text('name').notNull(),
    ...timestamps,
    ...shelved,
  },
  (t) => [uniqueIndex('groups_name_key').on(t.contextId, sql`lower(${t.name})`)],
)

export const groupMembers = pgTable(
  'group_members',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.personId] }),
    index('group_members_person_idx').on(t.personId),
  ],
)

/* A distribution list's addresses. An address is on one person or one group, never both. */
export const groupEmails = pgTable(
  'group_emails',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('group_emails_email_key').on(sql`lower(${t.email})`),
    index('group_emails_group_idx').on(t.groupId),
  ],
)

// ─── projects ────────────────────────────────────────────────────────────────

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contextId: uuid('context_id')
      .notNull()
      .references(() => contexts.id),
    name: text('name').notNull(),
    description: text('description'),
    status: projectStatus('status').notNull().default('active'),
    /* A project within another, in the same context, any depth, no cycles. */
    parentId: uuid('parent_id').references((): AnyPgColumn => projects.id, { onDelete: 'set null' }),
    ...timestamps,
    ...shelved,
  },
  (t) => [
    uniqueIndex('projects_name_key').on(t.contextId, sql`lower(${t.name})`),
    index('projects_parent_idx').on(t.parentId),
  ],
)

export const milestones = pgTable(
  'milestones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    dueOn: date('due_on'),
    ...timestamps,
    ...deletable,
  },
  (t) => [index('milestones_project_idx').on(t.projectId)],
)

export const projectLinks = pgTable(
  'project_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    url: text('url').notNull(),
    ...deletable,
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('project_links_project_idx').on(t.projectId)],
)

// ─── items ───────────────────────────────────────────────────────────────────

/*
 * One table, four kinds. Only the context and the text are required. Topic,
 * question and action convert in place; a decision is always its own row,
 * linked to what it settled through parent_item_id.
 */
export const items = pgTable(
  'items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contextId: uuid('context_id')
      .notNull()
      .references(() => contexts.id),
    kind: itemKind('kind').notNull().default('topic'),
    status: itemStatus('status').notNull().default('open'),
    text: text('text').notNull(),
    detail: text('detail'),
    /* The answer to a question, or how a topic or action ended. */
    resolution: text('resolution'),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    /* Always a deadline, never a "do it on" date. */
    dueOn: date('due_on'),
    /* What this item came out of. Set at creation and never moved, so a thread
       cannot loop. */
    parentItemId: uuid('parent_item_id').references((): AnyPgColumn => items.id),
    supersededByItemId: uuid('superseded_by_item_id').references((): AnyPgColumn => items.id),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /* The meeting this item was captured in or came out of. */
    originMeetingId: uuid('origin_meeting_id').references(() => meetings.id, {
      onDelete: 'set null',
    }),
    /* "Raise this at": one meeting, the next occurrence of a series, or the next
       meeting that carries a project. Such an item is placed on that agenda
       without being asked for. */
    targetMeetingId: uuid('target_meeting_id').references(() => meetings.id, {
      onDelete: 'set null',
    }),
    targetSeriesId: uuid('target_series_id').references(() => series.id, {
      onDelete: 'set null',
    }),
    targetProjectId: uuid('target_project_id').references((): AnyPgColumn => projects.id, {
      onDelete: 'set null',
    }),
    /* Parked for later: off "I owe" and "Waiting on" until later_on (never,
       when null) or until its deadline comes close. Neither is a deadline. */
    parkedAt: timestamp('parked_at', { withTimezone: true }),
    laterOn: date('later_on'),
    ...timestamps,
    ...deletable,
  },
  (t) => [
    check(
      'items_one_target',
      sql`num_nonnulls(${t.targetMeetingId}, ${t.targetSeriesId}, ${t.targetProjectId}) <= 1`,
    ),
    index('items_context_status_idx').on(t.contextId, t.status),
    index('items_project_idx').on(t.projectId),
    index('items_parent_idx').on(t.parentItemId),
    index('items_target_meeting_idx').on(t.targetMeetingId),
    index('items_target_series_idx').on(t.targetSeriesId),
    index('items_target_project_idx').on(t.targetProjectId),
    index('items_origin_meeting_idx').on(t.originMeetingId),
  ],
)

/*
 * Who an item involves: a person or a group, never both in one row. `owner`
 * owes the action or the answer. `with` is who to raise it with; on an item
 * John owns, it is the party the item is owed to.
 */
export const itemParties = pgTable(
  'item_parties',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    personId: uuid('person_id').references(() => people.id),
    groupId: uuid('group_id').references(() => groups.id),
    role: partyRole('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('item_parties_one_party', sql`num_nonnulls(${t.personId}, ${t.groupId}) = 1`),
    /* One role per party per item. */
    uniqueIndex('item_parties_person_key')
      .on(t.itemId, t.personId)
      .where(sql`${t.personId} is not null`),
    uniqueIndex('item_parties_group_key')
      .on(t.itemId, t.groupId)
      .where(sql`${t.groupId} is not null`),
    index('item_parties_person_idx').on(t.personId),
    index('item_parties_group_idx').on(t.groupId),
  ],
)

/* Every step an item takes. The type is text rather than an enum because later
   phases add their own. */
export const itemEvents = pgTable(
  'item_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    data: jsonb('data').notNull().default({}),
    source: text('source').notNull(),
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('item_events_item_idx').on(t.itemId, t.createdAt)],
)

// ─── series and meetings ─────────────────────────────────────────────────────

/* Which generated blocks an agenda carries. Set on the series; a meeting with
   no series, or with `blocks` null, falls back to all off. */
export type BlockSettings = { followUps: boolean; sinceLast: boolean; lookahead: boolean }

/* A series' standing agenda, copied onto each new occurrence. */
export type SkeletonSection = {
  title: string
  lines: { text: string; minutes?: number | null }[]
}

/*
 * A recurring meeting: its roster, default projects, groups, standing agenda
 * and generated-block defaults. A calendar recurring event maps to one series.
 */
export const series = pgTable(
  'series',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contextId: uuid('context_id')
      .notNull()
      .references(() => contexts.id),
    name: text('name').notNull(),
    /* The calendar's id for the recurring event (Google's recurringEventId). */
    calendarSeriesId: text('calendar_series_id'),
    skeleton: jsonb('skeleton').$type<SkeletonSection[]>().notNull().default([]),
    blocks: jsonb('blocks')
      .$type<BlockSettings>()
      .notNull()
      .default({ followUps: false, sinceLast: false, lookahead: false }),
    ...timestamps,
    ...shelved,
  },
  (t) => [
    uniqueIndex('series_name_key').on(t.contextId, sql`lower(${t.name})`),
    uniqueIndex('series_calendar_key')
      .on(t.calendarSeriesId)
      .where(sql`${t.calendarSeriesId} is not null`),
  ],
)

/* The roster. John is never a row here or in meeting_people: he is at every
   meeting, so "a 1:1" is a meeting with exactly one row. */
export const seriesPeople = pgTable(
  'series_people',
  {
    seriesId: uuid('series_id')
      .notNull()
      .references(() => series.id, { onDelete: 'cascade' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.seriesId, t.personId] })],
)

/* Groups on the roster: each carries to every meeting of the series. */
export const seriesGroups = pgTable(
  'series_groups',
  {
    seriesId: uuid('series_id')
      .notNull()
      .references(() => series.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.seriesId, t.groupId] }), index('series_groups_group_idx').on(t.groupId)],
)

export const seriesProjects = pgTable(
  'series_projects',
  {
    seriesId: uuid('series_id')
      .notNull()
      .references(() => series.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.seriesId, t.projectId] })],
)

/*
 * Created lazily: a row exists only once John preps the meeting, logs it, or a
 * note arrives for it. The calendar itself is a read-only feed.
 *
 * starts_at null is an undated stub ("Prep a meeting with…"), which can later
 * be attached to a calendar event. parent_meeting_id, one level deep, makes a
 * session of a multi-day meeting.
 */
export const meetings = pgTable(
  'meetings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contextId: uuid('context_id')
      .notNull()
      .references(() => contexts.id),
    seriesId: uuid('series_id').references(() => series.id, { onDelete: 'set null' }),
    parentMeetingId: uuid('parent_meeting_id').references((): AnyPgColumn => meetings.id, {
      onDelete: 'cascade',
    }),
    title: text('title').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    /* The calendar event this meeting is, once attached. */
    calendarId: text('calendar_id'),
    calendarEventId: text('calendar_event_id'),
    /* Null inherits the series' blocks. */
    blocks: jsonb('blocks').$type<BlockSettings>(),
    /* When who was there was settled: by the roll call, or the first look
       after the meeting ended. Until then its groups stand for their members
       as they are; from then on meeting_people is the record. */
    attendanceAt: timestamp('attendance_at', { withTimezone: true }),
    ...timestamps,
    ...shelved,
  },
  (t) => [
    /* One meeting per calendar event: attaching a stub cannot make a duplicate. */
    uniqueIndex('meetings_calendar_event_key')
      .on(t.calendarEventId)
      .where(sql`${t.calendarEventId} is not null`),
    index('meetings_context_start_idx').on(t.contextId, t.startsAt),
    index('meetings_series_idx').on(t.seriesId, t.startsAt),
    index('meetings_parent_idx').on(t.parentMeetingId),
  ],
)

export const meetingPeople = pgTable(
  'meeting_people',
  {
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
    /* Once attendance is settled: the group that brought them, rather than
       being on the meeting by name. Null for someone named on it. */
    groupId: uuid('group_id').references(() => groups.id, { onDelete: 'set null' }),
  },
  (t) => [
    primaryKey({ columns: [t.meetingId, t.personId] }),
    index('meeting_people_person_idx').on(t.personId),
  ],
)

/* A meeting's groups. Live until its attendance is settled (meetings.attendance_at). */
export const meetingGroups = pgTable(
  'meeting_groups',
  {
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.meetingId, t.groupId] }), index('meeting_groups_group_idx').on(t.groupId)],
)

/* Someone expected at a meeting and left off it alone ("Adlene is out this
   week"): from the series' roster or one of its groups. A later roster or
   group change does not put them back. */
export const meetingAbsences = pgTable(
  'meeting_absences',
  {
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.meetingId, t.personId] })],
)

export const meetingProjects = pgTable(
  'meeting_projects',
  {
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.meetingId, t.projectId] }),
    index('meeting_projects_project_idx').on(t.projectId),
  ],
)

/* "Not this time": a candidate turned away for this meeting stays away, and an
   item taken off the agenda is not put back by the automatic placement. */
export const meetingDismissals = pgTable(
  'meeting_dismissals',
  {
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.meetingId, t.itemId] })],
)

/*
 * An agenda in two levels. A section is a row with is_section; a line belongs
 * to a section or sits at the top level. A line is free text, or a reference to
 * a live item (whose text is shown unless `text` overrides it), with a public
 * description, a leader, and a private note only John sees.
 */
export const agendaLines = pgTable(
  'agenda_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    isSection: boolean('is_section').notNull().default(false),
    sectionId: uuid('section_id').references((): AnyPgColumn => agendaLines.id, {
      onDelete: 'cascade',
    }),
    /* Order among siblings: top-level rows together, a section's lines together. */
    position: integer('position').notNull().default(0),
    text: text('text'),
    itemId: uuid('item_id').references(() => items.id, { onDelete: 'cascade' }),
    /* What the attendees read under the line: in the agenda sent round and the brief. */
    description: text('description'),
    /* Who leads this line; John is a person like any other here. */
    leaderPersonId: uuid('leader_person_id').references(() => people.id, { onDelete: 'set null' }),
    privateNote: text('private_note'),
    minutes: integer('minutes'),
    /* 'HH:MM' in the user's time zone: this line starts then, whatever precedes it. */
    pinnedStart: text('pinned_start'),
    ...timestamps,
  },
  (t) => [
    check(
      'agenda_lines_section_shape',
      sql`not ${t.isSection} or (${t.sectionId} is null and ${t.itemId} is null)`,
    ),
    check('agenda_lines_has_content', sql`${t.text} is not null or ${t.itemId} is not null`),
    /* An item is on an agenda once. */
    uniqueIndex('agenda_lines_item_key')
      .on(t.meetingId, t.itemId)
      .where(sql`${t.itemId} is not null`),
    index('agenda_lines_meeting_idx').on(t.meetingId, t.position),
  ],
)

// ─── integrations ────────────────────────────────────────────────────────────

/* An account at an outside service. `credentials` is encrypted at rest. */
export const connections = pgTable(
  'connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').notNull(),
    account: text('account').notNull(),
    credentials: text('credentials').notNull(),
    scopes: text('scopes').notNull().default(''),
    /* Set when the service refused the credentials; cleared on the next success. */
    lastError: text('last_error'),
    ...timestamps,
  },
  (t) => [uniqueIndex('connections_account_key').on(t.provider, sql`lower(${t.account})`)],
)

/* What an outside thing maps to here: a calendar to a context in phase 2; a
   Granola folder or Todoist project to a context or project later. */
export const bindings = pgTable(
  'bindings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    externalId: text('external_id').notNull(),
    name: text('name').notNull(),
    contextId: uuid('context_id')
      .notNull()
      .references(() => contexts.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('bindings_external_key').on(t.connectionId, t.kind, t.externalId)],
)

// ─── notes and processing ────────────────────────────────────────────────────

/*
 * What was written down at a meeting: pasted by hand ("Log a meeting") or
 * delivered by Granola. A meeting can hold several. The note belongs to the
 * meeting, so it travels with it and is never listed across contexts.
 */
/* Someone a note names by address: Granola's attendees and the event's invitees. */
export type NoteAttendee = { email: string; name: string | null }

/* What a note that arrived unfiled says about when it was and which calendar
   event it recorded: enough to find or make its meeting once a context is
   chosen, without asking Granola again. */
export type NoteFiling = {
  startsAt: string | null
  endsAt: string | null
  calendarEventId: string | null
}

export const notes = pgTable(
  'notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /* Null while the note is unfiled: it arrived from no folder that feeds a
       context and waits in the Inbox, in no context at all, until John files
       it or waves it away. Nothing is processed before it is filed. */
    meetingId: uuid('meeting_id').references(() => meetings.id, { onDelete: 'cascade' }),
    filing: jsonb('filing').$type<NoteFiling>(),
    /* Waved away from the Inbox while unfiled. */
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    /* 'pasted' or 'granola'. */
    source: text('source').notNull(),
    /* Granola's note id. */
    externalId: text('external_id'),
    title: text('title'),
    /* John's own words: the pasted text, or Granola's notepad
       (`private_notes_markdown`). Verbatim lines are read from here only. */
    body: text('body').notNull().default(''),
    /* Granola's generated summary and transcript; null for a pasted note. */
    summary: text('summary'),
    transcript: text('transcript'),
    /* sha256 over body, summary and transcript: what a processing run is keyed on. */
    contentHash: text('content_hash').notNull(),
    externalUpdatedAt: timestamp('external_updated_at', { withTimezone: true }),
    /* Who the note says was there, as it arrived. The ones not in the directory
       are offered at review; one John waves away is taken off this list. */
    attendees: jsonb('attendees').$type<NoteAttendee[]>().notNull().default([]),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('notes_external_key')
      .on(t.source, t.externalId)
      .where(sql`${t.externalId} is not null`),
    index('notes_meeting_idx').on(t.meetingId),
    index('notes_unfiled_idx').on(t.createdAt).where(sql`${t.meetingId} is null`),
  ],
)

export const runStatus = pgEnum('run_status', ['queued', 'running', 'done', 'failed'])

/* What a run concluded about the meeting as a whole. */
export type RunOutput = {
  summary: string | null
  /* A summary per agenda line that was discussed. */
  lines: { lineId: string; summary: string }[]
}

/*
 * One pass over one version of a note. Keyed by note and content hash, so a
 * re-delivered note is not processed twice and an edited one is.
 */
export const processingRuns = pgTable(
  'processing_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    noteId: uuid('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    contentHash: text('content_hash').notNull(),
    status: runStatus('status').notNull().default('queued'),
    /* The model that ran, or null when only the verbatim lines were read. */
    model: text('model'),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    output: jsonb('output').$type<RunOutput>(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('processing_runs_key').on(t.noteId, t.contentHash),
    index('processing_runs_status_idx').on(t.status),
  ],
)

export const proposalStatus = pgEnum('proposal_status', ['pending', 'accepted', 'rejected'])

/* A party as extraction saw it. `name` is what the note said; the ids are set
   when it resolved to a row. A party with neither id is asked for at review. */
export type ProposedParty = {
  role: 'owner' | 'with'
  name: string
  personId?: string
  groupId?: string
}

/*
 * What a proposal would do once accepted. Everything in a payload belongs to
 * the meeting's context; a payload is never carried to another one.
 */
export type ProposalPayload =
  | {
      type: 'item'
      kind: 'topic' | 'question' | 'action' | 'decision'
      text: string
      detail?: string | null
      /* A question that was answered in the meeting, or how a topic ended. */
      resolution?: string | null
      parties: ProposedParty[]
      projectId?: string | null
      dueOn?: string | null
      parentItemId?: string | null
      /* Raise at the next meeting of this series. */
      seriesId?: string | null
    }
  | {
      type: 'update'
      itemId: string
      change: 'complete' | 'answer' | 'drop' | 'note' | 'discussed'
      /* The answer, the outcome or the note's text. */
      text?: string | null
    }
  | {
      /* Drafted content from the scratchpad, kept whole. */
      type: 'document'
      title: string
      body: string
      projectId?: string | null
    }
  | {
      /* A follow-up conversation to schedule: an undated meeting with these people. */
      type: 'stub'
      title: string
      people: { name: string; personId?: string }[]
    }

/* What accepting a proposal made or changed, kept so it can be undone. */
export type ProposalResult = {
  itemId?: string
  documentId?: string
  meetingId?: string
  /* For an update: the item's fields before it. */
  before?: { status: string; resolution: string | null; closedAt: string | null }
  /* The item_events row an update wrote. */
  eventId?: string
}

/*
 * One thing processing suggests. Nothing reaches the real tables until it is
 * accepted. The fingerprint is unique per meeting and a rejected row is kept,
 * so a re-delivered or edited note proposes only what is new.
 */
export const proposals = pgTable(
  'proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    noteId: uuid('note_id').references(() => notes.id, { onDelete: 'set null' }),
    runId: uuid('run_id').references(() => processingRuns.id, { onDelete: 'set null' }),
    status: proposalStatus('status').notNull().default('pending'),
    fingerprint: text('fingerprint').notNull(),
    payload: jsonb('payload').$type<ProposalPayload>().notNull(),
    /* A verbatim line (`D:` `Q:` `A:` `T:`): the wording is John's and is not the model's to change. */
    verbatim: boolean('verbatim').notNull().default(false),
    /* The owner was inferred with low confidence: highlighted, and left out of approve-all. */
    lowConfidence: boolean('low_confidence').notNull().default(false),
    /* The agenda line this came up under, when the model could tell. */
    agendaLineId: uuid('agenda_line_id').references(() => agendaLines.id, { onDelete: 'set null' }),
    position: integer('position').notNull().default(0),
    result: jsonb('result').$type<ProposalResult>(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('proposals_fingerprint_key').on(t.meetingId, t.fingerprint),
    index('proposals_meeting_idx').on(t.meetingId, t.status),
  ],
)

/* A working document: drafted content saved whole, shown on its project's hub. */
export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contextId: uuid('context_id')
      .notNull()
      .references(() => contexts.id),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    meetingId: uuid('meeting_id').references(() => meetings.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    /* Markdown. */
    body: text('body').notNull().default(''),
    ...timestamps,
    ...deletable,
  },
  (t) => [
    index('documents_project_idx').on(t.projectId),
    index('documents_context_idx').on(t.contextId),
  ],
)

/*
 * Every delivery from an outside service, claimed by its id before any work is
 * done so a repeat is recognised. The payload is kept for the reconcile job
 * and for looking at what went wrong.
 */
export const integrationEvents = pgTable(
  'integration_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').notNull(),
    /* The service's delivery id. */
    externalId: text('external_id').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull().default({}),
    /* 'received', 'processed', 'ignored' or 'failed'. */
    status: text('status').notNull().default('received'),
    detail: text('detail'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('integration_events_delivery_key').on(t.provider, t.externalId),
    index('integration_events_received_idx').on(t.receivedAt),
  ],
)
