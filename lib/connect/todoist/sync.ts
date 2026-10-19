/*
 * The Todoist sync (docs/SPEC.md, "Todoist sync"): one pass reads Todoist's
 * change feed, merges every link, makes tasks for what newly syncs, and sends
 * the changes in one batch.
 *
 *   1. Pull. The tasks changed since the last pass go into `todoist_tasks`,
 *      with the new cursor, in one commit.
 *   2. Merge. Each live link is compared three ways (`merge.ts`). A link whose
 *      context is archived is left alone: Todoist's side keeps being recorded,
 *      and is merged when the context is live again.
 *   3. Create. An item that newly syncs gets a `pending` link before its task
 *      is asked for, carrying the command's uuid, so a pass that dies half-way
 *      re-sends the same command and Todoist does not make it twice.
 *   4. Push. The commands go in batches. A link's item changes and its new
 *      base are written only when every command for it was accepted; a link
 *      with a refused command is left as it was and tried again next pass.
 *
 * What syncs (`eligibleItem`): an open action or question (not an ongoing
 * one), not deleted, in a live context, with John's own person row among its
 * owners. A group as owner neither adds nor takes away: John and a group
 * syncs, a group alone does not.
 * Items open when Todoist was connected are `unmatched` instead (`match.ts`).
 */

