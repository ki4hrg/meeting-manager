/*
 * "I owe" and "Waiting on" by horizon (docs/SPEC.md, item 9).
 *
 * What is due soon (or overdue) comes first, soonest first; then what has no
 * deadline; then what is due further out. An item parked for later leaves the
 * list until its day comes, or, parked with no day, until it is brought back.
 * A deadline coming close brings a parked item back regardless, so a deadline
 * is never hidden.
 */

import { addDays } from '../core/dates'
import type { ItemView } from './items'

/** How close a deadline is "soon": what leads the list, and what ends parking. */
export const SOON_DAYS = 14

type Dated = Pick<ItemView, 'dueOn' | 'parkedAt' | 'laterOn'>

function dueSoon(item: Dated, today: string): boolean {
  return item.dueOn !== null && item.dueOn <= addDays(today, SOON_DAYS)
}

/** Parked, and neither its day nor its deadline has come. */
export function isLater(item: Dated, today: string): boolean {
  if (!item.parkedAt) return false
  if (item.laterOn !== null && item.laterOn <= today) return false
  return !dueSoon(item, today)
}

/** Soon first, then undated, then further out. Stable within each band. */
export function byHorizon<T extends Dated>(items: T[], today: string): T[] {
  const band = (item: T) => (dueSoon(item, today) ? 0 : item.dueOn === null ? 1 : 2)
  const byDue = (a: T, b: T) => (a.dueOn ?? '').localeCompare(b.dueOn ?? '')
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => band(a.item) - band(b.item) || byDue(a.item, b.item) || a.index - b.index)
    .map(({ item }) => item)
}

/** A list split into what is on it now, by horizon, and what waits for later, soonest back first. */
export function splitLater<T extends Dated>(items: T[], today: string): { now: T[]; later: T[] } {
  const now = items.filter((item) => !isLater(item, today))
  const later = items
    .filter((item) => isLater(item, today))
    .sort((a, b) => (a.laterOn ?? '9999').localeCompare(b.laterOn ?? '9999'))
  return { now: byHorizon(now, today), later }
}
