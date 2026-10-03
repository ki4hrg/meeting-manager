/*
 * The extractor against a fake client: what it sends, what it makes of a good
 * answer, what it refuses to believe, and how it fails. Nothing here reaches
 * the network.
 */

import Anthropic from '@anthropic-ai/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildRequest,
  claudeExtractor,
  DEFAULT_MODEL,
  extractorFromEnv,
  type ExtractionClient,
  type ExtractionRequest,
} from '../lib/processing/extract'
import { SYSTEM_PROMPT } from '../lib/processing/prompt'
import type { ExtractionDraft, ExtractionInput, ExtractionOutput } from '../lib/processing/types'
import { check, loadFixtures, matches } from './fixtures/extraction/check'

const JOHN = { id: 'p-john', name: 'John Fleischauer' }
const SARAH = { id: 'p-sarah', name: 'Sarah Jones' }
const OTHER_SARAH = { id: 'p-sarah-2', name: 'Sarah Whitfield' }
const TOM = { id: 'p-tom', name: 'Tom Baker' }
const STAFF = { id: 'g-staff', name: 'Staff' }
const RETREAT = { id: 'pr-retreat', name: 'Retreat' }

function input(over: Partial<ExtractionInput> = {}): ExtractionInput {
  return {
    meeting: {
      id: 'm-1',
      title: 'Staff meeting',
      startsAt: '2026-10-01 10:00',
      people: [SARAH, TOM],
      groups: [STAFF],
      projects: [RETREAT],
    },
    self: JOHN,
    today: '2026-10-01',
    note: {
      body: 'retreat lunch still open',
      summary: 'Granola says the retreat was discussed.',
      transcript: 'Tom: I will book the caterer by Friday.',
    },
    agenda: [{ lineId: 'line-1', section: 'Retreat', text: 'Saturday lunch', itemId: 'item-open' }],
    openItems: [
      {
        id: 'item-open',
        kind: 'question',
        text: 'Who is leading the Saturday session?',
        detail: 'Asked twice already.',
        owners: ['Sarah Jones'],
        with: [],
        project: 'Retreat',
        dueOn: '2026-10-09',
      },
    ],
    directory: {
      people: [JOHN, SARAH, OTHER_SARAH, TOM],
      groups: [STAFF],
      projects: [RETREAT, { id: 'pr-campaign', name: 'Capital campaign' }],
    },
    verbatim: [{ kind: 'decision', text: 'Retreat is at the lake house #retreat' }],
    captured: [{ kind: 'action', text: 'Order name tags' }],
    handled: ['Print the song sheets'],
    ...over,
  }
}

type Wire = {
  summary: string | null
  lines: { lineId: string; summary: string }[]
  verbatimDetails: { index: number; detail: string }[]
  items: Record<string, unknown>[]
  updates: Record<string, unknown>[]
  documents: Record<string, unknown>[]
  stubs: Record<string, unknown>[]
}

function wire(over: Partial<Wire> = {}): Wire {
  return { summary: null, lines: [], verbatimDetails: [], items: [], updates: [], documents: [], stubs: [], ...over }
}

function item(over: Record<string, unknown> = {}) {
  return {
    kind: 'action',
    text: 'Book the caterer',
    detail: null,
    resolution: null,
    owners: [],
    with: [],
    ownerInferred: false,
    project: null,
    dueOn: null,
    parentItemId: null,
    agendaLineId: null,
    ...over,
  }
}

type Reply = { text?: string; stop_reason?: string; category?: string | null } | Error

/** A client that answers with whatever it is given and remembers what it was asked. */
function fakeClient(reply: Reply) {
  const requests: ExtractionRequest[] = []
  const client: ExtractionClient = {
    beta: {
      messages: {
        stream(body) {
          requests.push(body)
          return {
            async finalMessage() {
              if (reply instanceof Error) throw reply
              const refused = reply.stop_reason === 'refusal'
              return {
                content: reply.text === undefined ? [] : [{ type: 'text', text: reply.text, citations: null }],
                stop_reason: (reply.stop_reason ?? 'end_turn') as Anthropic.Beta.BetaStopReason,
                stop_details: refused
                  ? ({ type: 'refusal', category: reply.category ?? null, explanation: null } as Anthropic.Beta.BetaMessage['stop_details'])
                  : null,
              }
            },
          }
        },
      },
    },
  }
  return { client, requests }
}

function run(answer: Wire, over: Partial<ExtractionInput> = {}) {
  const { client, requests } = fakeClient({ text: JSON.stringify(answer) })
  return claudeExtractor({ client }).call(null, input(over)).then((output) => ({ output, requests }))
}

