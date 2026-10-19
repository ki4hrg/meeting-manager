/*
 * Comments on linked tasks (Todoist's "notes"), read one way: Todoist → here.
 *
 * John's daily review in Todoist logs status updates as comments; the item
 * page shows them in its history. Only a task with a link to an item keeps
 * its comments; a comment deleted in Todoist is deleted here. They live in
 * `todoist_comments`, never in `item_events`, so an accept's undo still sees
 * exactly the history accepting made.
 */

import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { Executor } from '../../core/types'
import { itemTodoistLinks, todoistComments } from '../../db/schema'
import type { TodoistNote } from './client'

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

  const rows = live
    .filter((note) => linked.has(note.item_id))
    .map((note) => ({
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
