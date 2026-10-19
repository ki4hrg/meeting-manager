/*
 * "I owe" and "Waiting on" by horizon (docs/SPEC.md, item 9).
 *
 * What is due soon (or overdue) is on the list, soonest first. Everything else
 * waits in Later: what is due further out, what has no deadline, and what was
 * parked. A parked item comes back on its day, or, parked with no day, when it
 * is brought back. A deadline coming close brings anything back regardless, so
 * a deadline is never hidden.
 */

import { addDays } from '../core/dates'
import { isOpen, type ItemView } from './items'

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

/**
 * A list split into what is on it now (due soon, or parked and back on its
 * day), by horizon, and what waits in Later: what is due further out and
 * what was parked till a day, soonest first, then the undated, then what was
 * parked with no day.
 */
export function splitLater<T extends Dated>(items: T[], today: string): { now: T[]; later: T[] } {
  const back = (item: T) => item.parkedAt !== null && !isLater(item, today)
  const isNow = (item: T) => dueSoon(item, today) || back(item)
  const key = (item: T) =>
    item.parkedAt ? (item.laterOn ?? '9999') : (item.dueOn ?? '9998')
  const later = items
    .filter((item) => !isNow(item))
    .map((item, index) => ({ item, index }))
    .sort((a, b) => key(a.item).localeCompare(key(b.item)) || a.index - b.index)
    .map(({ item }) => item)
  return { now: byHorizon(items.filter(isNow), today), later }
}

/** Something somebody owes: an action, or a question that is not ongoing. */
export function isOwed(item: Pick<ItemView, 'kind' | 'ongoing'>): boolean {
  return item.kind === 'action' || (item.kind === 'question' && !item.ongoing)
}

/**
 * A question I asked that nobody in particular is to answer: no owner, and I
 * am its `with` or it has no parties at all (an announcement still to come).
 * Nobody owes it, so nothing raises it with anyone; once an answerer is added
 * it is an ordinary question.
 */
export function askedOfNoOne(item: Pick<ItemView, 'kind' | 'parties'>): boolean {
  return (
    item.kind === 'question' &&
    !item.parties.some((party) => party.role === 'owner') &&
    (item.parties.length === 0 || item.parties.some((party) => party.role === 'with' && party.isSelf))
  )
}

/**
 * What I am waiting on: an open question or action owed by someone and not by
 * me, or an open question asked of no one in particular.
 */
export function isWaitingOn(item: ItemView): boolean {
  if (!isOpen(item) || !isOwed(item)) return false
  const owners = item.parties.filter((party) => party.role === 'owner')
  if (owners.length > 0) return !owners.some((party) => party.isSelf)
  return askedOfNoOne(item)
}