/** The draft at a position, which the test has just asserted exists. */
function draft(output: ExtractionOutput, index: number): ExtractionDraft {
  const found = output.drafts[index]
  if (!found) throw new Error(`no draft at ${index}`)
  return found
}

function textOf(request: ExtractionRequest): string[] {
  const content = request.messages[0]?.content ?? []
  if (typeof content === 'string') return [content]
  return content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
}

describe('the request', () => {
  it('carries the transcript, the notes and the open items', async () => {
    const { requests } = await run(wire())
    expect(requests).toHaveLength(1)
    const all = textOf(requests[0]!).join('\n')

    expect(all).toContain('Tom: I will book the caterer by Friday.')
    expect(all).toContain('Granola says the retreat was discussed.')
    expect(all).toContain('retreat lunch still open')
    expect(all).toContain('[item-open] question: Who is leading the Saturday session?')
    expect(all).toContain('owners: Sarah Jones')
    expect(all).toContain('due: 2026-10-09')
    expect(all).toContain('Asked twice already.')
    expect(all).toContain('[line-1] Retreat › Saturday lunch (open item item-open)')
    expect(all).toContain('2026-10-01 (Thursday)')
    expect(all).toContain('John Fleischauer')
    expect(all).toContain('0. decision: Retreat is at the lake house #retreat')
    expect(all).toContain('- action: Order name tags')
    expect(all).toContain('- Print the song sheets')
    expect(all).toContain('Sarah Whitfield')
  })

  it('puts the stable parts first and caches them', () => {
    const request = buildRequest(input(), DEFAULT_MODEL)

    expect(request.model).toBe('claude-fable-5-1')
    expect(request.system).toEqual([
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ])

    const content = request.messages[0]!.content
    if (typeof content === 'string') throw new Error('expected blocks')
    expect(content).toHaveLength(2)
    const [recording, meeting] = content
    if (!recording || !meeting) throw new Error('expected two blocks')
    if (recording.type !== 'text' || meeting.type !== 'text') throw new Error('expected text blocks')

    /* The transcript block is the same whatever John's notes say, and nothing
       that changes between runs of one note comes before its breakpoint. */
    expect(recording.cache_control).toEqual({ type: 'ephemeral' })
    expect(recording.text).toContain('<transcript>')
    expect(recording.text).not.toContain('retreat lunch still open')
    expect(meeting.cache_control).toBeUndefined()
    expect(meeting.text).toContain('retreat lunch still open')

    const edited = buildRequest(input({ note: { ...input().note, body: 'edited' } }), DEFAULT_MODEL)
    const editedContent = edited.messages[0]!.content
    if (typeof editedContent === 'string') throw new Error('expected blocks')
    expect(editedContent[0]).toEqual(recording)
    expect(edited.system).toEqual(request.system)
  })

  it('sends one block when there is no transcript or summary', () => {
    const request = buildRequest(
      input({ note: { body: 'typed by hand', summary: null, transcript: null } }),
      DEFAULT_MODEL,
    )
    const content = request.messages[0]!.content
    expect(content).toHaveLength(1)
  })

  it('asks for JSON by schema, and for a fallback only on models that take one', () => {
    const fable = buildRequest(input(), 'claude-fable-5-1')
    expect(fable.output_config?.format?.type).toBe('json_schema')
    expect(JSON.stringify(fable.output_config?.format?.schema)).toContain('ownerInferred')
    expect(fable.fallbacks).toBe('default')
    expect(fable.betas).toEqual(['server-side-fallback-2026-07-01'])
    expect(fable.max_tokens).toBeGreaterThanOrEqual(16000)

    const haiku = buildRequest(input(), 'claude-haiku-4-5')
    expect(haiku.model).toBe('claude-haiku-4-5')
    expect(haiku.fallbacks).toBeUndefined()
    expect(haiku.betas).toBeUndefined()
  })
})

