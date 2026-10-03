/*
 * The model behind the Extractor seam.
 *
 * One request per run: the frozen system prompt, the meeting rendered by
 * prompt.ts, and a JSON schema the response is held to. What comes back is
 * validated, then mapped onto proposal payloads here rather than by the model:
 * it names people, groups and projects by name, and a name becomes an id only
 * when the directory has exactly one match. An id it returns is kept only if
 * it was one we sent. The model is never trusted with identity.
 *
 * Any failure (a refusal, a cut-off response, JSON that does not fit) is thrown
 * as an Error with a sentence a person can read; run.ts marks the run failed
 * with it.
 */

import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { z } from 'zod'
import { matchName, normalise } from '../core/match'
import type { ProposalPayload, ProposedParty } from '../db/schema'
import { renderMeeting, renderRecording, SYSTEM_PROMPT } from './prompt'
import type { ExtractionDraft, ExtractionInput, ExtractionOutput, Extractor } from './types'

export const DEFAULT_MODEL = 'claude-fable-5-1'

/* Room for a long document proposal and the model's own reasoning, which is
   counted against the same limit. Streaming keeps a response this size clear
   of HTTP timeouts. */
const MAX_OUTPUT_TOKENS = 32_000

/*
 * Models whose safety classifiers can decline a request, and which accept a
 * server-side fallback: a declined request is run again on the model Anthropic
 * recommends for that category, inside the same call. Sent only to these,
 * because other models reject the parameter.
 */
const FALLBACK_MODELS = new Set([
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-mythos-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
])
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

const KINDS = ['topic', 'question', 'action', 'decision'] as const
const CHANGES = ['complete', 'answer', 'drop', 'note', 'discussed'] as const

/*
 * What the model writes. Flat, with every field present and null for "none":
 * structured outputs want closed objects, and a field that may be absent is a
 * field the model forgets.
 */
const Wire = z.object({
  summary: z.string().nullable().describe('The meeting in three to six sentences, or null.'),
  lines: z
    .array(z.object({ lineId: z.string(), summary: z.string() }))
    .describe('One entry per agenda line that was actually discussed.'),
  verbatimDetails: z
    .array(
      z.object({
        index: z.number().int().describe('The number of the line in <verbatim>.'),
        detail: z.string(),
      }),
    )
    .describe('The discussion around each verbatim line.'),
  items: z
    .array(
      z.object({
        kind: z.enum(KINDS),
        text: z.string(),
        detail: z.string().nullable(),
        resolution: z
          .string()
          .nullable()
          .describe('Only for a question asked and answered in this meeting.'),
        owners: z.array(z.string()).describe('Names of the people or groups who owe it.'),
        with: z.array(z.string()).describe('Names of the people or groups to raise it with.'),
        ownerInferred: z.boolean().describe('True when the owner was not stated outright.'),
        project: z.string().nullable().describe('A project name from the material, or null.'),
        dueOn: z.string().nullable().describe('YYYY-MM-DD, only when a deadline was stated.'),
        parentItemId: z.string().nullable().describe('The id of the open item this follows from.'),
        agendaLineId: z.string().nullable(),
      }),
    )
    .describe('New items. Fewer, well-formed proposals beat many.'),
  updates: z
    .array(
      z.object({
        itemId: z.string().describe('An id from <open_items>.'),
        change: z.enum(CHANGES),
        text: z.string().nullable().describe('The answer, the outcome or the note.'),
        agendaLineId: z.string().nullable(),
      }),
    )
    .describe('Changes to items that are already open.'),
  documents: z
    .array(
      z.object({
        title: z.string(),
        body: z.string().describe('The drafted content, whole, as Markdown.'),
        project: z.string().nullable(),
      }),
    )
    .describe('Drafted content from the scratchpad, kept whole.'),
  stubs: z
    .array(z.object({ title: z.string(), people: z.array(z.string()) }))
    .describe('Follow-up conversations to prep: a meeting with these people.'),
})

type WireOutput = z.infer<typeof Wire>

/* Only the schema is sent. The helper's own parser is left out so that a
   refusal or a cut-off response is reported in our words, after the stop
   reason has been looked at, instead of surfacing as a parse failure. */
const { type: formatType, schema: formatSchema } = zodOutputFormat(Wire)
const OUTPUT_FORMAT = { type: formatType, schema: formatSchema }

export type ExtractionRequest = BetaMessageStreamParams

/**
 * As much of the SDK client as extraction uses. A test passes its own; nothing
 * under `test/` reaches the network.
 */
export type ExtractionClient = {
  beta: {
    messages: {
      stream(body: ExtractionRequest): {
        finalMessage(): Promise<Pick<Anthropic.Beta.BetaMessage, 'content' | 'stop_reason' | 'stop_details'>>
      }
    }
  }
}

export type ClaudeExtractorOptions = {
  apiKey?: string
  model?: string
  client?: ExtractionClient
}

