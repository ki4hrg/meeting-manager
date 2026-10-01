/*
 * The generated blocks of an agenda (docs/SPEC.md, "Workflow"): computed when
 * the agenda is rendered, never stored. `generated.ts` produces them; the brief
 * and the meeting page read them.
 */

import type { ItemKind } from '../items/items'

export type BlockParty = { type: 'person' | 'group'; id: string; name: string }

export type OwedEntry = {
  itemId: string
  kind: ItemKind
  text: string
  dueOn: string | null
  overdue: boolean
}

/** What attending people and groups owe, drawn only from items on this agenda
    or originating in this meeting. */
export type FollowUpsBlock = { party: BlockParty; items: OwedEntry[] }[]

/** Against the previous occurrence of the series. */
export type SinceLastBlock = {
  meeting: { id: string; title: string; startsAt: Date | null }
  decisions: { itemId: string; text: string }[]
  closed: { itemId: string; kind: ItemKind; text: string; resolution: string | null }[]
  stillOpen: { itemId: string; kind: ItemKind; text: string }[]
}

export type LookaheadBlock = {
  milestones: { id: string; projectName: string; title: string; dueOn: string }[]
  deadlines: { itemId: string; kind: ItemKind; text: string; dueOn: string; projectName: string }[]
  meetings: { id: string; title: string; startsAt: Date }[]
}

/** A block that is switched off, or has nothing in it, is null. */
export type GeneratedBlocks = {
  followUps: FollowUpsBlock | null
  sinceLast: SinceLastBlock | null
  lookahead: LookaheadBlock | null
}