describe('a well-formed answer', () => {
  it('maps to drafts with names resolved', async () => {
    const { output } = await run(
      wire({
        summary: '  The staff planned the retreat.  ',
        lines: [{ lineId: 'line-1', summary: 'Lunch was discussed.' }],
        verbatimDetails: [{ index: 0, detail: 'Chosen over the conference centre on cost.' }],
        items: [
          item({
            text: 'Book the caterer',
            owners: ['Tom Baker'],
            with: ['Staff'],
            project: 'Retreat',
            dueOn: '2026-10-02',
            agendaLineId: 'line-1',
            parentItemId: 'item-open',
          }),
          item({
            kind: 'question',
            text: 'What is the lunch menu?',
            owners: ['Sarah Jones', 'tom', 'John'],
            ownerInferred: true,
          }),
          item({ kind: 'decision', text: 'Saturday lunch is catered', detail: ' Cheaper than cooking. ' }),
        ],
        updates: [{ itemId: 'item-open', change: 'answer', text: 'Sarah is leading it.', agendaLineId: 'line-1' }],
        documents: [{ title: 'Retreat schedule draft', body: '- 9:00 arrive\n- 9:30 start', project: 'retreat' }],
        stubs: [{ title: 'Staffing for next year', people: ['Tom Baker', 'John Fleischauer', 'Lee'] }],
      }),
    )

    expect(output.summary).toBe('The staff planned the retreat.')
    expect(output.lines).toEqual([{ lineId: 'line-1', summary: 'Lunch was discussed.' }])
    expect(output.verbatimDetails).toEqual([{ index: 0, detail: 'Chosen over the conference centre on cost.' }])

    /* Updates first: what the meeting did to existing items is what John looks for. */
    expect(output.drafts.map((entry) => entry.payload.type)).toEqual([
      'update',
      'item',
      'item',
      'item',
      'document',
      'stub',
    ])

    expect(draft(output, 0)).toEqual({
      payload: { type: 'update', itemId: 'item-open', change: 'answer', text: 'Sarah is leading it.' },
      lowConfidence: false,
      agendaLineId: 'line-1',
    })

    expect(draft(output, 1)).toEqual({
      payload: {
        type: 'item',
        kind: 'action',
        text: 'Book the caterer',
        detail: null,
        resolution: null,
        parties: [
          { role: 'owner', name: 'Tom Baker', personId: 'p-tom' },
          { role: 'with', name: 'Staff', groupId: 'g-staff' },
        ],
        projectId: 'pr-retreat',
        dueOn: '2026-10-02',
        parentItemId: 'item-open',
      },
      lowConfidence: false,
      agendaLineId: 'line-1',
    })

    const question = draft(output, 2)
    expect(question.lowConfidence).toBe(true)
    if (question.payload.type !== 'item') throw new Error('expected an item')
    expect(question.payload.parties).toEqual([
      { role: 'owner', name: 'Sarah Jones', personId: 'p-sarah' },
      { role: 'owner', name: 'Tom Baker', personId: 'p-tom' },
      { role: 'owner', name: 'John Fleischauer', personId: 'p-john' },
    ])

    const decision = draft(output, 3).payload
    if (decision.type !== 'item') throw new Error('expected an item')
    expect(decision.detail).toBe('Cheaper than cooking.')
    expect(decision.parties).toEqual([])

    expect(draft(output, 4).payload).toEqual({
      type: 'document',
      title: 'Retreat schedule draft',
      body: '- 9:00 arrive\n- 9:30 start',
      projectId: 'pr-retreat',
    })

    /* John is at every meeting, so he is not one of a stub's people. */
    expect(draft(output, 5).payload).toEqual({
      type: 'stub',
      title: 'Staffing for next year',
      people: [{ name: 'Tom Baker', personId: 'p-tom' }, { name: 'Lee' }],
    })
  })

  it('leaves an ambiguous or unknown name unresolved', async () => {
    const { output } = await run(
      wire({
        items: [
          item({ text: 'Send the roster', owners: ['Sarah'], with: ['Marcus Reed'], project: 'Building fund' }),
        ],
        stubs: [{ title: 'Catch up', people: ['Sarah'] }],
      }),
    )

    const payload = draft(output, 0).payload
    if (payload.type !== 'item') throw new Error('expected an item')
    /* Two Sarahs in the directory: the review screen asks, nobody guesses. */
    expect(payload.parties).toEqual([
      { role: 'owner', name: 'Sarah' },
      { role: 'with', name: 'Marcus Reed' },
    ])
    expect(payload.projectId).toBeNull()

    expect(draft(output, 1).payload).toEqual({ type: 'stub', title: 'Catch up', people: [{ name: 'Sarah' }] })
  })

  it('drops ids it did not send', async () => {
    const { output } = await run(
      wire({
        lines: [
          { lineId: 'line-1', summary: 'Real.' },
          { lineId: 'line-made-up', summary: 'Invented.' },
        ],
        verbatimDetails: [
          { index: 0, detail: 'Real.' },
          { index: 7, detail: 'There is no line 7.' },
        ],
        items: [item({ text: 'Call the venue', parentItemId: 'item-made-up', agendaLineId: 'line-made-up' })],
        updates: [
          { itemId: 'item-made-up', change: 'complete', text: null, agendaLineId: null },
          { itemId: 'item-open', change: 'discussed', text: null, agendaLineId: 'line-made-up' },
        ],
      }),
    )

    expect(output.lines).toEqual([{ lineId: 'line-1', summary: 'Real.' }])
    expect(output.verbatimDetails).toEqual([{ index: 0, detail: 'Real.' }])
    expect(output.drafts).toHaveLength(2)

    /* The update to an unknown item is gone; the one to a known item survives without its invented line. */
    expect(draft(output, 0)).toEqual({
      payload: { type: 'update', itemId: 'item-open', change: 'discussed', text: null },
      lowConfidence: false,
      agendaLineId: null,
    })

    /* The item is kept; only the links it invented are removed. */
    const payload = draft(output, 1).payload
    if (payload.type !== 'item') throw new Error('expected an item')
    expect(payload.text).toBe('Call the venue')
    expect(payload.parentItemId).toBeNull()
    expect(draft(output, 1).agendaLineId).toBeNull()
  })

  it('drops what is already captured, empty proposals and dates that are not dates', async () => {
    const { output } = await run(
      wire({
        items: [
          item({ text: 'Order name tags.' }),
          item({ text: 'print the song sheets' }),
          item({ kind: 'decision', text: 'Retreat is at the lake house #retreat' }),
          item({ text: '   ' }),
          item({ text: 'Email the venue', dueOn: 'next Friday' }),
          item({ text: 'Email the venue' }),
          item({ text: 'Confirm the bus', ownerInferred: true }),
        ],
        updates: [
          { itemId: 'item-open', change: 'answer', text: '  ', agendaLineId: null },
          { itemId: 'item-open', change: 'note', text: null, agendaLineId: null },
          { itemId: 'item-open', change: 'discussed', text: null, agendaLineId: null },
          { itemId: 'item-open', change: 'discussed', text: 'again', agendaLineId: null },
        ],
        documents: [{ title: 'Empty', body: '  ', project: null }],
        stubs: [{ title: ' ', people: ['Tom Baker'] }],
      }),
    )

    expect(output.drafts.map((entry) => (entry.payload.type === 'item' ? entry.payload.text : entry.payload.type))).toEqual([
      'update',
      'Email the venue',
      'Confirm the bus',
    ])
    expect(draft(output, 0).payload).toEqual({ type: 'update', itemId: 'item-open', change: 'discussed', text: null })
    const venue = draft(output, 1).payload
    if (venue.type !== 'item') throw new Error('expected an item')
    expect(venue.dueOn).toBeNull()
    /* Inferred, but there is no owner to have inferred. */
    expect(draft(output, 2).lowConfidence).toBe(false)
  })
})

