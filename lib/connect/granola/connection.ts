/*
 * A Granola account as a row in `connections`, and the folders it feeds into
 * contexts.
 *
 * Linking is a key John pastes, not a consent screen, so there is no
 * `/api/connect/granola`. The key is proved against Granola before anything is
 * stored: a key that is wrong is otherwise found out by a background job, with
 * nobody watching.
 *
 * `credentials` holds the key, and the signing secret of the webhook endpoint
 * registered with it. Neither leaves this module except to the client and the
 * signature check.
 *
 * A folder feeds exactly one context (`bindings`, kind `granola_folder`), and
 * that binding is the only thing that says which context a note belongs to. A
 * note in no bound folder is not read at all.
 */

import { and, eq, sql } from 'drizzle-orm'
import { NotFoundError, ValidationError, type Executor } from '../../core/types'
import { bindings, connections } from '../../db/schema'
import { getContext } from '../../directory/contexts'
import { absoluteUrl } from '../../oauth/config'
import {
  ConnectionError,
  clearConnectionError,
  recordConnectionError,
  sealCredentials,
  unsealCredentials,
  type Binding,
} from '../connections'
import {
  GranolaApiError,
  GranolaUnauthorized,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  keyOwner,
} from './client'

export const GRANOLA = 'granola'
export const FOLDER_KIND = 'granola_folder'

/** Where Granola delivers. One URL for the instance. */
export const WEBHOOK_PATH = '/api/webhooks/granola'

/* The account name until Granola says whose key it is: a key with no notes
   yet names nobody. */
const UNNAMED = 'Granola'

type Secrets = {
  apiKey: string
  webhookEndpointId?: string | null
  webhookSecret?: string | null
}

export type GranolaAccount = {
  id: string
  account: string
  lastError: string | null
  /** Granola delivers here as notes are made; without it they arrive by the reconcile job. */
  webhook: boolean
}

type Row = typeof connections.$inferSelect

async function rows(exec: Executor): Promise<Row[]> {
  return exec
    .select()
    .from(connections)
    .where(eq(connections.provider, GRANOLA))
    .orderBy(sql`lower(${connections.account})`)
}

/* A hand-made endpoint's secret, for when registering one through the API is
   not possible. It verifies deliveries for whichever account is connected. */
function envSecret(): string | null {
  return process.env.GRANOLA_WEBHOOK_SECRET?.trim() || null
}

function toAccount(row: Row): GranolaAccount {
  const secrets = unsealCredentials<Secrets>(row.credentials)
  return {
    id: row.id,
    account: row.account,
    lastError: row.lastError,
    webhook: !!secrets?.webhookSecret || !!envSecret(),
  }
}

export async function listGranolaAccounts(exec: Executor): Promise<GranolaAccount[]> {
  return (await rows(exec)).map(toAccount)
}

/** The key for an account. Unreadable (the encryption key changed) reads as "connect again". */
export async function granolaKey(exec: Executor, connectionId: string): Promise<string> {
  const [row] = await exec
    .select()
    .from(connections)
    .where(and(eq(connections.id, connectionId), eq(connections.provider, GRANOLA)))
    .limit(1)
  if (!row) throw new NotFoundError('Connection', connectionId)

  const key = unsealCredentials<Secrets>(row.credentials)?.apiKey
  if (!key) throw new ConnectionError('The stored Granola key cannot be read. Connect again.')
  return key
}

/**
 * Call Granola as an account. A failure is recorded on the connection for the
 * settings page and thrown; a success clears what was recorded.
 */
export async function withGranola<T>(
  exec: Executor,
  connectionId: string,
  call: (key: string) => Promise<T>,
): Promise<T> {
  try {
    const result = await call(await granolaKey(exec, connectionId))
    await clearConnectionError(exec, connectionId)
    return result
  } catch (err) {
    if (err instanceof ConnectionError || err instanceof GranolaApiError) {
      await recordConnectionError(exec, connectionId, err)
    }
    throw err
  }
}

/**
 * Every secret a delivery could have been signed with, and the account each
 * one identifies. A delivery is matched to an account by verifying it, never
 * by anything it says about itself.
 */
export async function signingSecrets(
  exec: Executor,
): Promise<{ connectionId: string; secret: string }[]> {
  const all = await rows(exec)
  const secrets: { connectionId: string; secret: string }[] = []
  for (const row of all) {
    const secret = unsealCredentials<Secrets>(row.credentials)?.webhookSecret
    if (secret) secrets.push({ connectionId: row.id, secret })
  }
  const fallback = envSecret()
  /* Only with exactly one account: the environment's secret says nothing about
     whose delivery it is. */
  if (fallback && all.length === 1) secrets.push({ connectionId: all[0]!.id, secret: fallback })
  return secrets
}

// ─── connecting ──────────────────────────────────────────────────────────────

/**
 * Prove a key, store it, and register the endpoint Granola delivers to.
 *
 * Registering is not what makes the connection: without it the reconcile job
 * still brings notes in, minutes later rather than seconds. So a failure there
 * is left as `webhook: false`, not thrown.
 */