/** The request for one meeting. Exported so a test can read what would be sent. */
export function buildRequest(input: ExtractionInput, model: string): ExtractionRequest {
  const recording = renderRecording(input)

  /*
   * Two cache breakpoints, at the two places the prompt stops being shared.
   * The system prompt is the same for every run. The transcript is the same
   * for every run of one note: when John edits his notes and the run repeats,
   * only the block after it is new. Nothing volatile may come before either.
   */
  const content: Anthropic.Beta.Messages.BetaContentBlockParam[] = []
  if (recording) {
    content.push({ type: 'text', text: recording, cache_control: { type: 'ephemeral' } })
  }
  content.push({ type: 'text', text: renderMeeting(input) })

  const fallback = FALLBACK_MODELS.has(model)

  return {
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content }],
    output_config: { format: OUTPUT_FORMAT },
    ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
  }
}

function readable(err: unknown): Error {
  /* Most specific first: the status decides what a person can do about it. */
  if (err instanceof Anthropic.AuthenticationError) {
    return new Error('The model refused the API key. Check ANTHROPIC_API_KEY.')
  }
  if (err instanceof Anthropic.PermissionDeniedError || err instanceof Anthropic.NotFoundError) {
    return new Error(`The model is not available to this API key: ${err.message}`)
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new Error('The model is rate limited right now. Process the meeting again in a few minutes.')
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new Error('The model could not be reached.')
  }
  if (err instanceof Anthropic.APIError) {
    return new Error(`The model request failed (${err.status ?? 'no status'}): ${err.message}`)
  }
  return err instanceof Error ? err : new Error(String(err))
}

function parseResponse(
  message: Pick<Anthropic.Beta.BetaMessage, 'content' | 'stop_reason' | 'stop_details'>,
): WireOutput {
  /* The stop reason before the content: a refusal or a cut-off response has
     content that is not the schema's, and reading it first hides why. */
  if (message.stop_reason === 'refusal') {
    const category = message.stop_details?.category
    throw new Error(
      `The model declined to process these notes${category ? ` (${category})` : ''}.`,
    )
  }
  if (message.stop_reason === 'max_tokens') {
    throw new Error('The model ran out of room before finishing its answer, so nothing was kept.')
  }
  if (message.stop_reason === 'model_context_window_exceeded') {
    throw new Error('These notes and their transcript are too long for the model to read at once.')
  }

  const text = message.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
  if (text.trim() === '') throw new Error('The model returned nothing.')

  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('The model returned something that is not JSON.')
  }

  const parsed = Wire.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.join('.') || 'the response'
    throw new Error(`The model's answer did not have the expected shape (${where}: ${issue?.message}).`)
  }
  return parsed.data
}

type Named = { id: string; name: string }

