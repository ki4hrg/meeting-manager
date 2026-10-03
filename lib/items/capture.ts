/*
 * Quick-add: one typed line into one item.
 *
 *   Q: what is the lunch menu @sarah @tom #retreat
 *
 * A kind prefix (T: Q: A: D:) and any number of @mentions, all optional.
 * An @ names a person or group, a project, or a series to raise it at
 * (`resolveMention`); #project and >series say which outright. With none of
 * them the line is a topic in the Inbox.
 *
 * Who a mention is depends on the kind, by the rule that separates the kinds
 * themselves: a topic is raised `with` someone; a question or an action is
 * owed by its `owner`. When John names himself (@me) on a question or an
 * action, he owes it and everyone else named is who it is owed to.
 */

import { ValidationError, inTransaction, type ActorContext, type Executor } from '../core/types'
import { resolveMention, resolveProject, resolveSeries, type Mention, type Party } from '../directory/resolve'
import { createItem, type ItemKind, type ItemView, type PartyInput, type PartyRole } from './items'

const KIND_PREFIX: Record<string, ItemKind> = {
  t: 'topic',
  q: 'question',
  a: 'action',
  d: 'decision',
}

const TOKEN = /^([@#>])([\p{L}\p{N}][\p{L}\p{N}_/-]*)([.,;:!?]*)$/u

export type ParsedWord =
  | { type: 'text'; value: string }
  | { type: 'mention' | 'project' | 'series'; name: string; trailing: string }

export type ParsedLine = {
  kind: ItemKind | null
  words: ParsedWord[]
  mentions: string[]
  projects: string[]
  series: string[]
}

/**
 * Pure: splits a line into its prefix, its tokens and its words. Resolves
 * nothing. `>series` is quick-add's alone: in a note's verbatim lines a `>`
 * stays part of the text.
 */
export function parseLine(line: string, opts: { series?: boolean } = {}): ParsedLine {
  let rest = line.trim()
  let kind: ItemKind | null = null

  const prefix = /^([tqad]):\s*/i.exec(rest)
  if (prefix) {
    kind = KIND_PREFIX[prefix[1]!.toLowerCase()]!
    rest = rest.slice(prefix[0].length)
  }

  const words: ParsedWord[] = rest
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const token = TOKEN.exec(word)
      if (!token || (token[1] === '>' && !opts.series)) return { type: 'text', value: word }
      return {
        type: token[1] === '@' ? 'mention' : token[1] === '#' ? 'project' : 'series',
        name: token[2]!,
        trailing: token[3] ?? '',
      }
    })

  const names = (type: 'mention' | 'project' | 'series') =>
    words.flatMap((word) => (word.type === type ? [word.name] : []))

  return { kind, words, mentions: names('mention'), projects: names('project'), series: names('series') }
}

/*
 * The text as it should read once the tokens are resolved. A token at either
 * end is a tag and is dropped; one inside the sentence is part of it and is
 * replaced by the name it stands for ("ask @bishop about X" keeps its bishop).
 */
export function renderText(words: ParsedWord[], nameOf: (word: ParsedWord) => string): string {
  const kept = [...words]
  while (kept.length > 0 && kept[0]!.type !== 'text') kept.shift()

  let trailing = ''
  while (kept.length > 0 && kept[kept.length - 1]!.type !== 'text') {
    const dropped = kept.pop()!
    // "…works for you @bishop?" keeps its question mark.
    if (dropped.type !== 'text' && trailing === '') trailing = dropped.trailing
  }

  const text = kept
    .map((word) => (word.type === 'text' ? word.value : nameOf(word) + word.trailing))
    .join(' ')
  return /[.,;:!?]$/.test(text) ? text : text + trailing
}

/*
 * What a mention is to the item. A question or an action is owed by whoever is
 * named, unless John names himself: then he owes it and the others are who it
 * is owed to. On a topic or a decision a mention is who it is raised with.
 * Shared with the verbatim lines of a note, which must read the same way.
 */
export function mentionRole(kind: ItemKind, selfNamed: boolean, isSelf: boolean): PartyRole {
  const owed = kind === 'question' || kind === 'action'
  if (owed) return !selfNamed || isSelf ? 'owner' : 'with'
  return isSelf ? 'owner' : 'with'
}