import { randomUUID } from 'node:crypto'
import { and, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm'
import { todayIn } from '../../core/dates'
import { AppError, inTransaction, type ActorContext, type Executor } from '../../core/types'
import {
  connections,
  contexts,
  itemParties,
  items,
  itemTodoistLinks,
  todoistTasks,
  users,
} from '../../db/schema'
import { findSelf } from '../../directory/people'
import {
  completeItem,
  markNeedsAnswer,
  reopenItem,
  updateItem,
} from '../../items/items'
import { absoluteUrl } from '../../oauth/config'
import type { Connection } from '../connections'
import {
  MAX_COMMANDS,
  getTask,
  todoistSync,
  type Command,
  type SyncResponse,
  type TodoistTask,
  type TodoistTokens,
} from './client'
import {
  saveTodoistConnection,
  todoistConnection,
  todoistProjectFor,
  withTodoist,
} from './connection'
import { mergeLink, type Base, type ItemOp, type TaskCommand, type UnlinkReason } from './merge'

export function todoistActor(): ActorContext {
  return { userId: null, source: 'todoist', requestId: randomUUID() }
}

// ─── what syncs ──────────────────────────────────────────────────────────────

/** John's own person row is an owner of the item in the outer query. */
export function johnOwns(selfId: string | null): SQL<boolean> {
  if (!selfId) return sql<boolean>`false`
  return sql<boolean>`exists (select 1 from ${itemParties} where ${itemParties.itemId} = ${items.id} and ${itemParties.personId} = ${selfId} and ${itemParties.role} = 'owner')`
}

/** The item in the outer query syncs, its context joined as `contexts`. */
export function eligibleItem(selfId: string | null): SQL {
  return and(
    inArray(items.kind, ['action', 'question']),
    eq(items.ongoing, false),
    eq(items.status, 'open'),
    isNull(items.deletedAt),
    isNull(contexts.archivedAt),
    isNull(contexts.deletedAt),
    johnOwns(selfId),
  )!
}

/* A task Todoist deleted, or made recurring, is not made again for the same
   item; one retired after 30 days closed is. */
const BLOCKING = sql`(${itemTodoistLinks.state} <> 'unlinked' or ${itemTodoistLinks.unlinkedReason} in ('deleted', 'recurring'))`

/** Items that sync and have no task: the ones a pass makes tasks for. */
export async function itemsWithoutTask(
  exec: Executor,
  connectionId: string,
  selfId: string | null,
): Promise<(typeof items.$inferSelect)[]> {
  const rows = await exec
    .select({ item: items })
    .from(items)
    .innerJoin(contexts, eq(contexts.id, items.contextId))
    .where(
      and(
        eligibleItem(selfId),
        sql`not exists (select 1 from ${itemTodoistLinks} where ${itemTodoistLinks.itemId} = ${items.id} and ${itemTodoistLinks.connectionId} = ${connectionId} and ${BLOCKING})`,
      ),
    )
    .orderBy(items.createdAt)
  return rows.map((row) => row.item)
}

// ─── connecting ──────────────────────────────────────────────────────────────

/**
 * Store a completed sign-in, read every task, and set aside what was already
 * open: those items wait in Match rather than becoming tasks John may already
 * have.
 */
export async function connectTodoist(
  exec: Executor,
  tokens: TodoistTokens,
): Promise<{ connection: Connection; unmatched: number }> {
  const { connection, created } = await saveTodoistConnection(exec, tokens)
  await pull(exec, connection)
  if (!created) return { connection, unmatched: 0 }

  const self = await findSelf(exec)
  const open = await itemsWithoutTask(exec, connection.id, self?.id ?? null)
  if (open.length > 0) {
    await exec
      .insert(itemTodoistLinks)
      .values(open.map((item) => ({ connectionId: connection.id, itemId: item.id, state: 'unmatched' })))
      .onConflictDoNothing()
  }
  return { connection, unmatched: open.length }
}

// ─── 1. pull ─────────────────────────────────────────────────────────────────

function cacheRow(connectionId: string, task: TodoistTask) {
  return {
    connectionId,
    taskId: task.id,
    projectId: task.project_id ?? null,
    content: task.content,
    deadline: task.deadline?.date ?? null,
    checked: !!task.checked,
    isDeleted: !!task.is_deleted,
    isRecurring: !!task.due?.is_recurring,
    completedAt: task.completed_at ? new Date(task.completed_at) : null,
    seenAt: new Date(),
  }
}

export async function cacheTasks(exec: Executor, connectionId: string, tasks: TodoistTask[]) {
  for (let start = 0; start < tasks.length; start += 500) {
    const rows = tasks.slice(start, start + 500).map((task) => cacheRow(connectionId, task))
    await exec
      .insert(todoistTasks)
      .values(rows)
      .onConflictDoUpdate({
        target: [todoistTasks.connectionId, todoistTasks.taskId],
        set: {
          projectId: sql`excluded.project_id`,
          content: sql`excluded.content`,
          deadline: sql`excluded.deadline`,
          checked: sql`excluded.checked`,
          isDeleted: sql`excluded.is_deleted`,
          isRecurring: sql`excluded.is_recurring`,
          completedAt: sql`excluded.completed_at`,
          seenAt: sql`excluded.seen_at`,
        },
      })
  }
}

/** Read Todoist's change feed into the cache. Returns how many tasks it named. */
async function pull(exec: Executor, connection: Connection): Promise<number> {
  const response: SyncResponse = await withTodoist(exec, connection.id, (token) =>
    todoistSync(token, { syncToken: connection.cursor ?? '*' }),
  )
  const tasks = response.items ?? []

  /* A full answer to an incremental question (Todoist reset the feed) lists
     only open tasks: a linked task missing from it was closed or deleted in
     the meantime, so each is asked after by itself. */
  const missing: TodoistTask[] = []
  if (response.full_sync && connection.cursor) {
    const seen = new Set(tasks.map((task) => task.id))
    const linked = await exec
      .select({ taskId: itemTodoistLinks.taskId })
      .from(itemTodoistLinks)
      .where(
        and(
          eq(itemTodoistLinks.connectionId, connection.id),
          eq(itemTodoistLinks.state, 'linked'),
          isNotNull(itemTodoistLinks.taskId),
        ),
      )
    for (const { taskId } of linked) {
      if (seen.has(taskId!)) continue
      const task = await withTodoist(exec, connection.id, (token) => getTask(token, taskId!))
      missing.push(
        task ?? { id: taskId!, project_id: null, content: '', checked: true, is_deleted: true },
      )
    }
  }

  await inTransaction(exec, async (tx) => {
    await cacheTasks(tx, connection.id, tasks)
    /* A deleted task reported by itself carries no content worth keeping. */
    for (const task of missing) {
      if (task.is_deleted) {
        await tx
          .update(todoistTasks)
          .set({ isDeleted: true, seenAt: new Date() })
          .where(and(eq(todoistTasks.connectionId, connection.id), eq(todoistTasks.taskId, task.id)))
      } else {
        await cacheTasks(tx, connection.id, [task])
      }
    }
    await tx
      .update(connections)
      .set({ cursor: response.sync_token })
      .where(eq(connections.id, connection.id))
  })
  return tasks.length
}

// ─── 2 and 3. plan ───────────────────────────────────────────────────────────

/** One link's share of a pass: its commands, and what to write once they are accepted. */
type Plan = {
  linkId: string
  itemId: string | null
  kind: string | null
  commands: Command[]
  itemOps: ItemOp[]
  base: Base
  closedAt: Date | null
  unlink: UnlinkReason | null
  /** For a task being made: the temp id Todoist maps to the real one. */
  tempId?: string
  /** What the cache should hold once Todoist has accepted the commands. */
  cache: { content: string; deadline: string | null; checked: boolean; projectId?: string | null }
}

function toCommand(taskId: string, command: TaskCommand): Command {
  const args = 'args' in command ? { id: taskId, ...command.args } : { id: taskId }
  return { type: command.type, uuid: randomUUID(), args }
}

async function planMerges(exec: Executor, connectionId: string, selfId: string | null, now: Date) {
  const rows = await exec
    .select({
      link: itemTodoistLinks,
      item: items,
      contextLive: sql<boolean>`${contexts.archivedAt} is null and ${contexts.deletedAt} is null`,
      johnOwns: johnOwns(selfId),
      eligible: sql<boolean>`coalesce(${eligibleItem(selfId)}, false)`,
      task: todoistTasks,
    })
    .from(itemTodoistLinks)
    .leftJoin(items, eq(items.id, itemTodoistLinks.itemId))
    .leftJoin(contexts, eq(contexts.id, items.contextId))
    .leftJoin(
      todoistTasks,
      and(
        eq(todoistTasks.connectionId, itemTodoistLinks.connectionId),
        eq(todoistTasks.taskId, itemTodoistLinks.taskId),
      ),
    )
    .where(
      and(
        eq(itemTodoistLinks.connectionId, connectionId),
        eq(itemTodoistLinks.state, 'linked'),
      ),
    )

  const plans: Plan[] = []
  for (const { link, item, contextLive, johnOwns: owns, eligible, task } of rows) {
    // A paused context reads and writes nothing (docs/SPEC.md, item 9).
    if (item && !contextLive) continue

    const base: Base = {
      text: link.baseText ?? '',
      dueOn: link.baseDueOn,
      closed: link.baseClosed,
    }
    const result = mergeLink({
      base,
      item: item
        ? {
            kind: item.kind,
            status: item.status,
            text: item.text,
            dueOn: item.dueOn,
            deleted: item.deletedAt !== null,
            johnOwns: owns,
            eligible,
          }
        : null,
      task: task
        ? {
            text: task.content,
            dueOn: task.deadline,
            checked: task.checked,
            deleted: task.isDeleted,
            recurring: task.isRecurring,
          }
        : null,
      closedAt: link.closedAt,
      now,
    })

    const nothing =
      result.itemOps.length === 0 &&
      result.commands.length === 0 &&
      !result.unlink &&
      result.base.text === base.text &&
      result.base.dueOn === base.dueOn &&
      result.base.closed === base.closed &&
      (result.closedAt?.getTime() ?? null) === (link.closedAt?.getTime() ?? null)
    if (nothing) continue

    plans.push({
      linkId: link.id,
      itemId: item?.id ?? null,
      kind: item?.kind ?? null,
      commands: result.commands.map((command) => toCommand(link.taskId!, command)),
      itemOps: result.itemOps,
      base: result.base,
      closedAt: result.closedAt,
      unlink: result.unlink,
      cache: { content: result.base.text, deadline: result.base.dueOn, checked: result.base.closed },
    })
  }
  return plans
}

async function timeZone(exec: Executor): Promise<string | null> {
  const [user] = await exec.select({ timeZone: users.timeZone }).from(users).limit(1)
  return user?.timeZone ?? null
}

/**
 * Tasks to make: a `pending` link for each item that newly syncs, written
 * before anything is sent, and any pending link a past pass left unfinished.
 */
async function planCreates(
  exec: Executor,
  connectionId: string,
  selfId: string | null,
  now: Date,
): Promise<Plan[]> {
  for (const item of await itemsWithoutTask(exec, connectionId, selfId)) {
    await exec
      .insert(itemTodoistLinks)
      .values({
        connectionId,
        itemId: item.id,
        state: 'pending',
        commandUuid: randomUUID(),
        tempId: randomUUID(),
        baseText: item.text,
        baseDueOn: item.dueOn,
        baseClosed: false,
      })
      .onConflictDoNothing()
  }

  const pending = await exec
    .select({ link: itemTodoistLinks, item: items })
    .from(itemTodoistLinks)
    .innerJoin(items, eq(items.id, itemTodoistLinks.itemId))
    .where(and(eq(itemTodoistLinks.connectionId, connectionId), eq(itemTodoistLinks.state, 'pending')))

  /* The scheduled date: the day it is made, on John's clock, so it shows in
     Todoist's Today for triage. Never read or written again. */
  const today = todayIn(await timeZone(exec), now)
  const plans: Plan[] = []
  for (const { link, item } of pending) {
    const projectId = link.lastError ? null : await todoistProjectFor(exec, connectionId, item)
    const args: Record<string, unknown> = {
      content: link.baseText ?? item.text,
      description: `[Meeting Manager](${absoluteUrl(`/items/${item.id}`)})`,
      ...(projectId ? { project_id: projectId } : {}),
      ...(link.baseDueOn ? { deadline: { date: link.baseDueOn } } : {}),
      /* Parked: no date to land it in Today; it comes back by its deadline. */
      ...(item.parkedAt ? {} : { due: { date: today } }),
    }
    plans.push({
      linkId: link.id,
      itemId: item.id,
      kind: item.kind,
      commands: [{ type: 'item_add', uuid: link.commandUuid!, temp_id: link.tempId!, args }],
      itemOps: [],
      base: { text: link.baseText ?? item.text, dueOn: link.baseDueOn, closed: false },
      closedAt: null,
      unlink: null,
      tempId: link.tempId!,
      cache: {
        content: link.baseText ?? item.text,
        deadline: link.baseDueOn,
        checked: false,
        projectId,
      },
    })
  }
  return plans
}

// ─── 4. push ─────────────────────────────────────────────────────────────────

async function applyItemOps(tx: Executor, actor: ActorContext, itemId: string, ops: ItemOp[]) {
  for (const op of ops) {
    if (op.op === 'edit') {
      await updateItem(tx, actor, itemId, {
        ...(op.text !== undefined ? { text: op.text } : {}),
        ...(op.dueOn !== undefined ? { dueOn: op.dueOn } : {}),
      })
    } else if (op.op === 'complete') {
      await completeItem(tx, actor, itemId)
    } else if (op.op === 'needsAnswer') {
      await markNeedsAnswer(tx, actor, itemId)
    } else {
      await reopenItem(tx, actor, itemId)
    }
  }
}

function describe(status: unknown): string {
  if (status && typeof status === 'object' && 'error' in status) {
    return String((status as { error?: string }).error ?? 'Refused')
  }
  return 'Refused'
}

/** Write what Todoist accepted. A link with a refused command keeps its old base. */
async function settle(
  exec: Executor,
  connectionId: string,
  plan: Plan,
  response: SyncResponse | null,
  actor: ActorContext,
): Promise<'ok' | 'failed'> {
  const refused = plan.commands
    .map((command) => response?.sync_status?.[command.uuid])
    .find((status) => status !== 'ok')
  if (plan.commands.length > 0 && (refused !== undefined || !response)) {
    /* A task Todoist said no to was not made, so the next try is a new
       command (and goes to the Inbox, in case its project was the trouble).
       One that got no answer keeps its uuid: it may have been made. */
    const remake = plan.tempId && response && refused !== undefined
    await exec
      .update(itemTodoistLinks)
      .set({
        lastError: (response ? describe(refused) : 'Todoist could not be reached.').slice(0, 500),
        ...(remake ? { commandUuid: randomUUID() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(itemTodoistLinks.id, plan.linkId))
    return 'failed'
  }

  const taskId = plan.tempId ? response?.temp_id_mapping?.[plan.tempId] : undefined
  if (plan.tempId && !taskId) {
    await exec
      .update(itemTodoistLinks)
      .set({ lastError: 'Todoist did not say which task it made.', updatedAt: new Date() })
      .where(eq(itemTodoistLinks.id, plan.linkId))
    return 'failed'
  }

  try {
    await inTransaction(exec, async (tx) => {
      if (plan.itemId && plan.itemOps.length > 0) await applyItemOps(tx, actor, plan.itemId, plan.itemOps)

      await tx
        .update(itemTodoistLinks)
        .set({
          ...(taskId ? { taskId, state: 'linked' } : {}),
          ...(plan.unlink ? { state: 'unlinked', unlinkedReason: plan.unlink } : {}),
          baseText: plan.base.text,
          baseDueOn: plan.base.dueOn,
          baseClosed: plan.base.closed,
          closedAt: plan.closedAt,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(itemTodoistLinks.id, plan.linkId))

      /* The cache says what Todoist now holds, so the next merge does not
         read the old value as a change made there. */
      const id = taskId ?? (await linkTask(tx, plan.linkId))
      if (id && plan.commands.length > 0 && !plan.unlink) {
        await tx
          .insert(todoistTasks)
          .values({
            connectionId,
            taskId: id,
            projectId: plan.cache.projectId ?? null,
            content: plan.cache.content,
            deadline: plan.cache.deadline,
            checked: plan.cache.checked,
          })
          .onConflictDoUpdate({
            target: [todoistTasks.connectionId, todoistTasks.taskId],
            set: {
              content: plan.cache.content,
              deadline: plan.cache.deadline,
              checked: plan.cache.checked,
              seenAt: new Date(),
            },
          })
      }
    })
  } catch (err) {
    /* An item that refuses what Todoist says (a blank title): the link is
       left as it was and says why. */
    if (!(err instanceof AppError)) throw err
    await exec
      .update(itemTodoistLinks)
      .set({ lastError: err.message.slice(0, 500), updatedAt: new Date() })
      .where(eq(itemTodoistLinks.id, plan.linkId))
    return 'failed'
  }
  return 'ok'
}

async function linkTask(exec: Executor, linkId: string): Promise<string | null> {
  const [row] = await exec
    .select({ taskId: itemTodoistLinks.taskId })
    .from(itemTodoistLinks)
    .where(eq(itemTodoistLinks.id, linkId))
  return row?.taskId ?? null
}

// ─── the pass ────────────────────────────────────────────────────────────────

export type SyncResult = {
  pulled: number
  created: number
  updated: number
  failed: number
}

export async function syncTodoist(exec: Executor, now: Date = new Date()): Promise<SyncResult | null> {
  const connection = await todoistConnection(exec)
  if (!connection) return null

  const pulled = await pull(exec, connection)
  const self = await findSelf(exec)
  const selfId = self?.id ?? null

  const merges = await planMerges(exec, connection.id, selfId, now)
  const creates = await planCreates(exec, connection.id, selfId, now)
  const plans = [...merges, ...creates]

  const responses = new Map<string, SyncResponse | null>()
  const sending = plans.filter((plan) => plan.commands.length > 0)
  for (let start = 0; start < sending.length; ) {
    const batch: Plan[] = []
    let count = 0
    while (start < sending.length && count + sending[start]!.commands.length <= MAX_COMMANDS) {
      count += sending[start]!.commands.length
      batch.push(sending[start]!)
      start++
    }
    let response: SyncResponse | null = null
    try {
      response = await withTodoist(exec, connection.id, (token) =>
        todoistSync(token, { commands: batch.flatMap((plan) => plan.commands) }),
      )
    } catch (err) {
      console.error('[todoist] push failed:', err)
    }
    for (const plan of batch) responses.set(plan.linkId, response)
  }

  const actor = todoistActor()
  const result: SyncResult = { pulled, created: 0, updated: 0, failed: 0 }
  for (const plan of plans) {
    const outcome = await settle(exec, connection.id, plan, responses.get(plan.linkId) ?? null, actor)
    if (outcome === 'failed') result.failed++
    else if (plan.tempId) result.created++
    else result.updated++
  }
  return result
}

export function summariseSync(result: SyncResult | null): string {
  if (!result) return 'Not connected.'
  const parts = [`${result.pulled} read`]
  if (result.created) parts.push(`${result.created} made`)
  if (result.updated) parts.push(`${result.updated} merged`)
  if (result.failed) parts.push(`${result.failed} failed`)
  return parts.join(' · ')
}