describe('an answer that cannot be used', () => {
  async function failure(reply: Reply): Promise<string> {
    const { client } = fakeClient(reply)
    const error = await claudeExtractor({ client })(input()).then(
      () => null,
      (err: unknown) => err,
    )
    expect(error).toBeInstanceOf(Error)
    return (error as Error).message
  }

  it('throws on text that is not JSON', async () => {
    expect(await failure({ text: 'Here are the items you asked for:' })).toMatch(/not JSON/)
  })

  it('throws on JSON of the wrong shape, naming where', async () => {
    const wrong = { ...wire(), items: [item({ kind: 'commitment' })] }
    expect(await failure({ text: JSON.stringify(wrong) })).toMatch(/expected shape \(items\.0\.kind/)
    expect(await failure({ text: JSON.stringify({ summary: 'only this' }) })).toMatch(/expected shape/)
  })

  it('throws on a refusal, before reading the content', async () => {
    const message = await failure({ text: JSON.stringify(wire()), stop_reason: 'refusal', category: 'cyber' })
    expect(message).toBe('The model declined to process these notes (cyber).')
    expect(await failure({ stop_reason: 'refusal' })).toBe('The model declined to process these notes.')
  })

  it('throws on a truncated response', async () => {
    const half = JSON.stringify(wire({ summary: 'A long meeting' })).slice(0, 30)
    expect(await failure({ text: half, stop_reason: 'max_tokens' })).toMatch(/ran out of room/)
  })

  it('throws on an empty response', async () => {
    expect(await failure({})).toBe('The model returned nothing.')
  })

  it('turns an API error into a sentence', async () => {
    const auth = new Anthropic.AuthenticationError(401, undefined, 'invalid x-api-key', new Headers())
    expect(await failure(auth)).toMatch(/ANTHROPIC_API_KEY/)

    const server = new Anthropic.InternalServerError(529, undefined, 'Overloaded', new Headers())
    expect(await failure(server)).toMatch(/request failed \(529\)/)
  })
})

describe('extractorFromEnv', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('is null without a key', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    expect(extractorFromEnv()).toBeNull()
    vi.stubEnv('ANTHROPIC_API_KEY', '   ')
    expect(extractorFromEnv()).toBeNull()
  })

  it('defaults the model and takes EXTRACTION_MODEL', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test')
    vi.stubEnv('EXTRACTION_MODEL', '')
    expect(extractorFromEnv()?.model).toBe('claude-fable-5-1')
    expect(extractorFromEnv()?.extractor).toBeTypeOf('function')

    vi.stubEnv('EXTRACTION_MODEL', 'claude-opus-5-5')
    expect(extractorFromEnv()?.model).toBe('claude-opus-5-5')
  })
})

