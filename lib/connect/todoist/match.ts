/*
 * Matching items to tasks John already has.
 *
 * When Todoist is connected, the items already open are set aside
 * (`unmatched`) rather than sent: he may have a task for them already. Each
 * one is linked to a task he picks, sent as a new task, or skipped. Any item
 * that syncs and has no task can be linked the same way from its own page.
 *
 * Linking takes the task's text and deadline: the link's base is set to the
 * item, so the next pass reads the task's side as the change and Todoist
 * wins, as it does any conflict. The task stays in its own project.
 */

import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import { NotFoundError, ValidationError, inTransaction, type Executor } from '../../core/types'
import { contexts, items, itemTodoistLinks, todoistTasks } from '../../db/schema'
import { findSelf } from '../../directory/people'
import { taskUrl } from './client'
import { todoistConnection } from './connection'
import { eligibleItem } from './sync'

export type TaskChoice = { id: string; content: string; deadline: string | null; score: number }

export type ItemTodoist =
  | { state: 'linked'; taskId: string; url: string; error: string | null }
  | { state: 'pending' }
  /** Syncs, but has no task: link one or send it. `unmatched` is waiting in Settings → Match. */
  | { state: 'none' | 'unmatched' | 'skipped' }
  | null

/** Where an item stands with Todoist; null when it does not sync or Todoist is not connected. */
export async function itemTodoist(exec: Executor, itemId: string): Promise<ItemTodoist> {
  const connection = await todoistConnection(exec)
  if (!connection) return null

  const [link] = await exec
    .select()
    .from(itemTodoistLinks)
    .where(
      and(
        eq(itemTodoistLinks.connectionId, connection.id),
        eq(itemTodoistLinks.itemId, itemId),
        ne(itemTodoistLinks.state, 'unlinked'),
      ),
    )
    .limit(1)
  if (link?.state === 'linked' && link.taskId) {
    return { state: 'linked', taskId: link.taskId, url: taskUrl(link.taskId), error: link.lastError }
  }
  if (link?.state === 'pending') return { state: 'pending' }
  if (!(await syncs(exec, itemId))) return null
  if (link?.state === 'unmatched' || link?.state === 'skipped') return { state: link.state }
  return { state: 'none' }
}

async function syncs(exec: Executor, itemId: string): Promise<boolean> {
  const self = await findSelf(exec)
  const [row] = await exec
    .select({ id: items.id })
    .from(items)
    .innerJoin(contexts, eq(contexts.id, items.contextId))
    .where(and(eq(items.id, itemId), eligibleItem(self?.id ?? null)))
    .limit(1)
  return !!row
}

/** The items waiting in Match: open when Todoist was connected, still syncing, not yet settled. */
export async function unmatchedItemIds(exec: Executor): Promise<string[]> {
  const connection = await todoistConnection(exec)
  if (!connection) return []
  const self = await findSelf(exec)
  const rows = await exec
    .select({ id: items.id })
    .from(itemTodoistLinks)
    .innerJoin(items, eq(items.id, itemTodoistLinks.itemId))
    .innerJoin(contexts, eq(contexts.id, items.contextId))
    .where(
      and(
        eq(itemTodoistLinks.connectionId, connection.id),
        eq(itemTodoistLinks.state, 'unmatched'),
        eligibleItem(self?.id ?? null),
      ),
    )
    .orderBy(items.createdAt)
  return rows.map((row) => row.id)
}

// ─── suggestions ─────────────────────────────────────────────────────────────

const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'about', 'that', 'this', 'into', 'onto', 'our',
  'your', 'their', 'are', 'was', 'will', 'can', 'what', 'when', 'who', 'how', 'why',
])

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 2 && !STOP.has(word)),
  )
}

/** How alike two texts are, by the words they share: 0 to 1. */
export function likeness(a: string, b: string): number {
  const left = words(a)
  const right = words(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const word of left) if (right.has(word)) shared++
  return shared / Math.min(left.size, right.size) / (1 + Math.abs(left.size - right.size) / 10)
}

/** Open tasks no item is linked to: what an item can be linked to. */
export async function openTasks(exec: Executor): Promise<Omit<TaskChoice, 'score'>[]> {
  const connection = await todoistConnection(exec)
  if (!connection) return []
  return exec
    .select({ id: todoistTasks.taskId, content: todoistTasks.content, deadline: todoistTasks.deadline })
    .from(todoistTasks)
    .where(
      and(
        eq(todoistTasks.connectionId, connection.id),
        eq(todoistTasks.checked, false),
        eq(todoistTasks.isDeleted, false),
        eq(todoistTasks.isRecurring, false),
        sql`not exists (select 1 from ${itemTodoistLinks} where ${itemTodoistLinks.connectionId} = ${connection.id} and ${itemTodoistLinks.taskId} = ${todoistTasks.taskId} and ${itemTodoistLinks.state} in ('linked', 'pending'))`,
      ),
    )
}