function unique(list: Named[]): Named[] {
  const seen = new Set<string>()
  return list.filter((entry) => !seen.has(entry.id) && seen.add(entry.id))
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/** Turns the model's answer into drafts, keeping only identities we can vouch for. */
export function toOutput(wire: WireOutput, input: ExtractionInput): ExtractionOutput {
  /* John is a person like any other here, so "John" in an owner list resolves.
     The meeting's own people and projects are added in case the directory was
     built without them. */
  const people = unique([input.self, ...input.meeting.people, ...input.directory.people])
  const groups = unique([...input.meeting.groups, ...input.directory.groups])
  const projects = unique([...input.meeting.projects, ...input.directory.projects])

  const partyPool = [
    ...people.map((person) => ({ ...person, as: 'person' as const })),
    ...groups.map((group) => ({ ...group, as: 'group' as const })),
  ]

  /* Exactly one match or none at all: two Sarahs is a question for the review
     screen, not a coin for the model or for us to toss. */
  function party(role: ProposedParty['role'], name: string): ProposedParty {
    const [match, ...rest] = matchName(partyPool, name)
    if (!match || rest.length > 0) return { role, name }
    return match.as === 'person'
      ? { role, name: match.name, personId: match.id }
      : { role, name: match.name, groupId: match.id }
  }

  function parties(role: ProposedParty['role'], list: string[]): ProposedParty[] {
    const seen = new Set<string>()
    const out: ProposedParty[] = []
    for (const raw of list) {
      const name = raw.trim()
      if (name === '') continue
      const resolved = party(role, name)
      const key = resolved.personId ?? resolved.groupId ?? `name:${normalise(resolved.name)}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(resolved)
    }
    return out
  }

  function projectId(name: string | null): string | null {
    if (!clean(name)) return null
    const [match, ...rest] = matchName(projects, name!)
    return match && rest.length === 0 ? match.id : null
  }

  const lineIds = new Set(input.agenda.map((line) => line.lineId))
  const itemIds = new Set(input.openItems.map((item) => item.id))
  const lineId = (id: string | null) => (id && lineIds.has(id) ? id : null)

  /* The prompt says not to repeat these; this catches the word-for-word case
     when it does anyway. A rewording is caught by the fingerprint or by John. */
  const taken = new Set(
    [...input.verbatim, ...input.captured].map((entry) => normalise(entry.text)).concat(input.handled.map(normalise)),
  )

  const drafts: ExtractionDraft[] = []

  const updated = new Set<string>()
  for (const update of wire.updates) {
    if (!itemIds.has(update.itemId)) continue
    const text = clean(update.text)
    /* An answer with no answer, or a note with no note, changes nothing. */
    if ((update.change === 'answer' || update.change === 'note') && !text) continue
    const key = `${update.itemId}:${update.change}`
    if (updated.has(key)) continue
    updated.add(key)
    drafts.push({
      payload: { type: 'update', itemId: update.itemId, change: update.change, text },
      ownerGuessed: false,
      agendaLineId: lineId(update.agendaLineId),
    })
  }

  for (const item of wire.items) {
    const text = clean(item.text)
    if (!text || taken.has(normalise(text))) continue
    taken.add(normalise(text))

    const owners = parties('owner', item.owners)
    const ownerKeys = new Set(owners.map((owner) => owner.personId ?? owner.groupId))
    /* Someone who owes it is not also someone to raise it with. */
    const others = parties('with', item.with).filter(
      (other) => !(other.personId ?? other.groupId) || !ownerKeys.has(other.personId ?? other.groupId),
    )
    const dueOn = clean(item.dueOn)

    const payload: ProposalPayload = {
      type: 'item',
      kind: item.kind,
      text,
      detail: clean(item.detail),
      resolution: clean(item.resolution),
      parties: [...owners, ...others],
      projectId: projectId(item.project),
      dueOn: dueOn && ISO_DAY.test(dueOn) ? dueOn : null,
      parentItemId: item.parentItemId && itemIds.has(item.parentItemId) ? item.parentItemId : null,
    }
    drafts.push({
      payload,
      ownerGuessed: item.ownerInferred && owners.length > 0,
      agendaLineId: lineId(item.agendaLineId),
    })
  }

  for (const document of wire.documents) {
    const title = clean(document.title)
    const body = document.body.trim()
    if (!title || body === '') continue
    drafts.push({
      payload: { type: 'document', title, body, projectId: projectId(document.project) },
      ownerGuessed: false,
      agendaLineId: null,
    })
  }

  for (const stub of wire.stubs) {
    const title = clean(stub.title)
    if (!title) continue
    const seen = new Set<string>()
    const stubPeople: { name: string; personId?: string }[] = []
    for (const raw of stub.people) {
      const name = raw.trim()
      if (name === '') continue
      const [first, ...rest] = matchName(people, name)
      const match = first && rest.length === 0 ? first : null
      /* John is at every meeting and is never one of its people. */
      if (match?.id === input.self.id) continue
      const key = match?.id ?? `name:${normalise(name)}`
      if (seen.has(key)) continue
      seen.add(key)
      stubPeople.push(match ? { name: match.name, personId: match.id } : { name })
    }
    drafts.push({
      payload: { type: 'stub', title, people: stubPeople },
      ownerGuessed: false,
      agendaLineId: null,
    })
  }

  const seenLines = new Set<string>()
  const lines = wire.lines.flatMap((line) => {
    const summary = clean(line.summary)
    if (!summary || !lineIds.has(line.lineId) || seenLines.has(line.lineId)) return []
    seenLines.add(line.lineId)
    return [{ lineId: line.lineId, summary }]
  })

  const seenIndexes = new Set<number>()
  const verbatimDetails = wire.verbatimDetails.flatMap((entry) => {
    const detail = clean(entry.detail)
    if (!detail || entry.index < 0 || entry.index >= input.verbatim.length) return []
    if (seenIndexes.has(entry.index)) return []
    seenIndexes.add(entry.index)
    return [{ index: entry.index, detail }]
  })

  return { summary: clean(wire.summary), lines, drafts, verbatimDetails }
}

export function claudeExtractor(opts: ClaudeExtractorOptions = {}): Extractor {
  const model = opts.model ?? DEFAULT_MODEL
  let client = opts.client

  return async (input) => {
    /* Made on first use, so building an extractor costs nothing and needs no key. */
    client ??= new Anthropic({ apiKey: opts.apiKey })

    let message
    try {
      message = await client.beta.messages.stream(buildRequest(input, model)).finalMessage()
    } catch (err) {
      throw readable(err)
    }
    return toOutput(parseResponse(message), input)
  }
}

/**
 * The extractor the environment asks for, or null when there is no key. With
 * null the pipeline still runs, on verbatim lines alone.
 */
export function extractorFromEnv(): { extractor: Extractor; model: string } | null {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim()
  if (!apiKey) return null
  const model = process.env.EXTRACTION_MODEL?.trim() || DEFAULT_MODEL
  return { extractor: claudeExtractor({ apiKey, model }), model }
}
