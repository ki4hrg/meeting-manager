/*
 * Quick-add: one typed line into one item.
 *
 *   Q: what is the lunch menu @sarah @tom #retreat
 *
 * A kind prefix (T: Q: A: D:), any number of @person or @group mentions and a
 * #project, all optional. With none of them the line is a topic in the Inbox.
 *
 * Who a mention is depends on the kind, by the rule that separates the kinds
 * themselves: a topic is raised `with` someone; a question or an action is
 * owed by its `owner`. When John names himself (@me) on a question or an
 * action, he owes it and everyone else named is who it is owed to.
 */

import { ValidationError, inTransaction, type ActorContext, type Executor } from '../core/types'
import { resolveParty, resolveProject, type Party } from '../directory/resolve'
import { createItem, type ItemKind, type ItemView, type PartyInput } from './items'

const KIND_PREFIX: Record<string, ItemKind> = {
  t: 'topic',
  q: 'question',
  a: 'action',
  d: 'decision',
}

const TOKEN = /^([@#])([\p{L}\p{N}][\p{L}\p{N}_-]*)([.,;:!?]*)$/u

export type ParsedWord =
  | { type: 'text'; value: string }
  | { type: 'mention' | 'project'; name: string; trailing: string }

export type ParsedLine = {
  kind: ItemKind | null
  words: ParsedWord[]
  mentions: string[]
  projects: string[]
}

/** Pure: splits a line into its prefix, its tokens and its words. Resolves nothing. */
export function parseLine(line: string): ParsedLine {
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
      if (!token) return { type: 'text', value: word }
      return {
        type: token[1] === '@' ? 'mention' : 'project',
        name: token[2]!,
        trailing: token[3] ?? '',
      }
    })

  const names = (type: 'mention' | 'project') =>
    words.flatMap((word) => (word.type === type ? [word.name] : []))

  return { kind, words, mentions: names('mention'), projects: names('project') }
}

/*
 * The text as it should read once the tokens are resolved. A token at either
 * end is a tag and is dropped; one inside the sentence is part of it and is
 * replaced by the name it stands for ("ask @bishop about X" keeps its bishop).
 */
function renderText(words: ParsedWord[], nameOf: (word: ParsedWord) => string): string {
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

export type CapturePresets = {
  kind?: ItemKind
  projectId?: string
  /** Parties with their roles already decided, as on a person or group page. */
  parties?: PartyInput[]
  parentItemId?: string
}

function sameParty(a: PartyInput, b: PartyInput): boolean {
  return (a.personId ?? a.groupId) === (b.personId ?? b.groupId)
}

export async function captureLine(
  exec: Executor,
  actor: ActorContext,
  input: { contextId: string; line: string; presets?: CapturePresets },
): Promise<ItemView> {
  const parsed = parseLine(input.line)
  const presets = input.presets ?? {}
  const kind = parsed.kind ?? presets.kind ?? 'topic'

  if (parsed.projects.length > 1) throw new ValidationError('An item belongs to one project.')

  return inTransaction(exec, async (tx) => {
    const resolved = new Map<string, Party>()
    for (const name of parsed.mentions) {
      resolved.set(name, await resolveParty(tx, input.contextId, name))
    }
    const project = parsed.projects[0]
      ? await resolveProject(tx, input.contextId, parsed.projects[0])
      : null

    const mentioned = [...new Map([...resolved.values()].map((party) => [party.id, party])).values()]
    const selfNamed = parsed.mentions.some((name) => name.toLowerCase() === 'me')
    const self = selfNamed ? resolved.get(parsed.mentions.find((n) => n.toLowerCase() === 'me')!) : null
    const owed = kind === 'question' || kind === 'action'

    const parties: PartyInput[] = [...(presets.parties ?? [])]
    for (const party of mentioned) {
      const isSelf = self?.id === party.id
      const role = owed ? (!self || isSelf ? 'owner' : 'with') : isSelf ? 'owner' : 'with'
      const entry: PartyInput =
        party.type === 'person' ? { personId: party.id, role } : { groupId: party.id, role }
      // A preset has already said what this party is to the item.
      if (!parties.some((existing) => sameParty(existing, entry))) parties.push(entry)
    }

    const text = renderText(parsed.words, (word) => {
      if (word.type === 'mention') {
        return word.name.toLowerCase() === 'me' ? 'me' : resolved.get(word.name)!.name
      }
      return word.type === 'project' ? project!.name : ''
    })
    if (text === '') throw new ValidationError('Enter some text.')

    return createItem(tx, actor, {
      contextId: input.contextId,
      kind,
      text,
      projectId: project?.id ?? presets.projectId ?? null,
      parties,
      parentItemId: presets.parentItemId ?? null,
    })
  })
}
