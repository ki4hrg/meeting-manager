/*
 * Drizzle table definitions.
 *
 * Sign-in, the OAuth authorization server, and the phase 1 domain model
 * (docs/SPEC.md): contexts, the directory, projects and items. Meetings,
 * agendas, notes and the Todoist links arrive with their phases.
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
    ...timestamps,
  },
  (t) => [uniqueIndex('projects_name_key').on(t.contextId, sql`lower(${t.name})`)],
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
    doneAt: timestamp('done_at', { withTimezone: true }),
    ...timestamps,
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('project_links_project_idx').on(t.projectId)],
)

// ─── items ───────────────────────────────────────────────────────────────────

/*
 * One table, four kinds. Only the context and the text are required. Topic,
 * question and action convert in place; a decision is always its own row,
 * linked to what it settled through parent_item_id.
 *
 * origin_meeting_id and the target_* columns arrive in phase 2, with the tables
 * they point at.
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
    ...timestamps,
  },
  (t) => [
    index('items_context_status_idx').on(t.contextId, t.status),
    index('items_project_idx').on(t.projectId),
    index('items_parent_idx').on(t.parentItemId),
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
   phases add their own ("discussed" arrives with meetings). */
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
