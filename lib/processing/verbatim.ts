/*
 * Verbatim lines: `D:` `Q:` `A:` `T:` lines in John's own notes, read by code
 * before any model runs (docs/SPEC.md, "Precise capture").
 *
 * The wording is his and is kept exactly. A line reads the way the quick-add
 * box reads it, so `@mentions` and `#projects` mean the same thing in both
 * places: the parsing and the role rule come from lib/items/capture.ts.
 */

import { ValidationError, type Executor } from '../core/types'
import type { ProposalPayload, ProposedParty } from '../db/schema'
import { resolveParty, resolveProject, type Party } from '../directory/resolve'
import { mentionRole, parseLine, renderText } from '../items/capture'
import type { VerbatimLine } from './types'

/* A list bullet, a number or a checkbox in front of the prefix: Granola's
   notepad is Markdown and most lines in it are list items. */
const LEAD = /^\s*(?:(?:[-*+•]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?/

/** Pure: the verbatim lines of a note body, in order. */
export function parseVerbatim(body: string): VerbatimLine[] {
  const lines: VerbatimLine[] = []
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(LEAD, '')
    const { kind } = parseLine(line)
    if (!kind) continue
    // The prefix is one letter and its colon; the rest is the wording.
    const text = line.trim().slice(2).trim()
    if (text !== '') lines.push({ kind, text })
  }
  return lines
}

async function orNull<T>(lookup: Promise<T>): Promise<T | null> {
  try {
    return await lookup
  } catch (error) {
    if (error instanceof ValidationError) return null
    throw error
  }
}

/**
 * A verbatim line as the item it proposes. Tokens resolve as quick-add resolves
 * them, with one difference: a name that matches nobody, or more than one, does
 * not refuse the line. It stays as a party with only its name, to be asked for
 * at review.
 */
export async function resolveVerbatim(
  exec: Executor,
  contextId: string,
  line: VerbatimLine,
): Promise<Extract<ProposalPayload, { type: 'item' }>> {
  // The prefix goes back on so a line whose own wording starts "a: …" is not read twice.
  const parsed = parseLine(`${line.kind[0]}: ${line.text}`)
  const isMe = (name: string) => name.toLowerCase() === 'me'

  const resolved = new Map<string, Party | null>()
  for (const name of parsed.mentions) {
    if (!resolved.has(name)) resolved.set(name, await orNull(resolveParty(exec, contextId, name)))
  }

  /* An item has one project: the first that resolves. Any other stays in the
     sentence as it was typed. */
  let project: { id: string; name: string; token: string } | null = null
  for (const token of parsed.projects) {
    const found = await orNull(resolveProject(exec, contextId, token))
    if (found) {
      project = { ...found, token }
      break
    }
  }

  const selfToken = parsed.mentions.find(isMe)
  const self = selfToken ? (resolved.get(selfToken) ?? null) : null

  const parties: ProposedParty[] = []
  const seen = new Set<string>()
  for (const [name, party] of resolved) {
    const key = party ? party.id : `?${name.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)

    const role = mentionRole(line.kind, Boolean(self), Boolean(party && self?.id === party.id))
    if (!party) parties.push({ role, name })
    else if (party.type === 'person') parties.push({ role, name: party.name, personId: party.id })
    else parties.push({ role, name: party.name, groupId: party.id })
  }

  /* With no tokens the line is kept character for character; with them, it
     reads as quick-add would have written it. */
  const tokens = parsed.mentions.length + parsed.projects.length
  const rendered =
    tokens === 0
      ? line.text
      : renderText(parsed.words, (word) => {
          if (word.type === 'mention') {
            return isMe(word.name) ? 'me' : (resolved.get(word.name)?.name ?? word.name)
          }
          if (word.type === 'project') return word.name === project?.token ? project.name : word.name
          return ''
        })

  return {
    type: 'item',
    kind: line.kind,
    text: rendered === '' ? line.text : rendered,
    parties,
    projectId: project?.id ?? null,
  }
}