export type CapturePresets = {
  kind?: ItemKind
  projectId?: string
  /** Parties with their roles already decided, as on a person or group page. */
  parties?: PartyInput[]
  parentItemId?: string
  /** Captured from a meeting's page: the item is aimed at that meeting's agenda. */
  targetMeetingId?: string
}

function sameParty(a: PartyInput, b: PartyInput): boolean {
  return (a.personId ?? a.groupId) === (b.personId ?? b.groupId)
}

export async function captureLine(
  exec: Executor,
  actor: ActorContext,
  input: { contextId: string; line: string; presets?: CapturePresets },
): Promise<ItemView> {
  const parsed = parseLine(input.line, { series: true })
  const presets = input.presets ?? {}
  const kind = parsed.kind ?? presets.kind ?? 'topic'

  return inTransaction(exec, async (tx) => {
    /* One @ for everything: each mention is a person or group, a project or a
       series. # and > still say which outright. */
    const resolved = new Map<string, Mention>()
    for (const name of parsed.mentions) {
      if (!resolved.has(name)) resolved.set(name, await resolveMention(tx, input.contextId, name))
    }
    for (const name of parsed.projects) {
      if (!resolved.has(`#${name}`)) {
        resolved.set(`#${name}`, { type: 'project', ...(await resolveProject(tx, input.contextId, name)) })
      }
    }
    for (const name of parsed.series) {
      if (!resolved.has(`>${name}`)) {
        resolved.set(`>${name}`, { type: 'series', ...(await resolveSeries(tx, input.contextId, name)) })
      }
    }
    const keyOf = (word: Exclude<ParsedWord, { type: 'text' }>) =>
      word.type === 'mention' ? word.name : `${word.type === 'project' ? '#' : '>'}${word.name}`
    const distinct = (...types: Mention['type'][]) => [
      ...new Map([...resolved.values()].filter((one) => types.includes(one.type)).map((one) => [one.id, one])).values(),
    ]

    const [project, ...moreProjects] = distinct('project')
    const [raiseAt, ...moreSeries] = distinct('series')
    if (moreProjects.length > 0) throw new ValidationError('An item belongs to one project.')
    if (moreSeries.length > 0) throw new ValidationError('An item is raised at one series.')
    if (raiseAt && kind === 'decision') {
      throw new ValidationError('A decision is a record, not something to raise.')
    }

    const mentioned = distinct('person', 'group') as Party[]
    const selfNamed = parsed.mentions.some((name) => name.toLowerCase() === 'me')
    const self = selfNamed ? resolved.get(parsed.mentions.find((n) => n.toLowerCase() === 'me')!) : null

    const parties: PartyInput[] = [...(presets.parties ?? [])]
    for (const party of mentioned) {
      const isSelf = self?.id === party.id
      const role = mentionRole(kind, Boolean(self), isSelf)
      const entry: PartyInput =
        party.type === 'person' ? { personId: party.id, role } : { groupId: party.id, role }
      // A preset has already said what this party is to the item.
      if (!parties.some((existing) => sameParty(existing, entry))) parties.push(entry)
    }

    const text = renderText(parsed.words, (word) => {
      if (word.type === 'text') return word.value
      if (word.type === 'mention' && word.name.toLowerCase() === 'me') return 'me'
      return resolved.get(keyOf(word))!.name
    })
    if (text === '') throw new ValidationError('Enter some text.')

    return createItem(tx, actor, {
      contextId: input.contextId,
      kind,
      text,
      projectId: project?.id ?? presets.projectId ?? null,
      parties,
      parentItemId: presets.parentItemId ?? null,
      /* A series named says where it is raised, over the meeting it was
         captured on. Otherwise something to raise is aimed at that meeting; a decision
         is not raised, it was made there. */
      ...(raiseAt
        ? { target: { seriesId: raiseAt.id } }
        : presets.targetMeetingId
        ? kind === 'decision'
          ? { originMeetingId: presets.targetMeetingId }
          : { target: { meetingId: presets.targetMeetingId } }
        : {}),
    })
  })
}
