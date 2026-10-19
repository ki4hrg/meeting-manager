/*
 * Comments on linked tasks (Todoist's "notes"), read one way: Todoist → here.
 *
 * John's daily review in Todoist logs status updates as comments; the item
 * page shows them in its history. Only a task with a link to an item keeps
 * its comments; a comment deleted in Todoist is deleted here. They live in
 * `todoist_comments`, never in `item_events`, so an accept's undo still sees
 * exactly the history accepting made.
 *
 * The change feed carries comments made after a task was linked. A link to a
 * task John already had (Match, or any link from before comments were read)
 * has `comments_read_at` null, and the next pass reads that task's comments
 * whole (`readLinkedComments`), a few tasks a pass.
 */

import { and, asc, eq, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm'
import { inTransaction, type Executor } from '../../core/types'
import { itemTodoistLinks, todoistComments } from '../../db/schema'
import { listComments, TodoistApiError, type TodoistNote } from './client'
import { withTodoist } from './connection'

/** Keep what the change feed said about comments: new and edited on linked tasks, deleted anywhere. */
export async function cacheComments(exec: Executor, connectionId: string, notes: TodoistNote[]): Promise<void> {
  if (notes.length === 0) return

  const gone = notes.filter((note) => note.is_deleted).map((note) => note.id)
  for (let start = 0; start < gone.length; start += 500) {
    await exec
      .delete(todoistComments)
      .where(
        and(
          eq(todoistComments.connectionId, connectionId),
          inArray(todoistComments.commentId, gone.slice(start, start + 500)),
        ),
      )
  }

  const live = notes.filter((note) => !note.is_deleted && note.item_id)
  if (live.length === 0) return
  const taskIds = [...new Set(live.map((note) => note.item_id))]
  const linked = new Set<string>()
  for (let start = 0; start < taskIds.length; start += 500) {
    const rows = await exec
      .select({ taskId: itemTodoistLinks.taskId })
      .from(itemTodoistLinks)
      .where(
        and(
          eq(itemTodoistLinks.connectionId, connectionId),
          isNotNull(itemTodoistLinks.itemId),
          inArray(itemTodoistLinks.taskId, taskIds.slice(start, start + 500)),
        ),
      )
    for (const row of rows) linked.add(row.taskId!)
  }

  await upsertComments(
    exec,
    connectionId,
    live.filter((note) => linked.has(note.item_id)),
  )
}

async function upsertComments(exec: Executor, connectionId: string, notes: TodoistNote[]): Promise<void> {
  const rows = notes.map((note) => ({
    connectionId,
    commentId: note.id,
    taskId: note.item_id,
    content: note.content ?? '',
    postedAt: note.posted_at ? new Date(note.posted_at) : new Date(),
    seenAt: new Date(),
  }))
  for (let start = 0; start < rows.length; start += 500) {
    await exec
      .insert(todoistComments)
      .values(rows.slice(start, start + 500))
      .onConflictDoUpdate({
        target: [todoistComments.connectionId, todoistComments.commentId],
        set: {
          taskId: sql`excluded.task_id`,
          content: sql`excluded.content`,
          postedAt: sql`excluded.posted_at`,
          seenAt: sql`excluded.seen_at`,
        },
      })
  }
}

/** At most this many tasks have their comments read in one pass; the rest wait for the next. */
export const COMMENT_READS_PER_PASS = 50

/**
 * Read whole the comments of linked tasks not read yet: what was there before
 * the link, or before comments were read at all. Returns how many tasks.
 */
export async function readLinkedComments(
  exec: Executor,
  connectionId: string,
  limit = COMMENT_READS_PER_PASS,
): Promise<number> {
  const links = await exec
    .select({ id: itemTodoistLinks.id, taskId: itemTodoistLinks.taskId })
    .from(itemTodoistLinks)
    .where(
      and(
        eq(itemTodoistLinks.connectionId, connectionId),
        eq(itemTodoistLinks.state, 'linked'),
        isNotNull(itemTodoistLinks.itemId),
        isNotNull(itemTodoistLinks.taskId),
        isNull(itemTodoistLinks.commentsReadAt),
      ),
    )
    .orderBy(asc(itemTodoistLinks.createdAt))
    .limit(limit)

  let read = 0
  for (const link of links) {
    let notes: TodoistNote[]
    try {
      notes = await withTodoist(exec, connectionId, (token) => listComments(token, link.taskId!))
    } catch (err) {
      /* Todoist busy or down: the rest wait for the next pass. */
      if (err instanceof TodoistApiError && err.retryable) break
      throw err
    }
    await inTransaction(exec, async (tx) => {
      const ids = notes.map((note) => note.id)
      await tx
        .delete(todoistComments)
        .where(
          and(
            eq(todoistComments.connectionId, connectionId),
            eq(todoistComments.taskId, link.taskId!),
            ...(ids.length > 0 ? [notInArray(todoistComments.commentId, ids)] : []),
          ),
        )
      await upsertComments(tx, connectionId, notes)
      await tx.update(itemTodoistLinks).set({ commentsReadAt: new Date() }).where(eq(itemTodoistLinks.id, link.id))
    })
    read++
  }
  return read
}

export type ItemComment = { id: string; content: string; postedAt: Date }

/** The comments on an item's Todoist task, oldest first. */
export async function itemComments(exec: Executor, itemId: string): Promise<ItemComment[]> {
  return exec
    .select({ id: todoistComments.commentId, content: todoistComments.content, postedAt: todoistComments.postedAt })
    .from(todoistComments)
    .innerJoin(
      itemTodoistLinks,
      and(
        eq(itemTodoistLinks.connectionId, todoistComments.connectionId),
        eq(itemTodoistLinks.taskId, todoistComments.taskId),
      ),
    )
    .where(eq(itemTodoistLinks.itemId, itemId))
    .orderBy(asc(todoistComments.postedAt))
}
