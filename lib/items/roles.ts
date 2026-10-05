/*
 * How each kind reads its two party roles (docs/SPEC.md, `item_parties`).
 *
 * The roles stay what they are in the database: `owner` owes it, `with` is who
 * it is raised with or, on something John owns, owed to. What changes by kind
 * is which side the arrow points at. On an action or a topic the owner leads
 * and the arrow points at who it is for; on a question or a decision the arrow
 * points at the owner, who the question is asked of or who decides, and
 * whoever asked leads. Further owners of an action or a topic are
 * collaborators and wear the two-way mark.
 */

import type { ItemKind } from './items'

export type PartyRole = 'owner' | 'with'

type Reading = {
  owner: string
  with: string
  /** The role the arrow points at. */
  points: PartyRole
}

export const ROLES: Record<ItemKind, Reading> = {
  topic: { owner: 'Owner', with: 'Raise with', points: 'with' },
  action: { owner: 'Owner', with: 'For', points: 'with' },
  question: { owner: 'Asked of', with: 'Asked by', points: 'owner' },
  decision: { owner: 'Decided by', with: 'Raised by', points: 'owner' },
}

/** What a collaborator, an owner after the first on an action or a topic, is called. */
export const COLLABORATOR = 'With'

export function roleLabel(kind: ItemKind, role: PartyRole): string {
  return ROLES[kind][role]
}

/** The roles in the order a line reads them: who leads, then where the arrow points. */
export function roleOrder(kind: ItemKind): [PartyRole, PartyRole] {
  return ROLES[kind].points === 'owner' ? ['with', 'owner'] : ['owner', 'with']
}

/** Whether a kind's further owners are collaborators rather than joint recipients. */
export function hasCollaborators(kind: ItemKind): boolean {
  return ROLES[kind].points === 'with'
}