/** The tasks, the most like `text` first. */
export function rankTasks(text: string, tasks: Omit<TaskChoice, 'score'>[]): TaskChoice[] {
  return tasks
    .map((task) => ({ ...task, score: likeness(text, task.content) }))
    .sort((a, b) => b.score - a.score || a.content.localeCompare(b.content))
}

// ─── settling ────────────────────────────────────────────────────────────────

async function requireConnection(exec: Executor) {
  const connection = await todoistConnection(exec)
  if (!connection) throw new ValidationError('Todoist is not connected.')
  return connection
}

async function requireSyncing(exec: Executor, itemId: string) {
  const [item] = await exec.select().from(items).where(eq(items.id, itemId)).limit(1)
  if (!item) throw new NotFoundError('Item', itemId)
  if (!(await syncs(exec, itemId))) {
    throw new ValidationError('Only an open action or question you own goes to Todoist.')
  }
  return item
}

/* A task id, or a link to it as Todoist's apps copy it. */
function taskIdOf(value: string): string {
  const trimmed = value.trim()
  const fromUrl = trimmed.match(/\/task\/(?:[^/?#]*-)?([A-Za-z0-9]+)(?:[/?#]|$)/)
  return fromUrl?.[1] ?? trimmed
}

/** Link an item to a task John already has. */
export async function linkItem(exec: Executor, input: { itemId: string; task: string }): Promise<void> {
  const connection = await requireConnection(exec)
  const taskId = taskIdOf(input.task)
  if (taskId === '') throw new ValidationError('Pick a task.')

  await inTransaction(exec, async (tx) => {
    const item = await requireSyncing(tx, input.itemId)
    const [task] = await tx
      .select()
      .from(todoistTasks)
      .where(and(eq(todoistTasks.connectionId, connection.id), eq(todoistTasks.taskId, taskId)))
      .limit(1)
    if (!task || task.isDeleted) throw new ValidationError('Todoist has no such task.')
    if (task.checked) throw new ValidationError('That task is completed. Reopen it in Todoist first.')
    if (task.isRecurring) throw new ValidationError('A recurring task cannot be linked.')

    const [taken] = await tx
      .select({ itemId: itemTodoistLinks.itemId })
      .from(itemTodoistLinks)
      .where(
        and(
          eq(itemTodoistLinks.connectionId, connection.id),
          eq(itemTodoistLinks.taskId, taskId),
          inArray(itemTodoistLinks.state, ['linked', 'pending']),
        ),
      )
      .limit(1)
    if (taken) throw new ValidationError('That task is already linked to another item.')

    /* What stood before goes: the item's settled row, and any retired row
       holding this task. */
    await tx
      .delete(itemTodoistLinks)
      .where(
        and(
          eq(itemTodoistLinks.connectionId, connection.id),
          sql`(${itemTodoistLinks.itemId} = ${item.id} and ${itemTodoistLinks.state} in ('unmatched', 'skipped'))
            or (${itemTodoistLinks.taskId} = ${taskId} and ${itemTodoistLinks.state} = 'unlinked')`,
        ),
      )
    await tx.insert(itemTodoistLinks).values({
      connectionId: connection.id,
      itemId: item.id,
      taskId,
      state: 'linked',
      baseText: item.text,
      baseDueOn: item.dueOn,
      baseClosed: false,
    })
  })
}

/**
 * Send an item as a new task on the next pass: its settled row is removed,
 * and a task Todoist deleted no longer stands in the way.
 */
export async function sendItem(exec: Executor, itemId: string): Promise<void> {
  const connection = await requireConnection(exec)
  await requireSyncing(exec, itemId)
  await exec
    .delete(itemTodoistLinks)
    .where(
      and(
        eq(itemTodoistLinks.connectionId, connection.id),
        eq(itemTodoistLinks.itemId, itemId),
        inArray(itemTodoistLinks.state, ['unmatched', 'skipped']),
      ),
    )
  await exec
    .update(itemTodoistLinks)
    .set({ unlinkedReason: 'sent_again', updatedAt: new Date() })
    .where(
      and(
        eq(itemTodoistLinks.connectionId, connection.id),
        eq(itemTodoistLinks.itemId, itemId),
        eq(itemTodoistLinks.state, 'unlinked'),
      ),
    )
}

/** Never sync this item. Linking it or sending it later still works. */
export async function skipItem(exec: Executor, itemId: string): Promise<void> {
  const connection = await requireConnection(exec)
  const [link] = await exec
    .select()
    .from(itemTodoistLinks)
    .where(
      and(
        eq(itemTodoistLinks.connectionId, connection.id),
        eq(itemTodoistLinks.itemId, itemId),
        ne(itemTodoistLinks.state, 'unlinked'),
      ),
    )
    .limit(1)
  if (link && link.state !== 'unmatched') {
    if (link.state === 'skipped') return
    throw new ValidationError('This item already has a task.')
  }
  if (link) {
    await exec
      .update(itemTodoistLinks)
      .set({ state: 'skipped', updatedAt: new Date() })
      .where(eq(itemTodoistLinks.id, link.id))
  } else {
    await exec.insert(itemTodoistLinks).values({ connectionId: connection.id, itemId, state: 'skipped' })
  }
}