export async function connectGranola(exec: Executor, apiKey: string): Promise<GranolaAccount> {
  const key = apiKey.trim()
  if (key === '') throw new ValidationError('Paste the API key from Granola.')

  let owner: Awaited<ReturnType<typeof keyOwner>>
  try {
    owner = await keyOwner(key)
  } catch (err) {
    if (err instanceof GranolaUnauthorized) {
      throw new ValidationError('Granola did not accept that key.')
    }
    if (err instanceof GranolaApiError) {
      throw new ValidationError(`Granola answered ${err.status}. The key was not saved.`)
    }
    throw err
  }

  const account = owner?.email?.trim().toLowerCase() || UNNAMED
  const all = await rows(exec)
  /* The same account again replaces its key. So does naming an account that
     was connected before Granola could say whose it was. */
  const existing =
    all.find((row) => row.account.toLowerCase() === account.toLowerCase()) ??
    all.find((row) => row.account === UNNAMED)
  const held = existing ? unsealCredentials<Secrets>(existing.credentials) : null

  const secrets: Secrets = {
    apiKey: key,
    webhookEndpointId: held?.webhookEndpointId ?? null,
    webhookSecret: held?.webhookSecret ?? null,
  }

  /* Granola delivers to HTTPS only; a local instance has nowhere to deliver to. */
  const url = absoluteUrl(WEBHOOK_PATH)
  if (!secrets.webhookSecret && url.startsWith('https://')) {
    try {
      const endpoint = await createWebhookEndpoint(key, url)
      secrets.webhookEndpointId = endpoint.id
      secrets.webhookSecret = endpoint.signing_secret
    } catch (err) {
      if (!(err instanceof GranolaApiError || err instanceof GranolaUnauthorized)) throw err
    }
  }

  try {
    const values = { account, credentials: sealCredentials(secrets), lastError: null }
    const [row] = existing
      ? await exec
          .update(connections)
          .set({ ...values, updatedAt: new Date() })
          .where(eq(connections.id, existing.id))
          .returning()
      : await exec
          .insert(connections)
          .values({ provider: GRANOLA, ...values })
          .returning()
    return toAccount(row!)
  } catch (err) {
    /* An endpoint whose secret was not stored can never be verified: take it
       back rather than leave Granola delivering to a URL that refuses it. */
    if (secrets.webhookEndpointId && secrets.webhookEndpointId !== held?.webhookEndpointId) {
      await deleteWebhookEndpoint(key, secrets.webhookEndpointId).catch(() => {})
    }
    throw err
  }
}

/**
 * Remove an account, its folder bindings with it. Granola is asked to stop
 * delivering first; if it cannot be reached the account is removed all the
 * same, and its deliveries no longer verify.
 */
export async function disconnectGranola(exec: Executor, connectionId: string): Promise<void> {
  const [row] = await exec
    .select()
    .from(connections)
    .where(and(eq(connections.id, connectionId), eq(connections.provider, GRANOLA)))
    .limit(1)
  if (!row) return

  const secrets = unsealCredentials<Secrets>(row.credentials)
  if (secrets?.apiKey && secrets.webhookEndpointId) {
    await deleteWebhookEndpoint(secrets.apiKey, secrets.webhookEndpointId).catch(() => {})
  }
  await exec.delete(connections).where(eq(connections.id, row.id))
}

// ─── folders ─────────────────────────────────────────────────────────────────

/**
 * Feed a folder into a context. A folder feeds one context, so binding it
 * again moves it: notes already filed stay where they are.
 */
export async function bindFolder(
  exec: Executor,
  input: { connectionId: string; folderId: string; name: string; contextId: string },
): Promise<Binding> {
  const folderId = input.folderId.trim()
  if (folderId === '') throw new ValidationError('Pick a folder.')
  await granolaKey(exec, input.connectionId)
  await getContext(exec, input.contextId)

  const name = input.name.trim() || folderId
  /* One statement on the unique key, so a folder is never bound twice. */
  const [row] = await exec
    .insert(bindings)
    .values({
      connectionId: input.connectionId,
      kind: FOLDER_KIND,
      externalId: folderId,
      name,
      contextId: input.contextId,
    })
    .onConflictDoUpdate({
      target: [bindings.connectionId, bindings.kind, bindings.externalId],
      set: { contextId: input.contextId, name, projectId: null },
    })
    .returning()
  return row!
}

export async function unbindFolder(
  exec: Executor,
  input: { connectionId: string; folderId: string },
): Promise<void> {
  await exec
    .delete(bindings)
    .where(
      and(
        eq(bindings.connectionId, input.connectionId),
        eq(bindings.kind, FOLDER_KIND),
        eq(bindings.externalId, input.folderId),
      ),
    )
}

/** Folder bindings: one account's, or all of them. */
export async function listFolderBindings(
  exec: Executor,
  { connectionId }: { connectionId?: string } = {},
): Promise<Binding[]> {
  return exec
    .select()
    .from(bindings)
    .where(
      and(
        eq(bindings.kind, FOLDER_KIND),
        connectionId ? eq(bindings.connectionId, connectionId) : undefined,
      ),
    )
    .orderBy(sql`lower(${bindings.name})`)
}
