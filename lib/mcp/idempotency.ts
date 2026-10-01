/*
 * "A retry after a timeout is always safe."
 *
 * That exists to correct a named Capacities failure:
 * roughly one write in six timed out, and a blind retry created a permanent
 * duplicate. A model cannot tell a lost response from a lost write, so the
 * safety has to come from the server.
 *
 * Every MCP write tool routes through `withIdempotency`. The first call to use a
 * key does the work and stores its result; a replay returns that result without
 * touching a row. The receipt is written **inside the same transaction** as the
 * work, so there is no window in which one committed and the other did not.
 *
 * Two failure modes are worth naming, because both are silent if unhandled:
 *
 *   - A key reused with different arguments is refused rather than answered.
 *     Returning the first call's result there would drop the second write and
 *     report success — which is exactly the class of failure this exists to end.
 *   - Two calls with one key racing each other are serialised by the unique
 *     index, not by a read-then-write check. The loser catches the violation and
 *     reads the winner's receipt.
 */

import { createHash } from 'node:crypto'
import { and, eq, gt, sql } from 'drizzle-orm'
import { mcpWriteReceipts } from '../db/schema'
import { inTransaction } from '@/lib/core/types'
import type { Executor, Tx } from '@/lib/core/types'
import { ToolRefusal } from './tools/types'

/** Long enough to outlive any retry a client will make, short enough to prune. */
export const RECEIPT_TTL_SECONDS = 24 * 60 * 60

/**
 * Run `work` once per (client, key), or return what it returned last time.
 *
 * `args` is hashed rather than stored: it can carry a note body of arbitrary
 * size, and the only question ever asked of it is whether it is the same as
 * before.
 */
export async function withIdempotency<T>(
  exec: Executor,
  identity: { clientId?: string; idempotencyKey: string; tool: string },
  args: unknown,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  const clientId = identity.clientId ?? null
  const argumentHash = hashArguments(args)

  const existing = await findReceipt(exec, clientId, identity.idempotencyKey)
  if (existing) return assertSameCall(existing, identity, argumentHash)

  try {
    return await inTransaction(exec, async (tx) => {
      const result = await work(tx)

      await tx.insert(mcpWriteReceipts).values({
        clientId,
        idempotencyKey: identity.idempotencyKey,
        tool: identity.tool,
        argumentHash,
        result: result as never,
        expiresAt: new Date(Date.now() + RECEIPT_TTL_SECONDS * 1000),
      })

      return result
    })
  } catch (err) {
    /*
     * Two calls with the same key arrived together. The transaction that lost
     * has rolled back — its work included — so reading the winner's receipt is
     * both correct and the only thing left to do.
     */
    if (!isReceiptCollision(err)) throw err

    const winner = await findReceipt(exec, clientId, identity.idempotencyKey)
    if (!winner) throw err
    return assertSameCall(winner, identity, argumentHash)
  }
}

type Receipt = typeof mcpWriteReceipts.$inferSelect

async function findReceipt(
  exec: Executor,
  clientId: string | null,
  idempotencyKey: string,
): Promise<Receipt | undefined> {
  const [row] = await exec
    .select()
    .from(mcpWriteReceipts)
    .where(
      and(
        sql`coalesce(${mcpWriteReceipts.clientId}, '') = ${clientId ?? ''}`,
        eq(mcpWriteReceipts.idempotencyKey, idempotencyKey),
        /* An expired receipt is treated as absent rather than as a match: the
           guarantee is about retries, which happen in seconds, and honouring a
           day-old key would make a deliberately reused one silently a no-op. */
        gt(mcpWriteReceipts.expiresAt, new Date()),
      ),
    )
    .limit(1)

  return row
}

function assertSameCall<T>(
  receipt: Receipt,
  identity: { tool: string },
  argumentHash: string,
): T {
  if (receipt.tool !== identity.tool) {
    throw new ToolRefusal(
      `That idempotency key was already used by ${receipt.tool}.`,
      'Use a fresh key for each logical operation, and reuse one only to retry that same call.',
    )
  }

  if (receipt.argumentHash !== argumentHash) {
    throw new ToolRefusal(
      `That idempotency key was already used by ${identity.tool} with different arguments.`,
      'Nothing was written. Use a fresh key — reusing one is how a retry is made safe, not how a ' +
        'second write is made.',
    )
  }

  return receipt.result as T
}

/*
 * Key order must not change the hash — a model regenerating its arguments will
 * not preserve it — so objects are serialised with their keys sorted, all the
 * way down.
 */
function hashArguments(args: unknown): string {
  return createHash('sha256').update(canonicalize(args)).digest('hex')
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`
}

/* 23505 is unique_violation. Matched on the constraint so an unrelated
   collision inside `work` is not mistaken for this one. */
function isReceiptCollision(err: unknown): boolean {
  let current: unknown = err
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const candidate = current as Error & { code?: string; constraint_name?: string }
    if (candidate.code === '23505' && candidate.constraint_name === 'mcp_write_receipts_key') {
      return true
    }
    current = candidate.cause
  }
  return false
}
