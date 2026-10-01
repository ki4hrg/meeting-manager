/*
 * Drizzle table definitions.
 *
 * Phase 0 holds only sign-in and the OAuth authorization server. The domain
 * model (docs/SPEC.md) arrives in phase 1.
 *
 * Conventions: snake_case in Postgres, camelCase in TypeScript.
 */

import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

export const oauthTokenKind = pgEnum('oauth_token_kind', ['access', 'refresh'])

export const oauthRegistrationSource = pgEnum('oauth_registration_source', ['dcr', 'manual'])

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
