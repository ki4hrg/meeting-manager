/*
 * The extraction fixtures and how an output is judged against one.
 *
 * A fixture is an invented meeting and a list of things a good extraction must
 * (or must not) contain. An expectation counts the drafts that match a
 * description and says how many there should be, so "one question owned by
 * these three" and "nothing that repeats the D: line" are the same mechanism.
 * `scripts/extraction-eval.ts` runs them against the real model, by hand.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExtractionDraft, ExtractionInput, ExtractionOutput } from '../../../lib/processing/types'

export type Where = {
  type?: ('item' | 'update' | 'document' | 'stub')[]
  kind?: ('topic' | 'question' | 'action' | 'decision')[]
  /** A regular expression, case-insensitive, over the draft's wording: text and detail, title and body, or title and people. */
  text?: string
  /** The owners are exactly these ids, each resolved. */
  owners?: string[]
  /** For an update. */
  itemId?: string
  change?: ('complete' | 'answer' | 'drop' | 'note' | 'discussed')[]
  dueOn?: string | null
  ownerGuessed?: boolean
}

export type Expectation =
  | { say: string; where: Where; min?: number; max?: number }
  | { say: string; maxDrafts: number }
  | { say: string; verbatimDetail: number }

export type Fixture = {
  name: string
  about: string
  input: ExtractionInput
  expect: Expectation[]
}

const here = dirname(fileURLToPath(import.meta.url))

export function loadFixtures(): Fixture[] {
  return readdirSync(here)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(here, file), 'utf8')) as Fixture)
}

function wording(draft: ExtractionDraft): string {
  const payload = draft.payload
  switch (payload.type) {
    case 'item':
      return [payload.text, payload.detail, payload.resolution].filter(Boolean).join('\n')
    case 'update':
      return payload.text ?? ''
    case 'document':
      return `${payload.title}\n${payload.body}`
    case 'stub':
      return [payload.title, ...payload.people.map((person) => person.name)].join('\n')
  }
}

export function matches(draft: ExtractionDraft, where: Where): boolean {
  const payload = draft.payload
  if (where.type && !where.type.includes(payload.type)) return false
  if (where.text && !new RegExp(where.text, 'i').test(wording(draft))) return false
  if (where.ownerGuessed !== undefined && draft.ownerGuessed !== where.ownerGuessed) return false

  if (where.kind || where.owners || where.dueOn !== undefined) {
    if (payload.type !== 'item') return false
    if (where.kind && !where.kind.includes(payload.kind)) return false
    if (where.dueOn !== undefined && (payload.dueOn ?? null) !== where.dueOn) return false
    if (where.owners) {
      const owners = payload.parties
        .filter((party) => party.role === 'owner')
        .map((party) => party.personId ?? party.groupId ?? `unresolved:${party.name}`)
        .sort()
      if (owners.join() !== [...where.owners].sort().join()) return false
    }
  }

  if (where.itemId || where.change) {
    if (payload.type !== 'update') return false
    if (where.itemId && payload.itemId !== where.itemId) return false
    if (where.change && !where.change.includes(payload.change)) return false
  }
  return true
}

/** Whether the output meets the expectation, and what was found, for the report. */
export function check(output: ExtractionOutput, expectation: Expectation): { pass: boolean; found: string } {
  if ('maxDrafts' in expectation) {
    const count = output.drafts.length
    return { pass: count <= expectation.maxDrafts, found: `${count} drafts` }
  }
  if ('verbatimDetail' in expectation) {
    const entry = output.verbatimDetails.find((detail) => detail.index === expectation.verbatimDetail)
    return { pass: Boolean(entry), found: entry ? entry.detail : 'no detail' }
  }
  const hits = output.drafts.filter((draft) => matches(draft, expectation.where))
  const min = expectation.min ?? 1
  const max = expectation.max ?? Infinity
  return {
    pass: hits.length >= min && hits.length <= max,
    found: `${hits.length} matching${hits.length > 0 ? `: ${hits.map((hit) => wording(hit).split('\n')[0]).join(' | ')}` : ''}`,
  }
}
