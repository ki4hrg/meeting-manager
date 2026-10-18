/*
 * The shared vocabulary of the domain layer: a database handle, who is asking,
 * and the refusals a caller can be shown.
 */

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../db/schema'

type Db = PostgresJsDatabase<typeof schema>

/* Derived from `transaction` rather than written out, so it keeps matching as
   tables are added to the schema. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** A database handle, or a transaction on one, so writes can be composed into one commit. */
export type Executor = Db | Tx

export type { Db, Tx }

export function inTransaction<T>(exec: Executor, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return (exec as Db).transaction((tx) => fn(tx as Tx))
}

/** Who is asking. Jobs and webhooks act with no person behind them. */
export type ActorContext = {
  userId: string | null
  source: 'web' | 'mcp' | 'job' | 'webhook' | 'system' | 'todoist'
  /** The OAuth client, when source is 'mcp'. */
  clientId?: string
  /** Groups a multi-row operation into one event. */
  requestId: string
}

/**
 * A refusal the domain layer can state a reason for. The messages are written
 * to be read by a person, and the MCP layer hands them straight back.
 */
export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = new.target.name
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id: string) {
    super(`${entity} ${id} not found`, 'not_found')
  }
}

/** A refusal caused by input the caller can correct. */
export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 'validation')
  }
}