/*
 * The fixtures are only run against a model by hand, so here they are held to
 * what can be checked without one: they render, their expectations refer to
 * ids that exist, and the checker tells a good output from an empty one.
 */
describe('the eval fixtures', () => {
  const fixtures = loadFixtures()

  it('cover the four cases', () => {
    expect(fixtures.map((fixture) => fixture.name)).toEqual([
      'lunch-menu',
      'routine-one-to-one',
      'committee',
      'drop-in',
    ])
  })

  it.each(fixtures.map((fixture) => [fixture.name, fixture] as const))('%s is well-formed', async (_name, fixture) => {
    const { client, requests } = fakeClient({ text: JSON.stringify(wire()) })
    const output = await claudeExtractor({ client })(fixture.input)
    expect(output.drafts).toEqual([])
    expect(textOf(requests[0]!).join('\n')).toContain(fixture.input.note.body.trim())

    const known = new Set([
      fixture.input.self.id,
      ...fixture.input.directory.people.map((person) => person.id),
      ...fixture.input.directory.groups.map((group) => group.id),
      ...fixture.input.openItems.map((open) => open.id),
    ])
    for (const expectation of fixture.expect) {
      expect(expectation.say).toBeTruthy()
      if (!('where' in expectation)) continue
      for (const id of [...(expectation.where.owners ?? []), ...(expectation.where.itemId ? [expectation.where.itemId] : [])]) {
        expect(known.has(id), `${fixture.name}: ${id}`).toBe(true)
      }
      if (expectation.where.text) expect(() => new RegExp(expectation.where.text!)).not.toThrow()
    }

    /* An empty output must fail whatever the fixture requires, and pass what it forbids. */
    for (const expectation of fixture.expect) {
      const needsSomething = 'verbatimDetail' in expectation || ('where' in expectation && (expectation.min ?? 1) > 0)
      expect(check(output, expectation).pass, expectation.say).toBe(!needsSomething)
    }
  })

  it('the lunch-menu expectations pass on the answer the spec describes', async () => {
    const fixture = fixtures.find((candidate) => candidate.name === 'lunch-menu')!
    const answer = wire({
      summary: 'Retreat planning.',
      items: [
        item({ kind: 'question', text: 'What is the Saturday lunch menu for the retreat?', owners: ['Sarah Jones', 'Tom Baker', 'Priya Nair'], project: 'Retreat' }),
        item({ text: "Pay the caterer's deposit", owners: ['Tom Baker'], dueOn: '2026-10-02', project: 'Retreat' }),
      ],
    })
    const { client } = fakeClient({ text: JSON.stringify(answer) })
    const output = await claudeExtractor({ client })(fixture.input)
    for (const expectation of fixture.expect) {
      expect(check(output, expectation), expectation.say).toMatchObject({ pass: true })
    }

    /* And the wrong reading, three actions to meet, fails it. */
    const wrong = wire({
      items: ['Sarah Jones', 'Tom Baker', 'Priya Nair'].map((name) =>
        item({ text: `Meet to decide the lunch menu (${name})`, owners: [name] }),
      ),
    })
    const bad = await claudeExtractor({ client: fakeClient({ text: JSON.stringify(wrong) }).client })(fixture.input)
    expect(fixture.expect.filter((expectation) => !check(bad, expectation).pass).length).toBeGreaterThanOrEqual(2)
    expect(matches(draft(bad, 0), { kind: ['action'], text: 'menu' })).toBe(true)
  })
})
