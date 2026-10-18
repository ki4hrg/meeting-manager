/*
 * The three-way merge between an item and its Todoist task (docs/SPEC.md,
 * "Todoist sync"). Pure: what each side holds and what they last agreed on go
 * in, and what to change on each side comes out. `sync.ts` does the reading
 * and writing.
 *
 * Three fields are shared: the text, the deadline (`due_on`, Todoist's
 * `deadline`), and whether it is closed. Each is compared with the base on
 * both sides. One side changed: it is copied to the other. Both changed:
 * Todoist wins. Todoist's scheduled date is the tool's to set once, at
 * creation, and is never read.
 *
 * "Closed" on the item's side means it no longer syncs: done, dropped,
 * answered or waiting for its answer, converted to a topic, or John no longer
 * an owner. Closing the task in Todoist closes an action and moves a question
 * to "needs answer". Reopening it within 30 days reopens the item; after that
 * the link is retired, and an item reopened later gets a new task.
 */

import type { ItemKind, ItemStatus } from '../../items/items'

/** What both sides last agreed on. */
export type Base = { text: string; dueOn: string | null; closed: boolean }

export type ItemSide = {
  kind: ItemKind
  status: ItemStatus
  text: string
  dueOn: string | null
  deleted: boolean
  /** John's own person row is an owner. */
  johnOwns: boolean
  /** Syncs now: an open action or question John owns, in a live context. */
  eligible: boolean
}

export type TaskSide = {
  text: string
  dueOn: string | null
  checked: boolean
  deleted: boolean
  recurring: boolean
}

export type ItemOp =
  | { op: 'edit'; text?: string; dueOn?: string | null }
  | { op: 'complete' }
  | { op: 'needsAnswer' }
  | { op: 'reopen' }

export type TaskCommand =
  | { type: 'item_update'; args: { content?: string; deadline?: { date: string } | null } }
  | { type: 'item_close' }
  | { type: 'item_uncomplete' }
  | { type: 'item_delete' }

export type UnlinkReason = 'deleted' | 'recurring' | 'expired' | 'item_removed'

export type MergeResult = {
  itemOps: ItemOp[]
  commands: TaskCommand[]
  base: Base
  closedAt: Date | null
  unlink: UnlinkReason | null
}

/** How long a closed pair still listens for a reopen. */
export const REOPEN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

const REOPENABLE: ItemStatus[] = ['done', 'dropped', 'needs_answer']

export function mergeLink(input: {
  base: Base
  /** Null: the item was removed outright (an accept undone). */
  item: ItemSide | null
  /** Null: Todoist has not reported the task yet. */
  task: TaskSide | null
  closedAt: Date | null
  now: Date
}): MergeResult {
  const { base, item, task, now } = input
  const unchanged = (unlink: UnlinkReason | null = null, commands: TaskCommand[] = []): MergeResult => ({
    itemOps: [],
    commands,
    base,
    closedAt: input.closedAt,
    unlink,
  })

  if (!item) {
    /* Made in error: an open task goes with it. A closed one is history. */
    const open = task ? !task.checked && !task.deleted : !base.closed
    return unchanged('item_removed', open ? [{ type: 'item_delete' }] : [])
  }
  if (!task) return unchanged()
  if (task.deleted) return unchanged('deleted')
  if (task.recurring) return unchanged('recurring')

  if (
    base.closed &&
    input.closedAt &&
    now.getTime() - input.closedAt.getTime() > REOPEN_WINDOW_MS
  ) {
    return unchanged('expired')
  }

  const itemOps: ItemOp[] = []
  const commands: TaskCommand[] = []
  const next: Base = { ...base }
  const update: { content?: string; deadline?: { date: string } | null } = {}
  const edit: { text?: string; dueOn?: string | null } = {}

  if (task.text !== base.text) {
    if (item.text !== task.text) edit.text = task.text
    next.text = task.text
  } else if (item.text !== base.text) {
    update.content = item.text
    next.text = item.text
  }

  if (task.dueOn !== base.dueOn) {
    if (item.dueOn !== task.dueOn) edit.dueOn = task.dueOn
    next.dueOn = task.dueOn
  } else if (item.dueOn !== base.dueOn) {
    update.deadline = item.dueOn ? { date: item.dueOn } : null
    next.dueOn = item.dueOn
  }

  if (Object.keys(edit).length > 0) itemOps.push({ op: 'edit', ...edit })
  if (Object.keys(update).length > 0) commands.push({ type: 'item_update', args: update })

  const itemClosed = !item.eligible
  const taskClosed = task.checked
  if (taskClosed !== base.closed) {
    if (taskClosed) {
      if (!itemClosed) itemOps.push({ op: item.kind === 'question' ? 'needsAnswer' : 'complete' })
      next.closed = true
    } else if (!itemClosed) {
      next.closed = false
    } else if (
      !item.deleted &&
      item.johnOwns &&
      (item.kind === 'action' || item.kind === 'question') &&
      REOPENABLE.includes(item.status)
    ) {
      itemOps.push({ op: 'reopen' })
      next.closed = false
    } else {
      /* Reopened in Todoist, but what closed it here was not Todoist's to
         undo (John no longer owns it, it became a topic): close it again. */
      commands.push({ type: 'item_close' })
      next.closed = true
    }
  } else if (itemClosed !== base.closed) {
    commands.push({ type: itemClosed ? 'item_close' : 'item_uncomplete' })
    next.closed = itemClosed
  }

  const closedAt = next.closed ? (base.closed ? (input.closedAt ?? now) : now) : null
  return { itemOps, commands, base: next, closedAt, unlink: null }
}
