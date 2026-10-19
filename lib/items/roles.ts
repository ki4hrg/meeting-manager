/*
 * How each kind reads its two party roles (docs/SPEC.md, `item_parties`).
 *
 * The roles stay what they are in the database: `owner` owes it (on a topic,
 * only its lead, and only when that is not John: `owersOf` in `horizon.ts`),
 * `with` is who it is raised with or, on something John owns, owed to. What changes by kind
 * is which side the arrow points at. On an action or a topic the owner leads
 * and the arrow points at who it is for; on a question or a decision the arrow
 * points at the owner, who the question is asked of or who decides, and
 * whoever asked leads. Further owners of an action or a topic are
 * collaborators and wear the two-way mark.
 *
 * Every label says what the person does with the item, never a bare "Owner".
 */

import type { ItemKind, ItemView } from './items'

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
export const COLLABORATOR = 'Together with'

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

/**
 * Where an item stands between John and one person or group (`partyId`), as
 * prep's suggestions group them, in the order they are listed:
 *
 *   - `theirs`: theirs to bring John: their action or a question asked of
 *     them, for John or for no one named, or a topic they raise with him.
 *   - `mine`: John's to bring them: his action for them, a question they
 *     asked him, a topic he raises with them or one nobody has taken up.
 *   - `elsewhere`: theirs for someone else, which they report back on.
 *   - `together`: John and they are both on it (one leads, the other
 *     collaborates), they collaborate on someone else's topic, or it is
 *     someone else's to talk over with them.
 *
 * A topic's collaborator owes nothing (docs/SPEC.md, "Who owes what"), so it
 * stands as `together`, never as `theirs`. This only orders; it never decides
 * what is a candidate.
 */
export type Stance = 'theirs' | 'mine' | 'elsewhere' | 'together'

export const STANCES: Stance[] = ['theirs', 'mine', 'elsewhere', 'together']

type Placed = Pick<ItemView, 'kind' | 'parties'>

export function stanceOf(item: Placed, partyId: string): Stance {
  const owners = item.parties.filter((party) => party.role === 'owner')
  const withs = item.parties.filter((party) => party.role === 'with')
  const theyOwn = owners.some((party) => party.id === partyId)
  const iOwn = owners.some((party) => party.isSelf)
  if (theyOwn && iOwn) return 'together'
  if (theyOwn) {
    if (hasCollaborators(item.kind) && owners[0]!.id !== partyId) return 'together'
    return withs.length > 0 && !withs.some((party) => party.isSelf) ? 'elsewhere' : 'theirs'
  }
  if (iOwn) return 'mine'
  if (owners.length === 0 && withs.some((party) => party.id === partyId)) return 'mine'
  return 'together'
}

/** A list by stance, in stance order, each stance's items in the order they came. Empty stances are left out. */
export function byStance<T extends Placed>(items: T[], partyId: string): { stance: Stance; items: T[] }[] {
  return STANCES.map((stance) => ({
    stance,
    items: items.filter((item) => stanceOf(item, partyId) === stance),
  })).filter((band) => band.items.length > 0)
}
