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
 *
 * Every label says what the person does with the item, never a bare "Owner".
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
  topic: { owner: 'Raised by', with: 'Raise with', points: 'with' },
  action: { owner: 'Assigned to', with: 'For', points: 'with' },
  question: { owner: 'Answer needed from', with: 'Asked by', points: 'owner' },
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

/** Where a party can be moved to: a role, and on an owner whether it leads. */
export type RoleMove = { role: PartyRole; lead?: boolean; label: string }

/**
 * The roles a party can move to from where it stands: `index` is its place
 * among the parties in its role, `owners` how many owners the item has. On an
 * action or a topic a party joining the owners lands as a collaborator unless
 * made lead, and the lead and a collaborator can trade places.
 */
export function roleMoves(kind: ItemKind, role: PartyRole, index: number, owners: number): RoleMove[] {
  const collaborators = hasCollaborators(kind)
  if (role === 'with') {
    return collaborators && owners > 0
      ? [
          { role: 'owner', lead: true, label: roleLabel(kind, 'owner') },
          { role: 'owner', lead: false, label: COLLABORATOR },
        ]
      : [{ role: 'owner', label: roleLabel(kind, 'owner') }]
  }
  const moves: RoleMove[] = []
  if (collaborators && index > 0) moves.push({ role: 'owner', lead: true, label: roleLabel(kind, 'owner') })
  if (collaborators && index === 0 && owners > 1) moves.push({ role: 'owner', lead: false, label: COLLABORATOR })
  moves.push({ role: 'with', label: roleLabel(kind, 'with') })
  return moves
}
