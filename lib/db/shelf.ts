/*
 * Which rows a query sees, by their archive and delete marks (`shelved` and
 * `deletable` in schema.ts).
 *
 *   live      neither archived nor deleted: lists, pickers, name lookups
 *   archived  archived and not deleted: the collapsed "Archived" sections
 *   all       anything not deleted: what still reads an archived row
 */

import { and, isNotNull, isNull, type SQL } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'

export type Shelf = 'live' | 'archived' | 'all'

type Shelved = { archivedAt: PgColumn; deletedAt: PgColumn }

export function onShelf(table: Shelved, shelf: Shelf = 'live'): SQL {
  if (shelf === 'all') return isNull(table.deletedAt)
  if (shelf === 'archived') return and(isNotNull(table.archivedAt), isNull(table.deletedAt))!
  return and(isNull(table.archivedAt), isNull(table.deletedAt))!
}

export function notDeleted(table: { deletedAt: PgColumn }): SQL {
  return isNull(table.deletedAt)
}

/** " (archived)" or " (deleted)", for a refusal that names a row the lists no longer show. */
export function shelvedNote(row: { archivedAt?: Date | null; deletedAt?: Date | null }): string {
  if (row.deletedAt) return ' (deleted; restore it from Settings)'
  if (row.archivedAt) return ' (archived)'
  return ''
}
