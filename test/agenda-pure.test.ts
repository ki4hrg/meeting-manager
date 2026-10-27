/*
 * Pure function tests for agenda: outline parsing, scheduling, and rendering.
 */

import { describe, expect, it } from 'vitest'
import { parseOutline } from '../lib/agenda/outline'
import {
  briefOutline,
  renderAgenda,
  renderAgendaHtml,
  renderBrief,
  renderBriefHtml,
} from '../lib/agenda/brief'
import { EXPORTS, pick, preset, toMarkdown } from '../lib/agenda/export'
import { type Agenda } from '../lib/agenda/lines'
import { type GeneratedBlocks } from '../lib/agenda/types'
import { scheduleAgenda, type SchedulableNode } from '../lib/agenda/schedule'

describe('outline parsing', () => {
  it('parses headings into sections and items', () => {
    const outline = `# Welcome
## Setup
Some notes here
## Status
- Point one
- Point two`

    const items = parseOutline(outline)
    expect(items).toHaveLength(3)
    expect(items[0]!.title).toBe('Welcome')
    expect(items[0]!.depth).toBe(0)
    expect(items[1]!.title).toBe('Setup')
    expect(items[1]!.depth).toBe(1)
    expect(items[1]!.body).toContain('Some notes')
    expect(items[2]!.title).toBe('Status')
  })

  it('extracts minutes from titles', () => {
    const outline = `# Welcome 10 min
## Setup 5
## Status 15 minutes`

    const items = parseOutline(outline)
    expect(items[0]!.minutes).toBe(10)
    expect(items[1]!.minutes).toBe(5)
    expect(items[2]!.minutes).toBe(15)
    expect(items[0]!.title).toBe('Welcome')
  })

  it('parses bullets when there are no headings', () => {
    const outline = `- First item
  - Nested item
  - Another nested
- Second item`

    const items = parseOutline(outline)
    expect(items).toHaveLength(4)
    expect(items[0]!.depth).toBe(0)
    expect(items[0]!.title).toBe('First item')
    expect(items[1]!.depth).toBe(1)
    expect(items[1]!.title).toBe('Nested item')
    expect(items[2]!.depth).toBe(1)
    expect(items[2]!.title).toBe('Another nested')
    expect(items[3]!.depth).toBe(0)
    expect(items[3]!.title).toBe('Second item')
  })

  it('handles fenced code blocks', () => {
    const outline = `# Section
\`\`\`
# This is not a heading
\`\`\`
## Real heading`

    const items = parseOutline(outline)
    expect(items).toHaveLength(2)
    expect(items[0]!.title).toBe('Section')
    expect(items[1]!.title).toBe('Real heading')
  })

  it('ignores empty headings', () => {
    const outline = `# Welcome
#
## Item
##
# Closing`

    const items = parseOutline(outline)
    expect(items).toHaveLength(3)
    expect(items.map((i) => i.title)).toEqual(['Welcome', 'Item', 'Closing'])
  })
})

const CHICAGO = 'America/Chicago'

const line = (minutes: number | null, pinnedStart: string | null = null): SchedulableNode => ({
  type: 'line',
  minutes,
  pinnedStart,
  start: null,
})
const section = (
  lines: Array<[number | null, (string | null)?]>,
  own: { minutes?: number | null; pinnedStart?: string | null } = {},
): SchedulableNode => ({
  type: 'section',
  minutes: own.minutes ?? null,
  pinnedStart: own.pinnedStart ?? null,
  start: null,
  lines: lines.map(([minutes, pinnedStart]) => ({ minutes, pinnedStart: pinnedStart ?? null, start: null })),
})
const starts = (nodes: SchedulableNode[]) =>
  nodes.flatMap((node) =>
    node.type === 'section' ? [node.start, ...node.lines.map((l) => l.start)] : [node.start],
  )

describe('schedule computation', () => {
  // 14:00Z is 9:00 AM in Chicago in October (CDT).
  const nineChicago = new Date('2026-10-07T14:00:00Z')

  it('walks the agenda on the clock of the user\'s zone, not UTC', () => {
    const nodes = [line(10), line(15), line(null)]
    const result = scheduleAgenda(nodes, { startsAt: nineChicago, endsAt: null, timeZone: CHICAGO })
    expect(starts(nodes)).toEqual(['09:00', '09:10', '09:25'])
    expect(result).toEqual({ totalMinutes: 25, end: '09:25', overflowMinutes: 0 })
  })

  it('keeps sections and loose lines in the order they are written', () => {
    const nodes = [line(5), section([[10], [20]]), line(5)]
    scheduleAgenda(nodes, { startsAt: nineChicago, endsAt: null, timeZone: CHICAGO })
    expect(starts(nodes)).toEqual(['09:00', '09:05', '09:05', '09:15', '09:35'])
    expect(nodes[1]!.minutes).toBe(30)
  })

  it('shares a timebox equally among lines that carry no minutes', () => {
    const nodes = [section([[null], [null]], { minutes: 20 }), line(5)]
    const result = scheduleAgenda(nodes, { startsAt: nineChicago, endsAt: null, timeZone: CHICAGO })
    expect(starts(nodes)).toEqual(['09:00', '09:00', '09:10', '09:20'])
    expect(result.totalMinutes).toBe(25)
  })

  it('a timebox is its length: lines with minutes use it up, the rest share what is left', () => {
    const budget = section([[10], [null], [null], [null]], { minutes: 45 })
    const nodes = [budget, line(5)]
    const result = scheduleAgenda(nodes, { startsAt: nineChicago, endsAt: null, timeZone: CHICAGO })
    if (budget.type !== 'section') throw new Error('expected a section')
    // 35 left among three: 12, 12, 11.
    expect(budget.lines.map((one) => one.shareMinutes)).toEqual([undefined, 12, 12, 11])
    expect(starts(nodes)).toEqual(['09:00', '09:00', '09:10', '09:22', '09:34', '09:45'])
    expect(budget).toMatchObject({ minutes: 45, usedMinutes: 10 })
    expect(budget.overBudgetMinutes).toBeUndefined()
    expect(result).toEqual({ totalMinutes: 50, end: '09:50', overflowMinutes: 0 })
  })

  it('reports lines that overrun their timebox, and the next row still starts at its end', () => {
    const budget = section([[30], [25], [null]], { minutes: 45 })
    const nodes = [budget, line(5)]
    const result = scheduleAgenda(nodes, { startsAt: nineChicago, endsAt: null, timeZone: CHICAGO })
    if (budget.type !== 'section') throw new Error('expected a section')
    expect(budget).toMatchObject({ minutes: 45, usedMinutes: 55, overBudgetMinutes: 10 })
    expect(budget.lines[2]!.shareMinutes).toBe(0)
    expect(starts(nodes)).toEqual(['09:00', '09:00', '09:30', '09:55', '09:45'])
    expect(result).toEqual({ totalMinutes: 50, end: '09:50', overflowMinutes: 10 })
  })

  it('a section with no minutes of its own lasts as long as its lines', () => {
    const nodes = [section([[10], [null]]), line(5)]
    scheduleAgenda(nodes, { startsAt: nineChicago, endsAt: null, timeZone: CHICAGO })
    expect(nodes[0]).toMatchObject({ minutes: 10 })
    expect(nodes[0]).not.toHaveProperty('usedMinutes')
    expect(starts(nodes)).toEqual(['09:00', '09:00', '09:10', '09:10'])
  })

  it('leaves an undated stub untimed but still totals it', () => {
    const nodes = [line(10), line(5)]
    const result = scheduleAgenda(nodes, { startsAt: null, endsAt: null })
    expect(starts(nodes)).toEqual([null, null])
    expect(result).toEqual({ totalMinutes: 15, end: null, overflowMinutes: 0 })
  })

  it('a pinned start sets the clock for everything after it', () => {
    const nodes = [line(10), line(10, '10:00'), line(5)]
    const result = scheduleAgenda(nodes, { startsAt: nineChicago, endsAt: null, timeZone: CHICAGO })
    expect(starts(nodes)).toEqual(['09:00', '10:00', '10:10'])
    expect(result.end).toBe('10:15')
    expect(result.overflowMinutes).toBe(0)
  })

  it('a pinned start inside a section and on a section both count', () => {
    const nodes = [section([[10], [10, '09:30']]), section([[5]], { pinnedStart: '10:00' })]
    scheduleAgenda(nodes, { startsAt: nineChicago, endsAt: null, timeZone: CHICAGO })
    expect(starts(nodes)).toEqual(['09:00', '09:00', '09:30', '10:00', '10:00'])
  })

  it('flags what runs past a pinned start', () => {
    const nodes = [line(45), line(10, '09:30')]
    const result = scheduleAgenda(nodes, { startsAt: nineChicago, endsAt: null, timeZone: CHICAGO })
    expect(nodes[1]!.overrunMinutes).toBe(15)
    expect(result.overflowMinutes).toBe(15)
  })

  it('flags an agenda that runs past the meeting\'s end', () => {
    const nodes = [line(40), line(35)]
    const result = scheduleAgenda(nodes, {
      startsAt: nineChicago,
      endsAt: new Date('2026-10-07T15:00:00Z'),
      timeZone: CHICAGO,
    })
    expect(result).toEqual({ totalMinutes: 75, end: '10:15', overflowMinutes: 15 })
  })

  it('shows the meeting\'s own end when nothing is timed', () => {
    const result = scheduleAgenda([line(null)], {
      startsAt: nineChicago,
      endsAt: new Date('2026-10-07T15:00:00Z'),
      timeZone: CHICAGO,
    })
    expect(result.end).toBe('10:00')
  })

  it('counts minutes across the autumn clock change as minutes', () => {
    // 2026-11-01 06:30Z is 1:30 AM CDT, half an hour before the clocks go back.
    const nodes = [line(20), line(20)]
    scheduleAgenda(nodes, { startsAt: new Date('2026-11-01T06:30:00Z'), endsAt: null, timeZone: CHICAGO })
    expect(starts(nodes)).toEqual(['01:30', '01:50'])
  })

  it('wraps past midnight', () => {
    const nodes = [line(45), line(10)]
    const result = scheduleAgenda(nodes, {
      startsAt: new Date('2026-10-08T04:30:00Z'), // 11:30 PM in Chicago
      endsAt: null,
      timeZone: CHICAGO,
    })
    expect(starts(nodes)).toEqual(['23:30', '00:15'])
    expect(result.end).toBe('00:25')
  })
})

describe('brief rendering', () => {
  const mockAgenda: Agenda = {
    meetingId: 'meeting-1',
    nodes: [
      {
        type: 'section',
        id: 'section-1',
        title: 'Welcome',
        pinnedStart: null,
        start: '09:00',
        minutes: 10,
        ownMinutes: 10,
        lines: [
          {
            id: 'line-1',
            text: 'Opening remarks',
            ownText: null,
            item: null,
            description: 'Five minutes each',
            leader: { id: 'person-1', name: 'Sarah', isSelf: false },
            privateNote: 'Keep it brief',
            minutes: 5,
            pinnedStart: null,
            start: '09:00',
          },
          {
            id: 'line-2',
            text: 'Agenda review',
            ownText: null,
            item: null,
            description: null,
            leader: null,
            privateNote: null,
            minutes: 5,
            pinnedStart: null,
            start: '09:05',
          },
        ],
      },
      {
        type: 'line',
        id: 'line-3',
        text: 'Q&A session',
        ownText: null,
        item: {
          id: 'item-1',
          contextId: 'ctx',
          kind: 'question',
          status: 'open',
          text: 'Q&A session',
          detail: null,
          resolution: null,
          project: null,
          dueOn: null,
          parentItemId: null,
          supersededByItemId: null,
          ongoing: false,
          closedAt: null,
          originMeetingId: null,
          targetMeetingId: null,
          targetSeriesId: null,
          targetProjectId: null,
          parkedAt: null,
          laterOn: null,
          laterUntilItemId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          parties: [],
        },
        description: null,
        leader: null,
        privateNote: null,
        minutes: 20,
        pinnedStart: null,
        start: '09:10',
      },
    ],
    totalMinutes: 30,
    end: '09:30',
    overflowMinutes: 0,
  }

  const mockMeeting = {
    title: 'Team standup',
    startsAt: new Date('2026-10-07T09:00:00'),
    people: [{ name: 'Alice' }, { name: 'Bob' }],
  }

  const mockBlocks: GeneratedBlocks = {
    followUps: [
      {
        party: { type: 'person', id: 'alice', name: 'Alice' },
        items: [
          {
            itemId: 'item-2',
            kind: 'action',
            text: 'Fix the bug',
            dueOn: '2026-10-10',
            overdue: false,
          },
        ],
      },
    ],
    sinceLast: null,
    lookahead: null,
  }

  const input = {
    meeting: { ...mockMeeting, startsAt: new Date('2026-10-07T14:00:00Z'), endsAt: new Date('2026-10-07T15:00:00Z') },
    agenda: mockAgenda,
    blocks: mockBlocks,
    timeZone: CHICAGO,
    today: '2026-10-01',
  }

  it('renders the brief with times, private notes and who owes what', () => {
    const brief = renderBrief(input)

    expect(brief.split('\n').slice(0, 2)).toEqual([
      '# Team standup',
      'Wed, Oct 7 · 9:00 AM – 10:00 AM · Alice, Bob',
    ])
    // A section is a bold bullet with its lines nested, so the loose line after it is plainly outside.
    expect(brief).toContain(
      [
        '## Agenda',
        '- **9:00 AM · Welcome (10 min)**',
        '  - 9:00 AM · Opening remarks — Sarah (5 min)',
        '    - Five minutes each',
        '    - Note: Keep it brief',
        '  - 9:05 AM · Agenda review (5 min)',
        '- 9:10 AM · Q&A session [question] (20 min)',
        '',
        'Ends 9:30 AM · 30 min planned',
      ].join('\n'),
    )
    expect(brief).toContain('## Follow-ups due\n\n**Alice**\n- Fix the bug [action, due Oct 10]')
  })

  it("lists a topic's questions beneath it", () => {
    const question = (mockAgenda.nodes[1] as Extract<Agenda['nodes'][number], { type: 'line' }>).item!
    const topic = { ...question, id: 'topic-1', kind: 'topic' as const, text: 'Status update' }
    const agenda: Agenda = {
      ...mockAgenda,
      nodes: [
        {
          type: 'line',
          id: 'line-9',
          text: 'Status update',
          ownText: null,
          item: topic,
          description: null,
          leader: null,
          privateNote: null,
          minutes: null,
          pinnedStart: null,
          start: null,
          questions: [{ ...question, id: 'q-1', text: 'Why is it blocked?' }],
        },
      ],
    }
    expect(renderBrief({ ...input, agenda })).toContain('- Status update\n  - Why is it blocked?')
  })

  it('never writes a kind as a capture prefix', () => {
    // "Q:" and "A:" at the start of a notepad line mean "capture this" to processing.
    expect(renderBrief(input)).not.toMatch(/(^|[-\s])[TQAD]: /m)
  })

  it('renders the public agenda without private notes or follow-ups', () => {
    const agenda = renderAgenda(input)

    expect(agenda).toContain('# Team standup')
    expect(agenda).toContain('- **9:00 AM · Welcome (10 min)**')
    expect(agenda).toContain('- 9:10 AM · Q&A session (20 min)')
    expect(agenda).not.toContain('Keep it brief')
    expect(agenda).not.toContain('Follow-ups due')
    expect(agenda).not.toContain('[question]')
  })

  it("sends a line's description and leader out with the public agenda", () => {
    expect(renderAgenda(input)).toContain(
      ['  - 9:00 AM · Opening remarks — Sarah (5 min)', '    - Five minutes each'].join('\n'),
    )
  })

  it('writes a multi-day meeting as its sessions, one after another', () => {
    const session = (title: string, start: string, end: string) => ({
      title,
      startsAt: new Date(start),
      endsAt: new Date(end),
      agenda: { ...mockAgenda, nodes: [mockAgenda.nodes[1]!] },
    })
    const rollup = {
      ...input,
      meeting: {
        ...mockMeeting,
        startsAt: new Date('2026-10-07T14:00:00Z'),
        endsAt: new Date('2026-10-08T22:00:00Z'),
      },
      agenda: { ...mockAgenda, nodes: [] },
      sessions: [
        session('Day one', '2026-10-07T14:00:00Z', '2026-10-07T17:00:00Z'),
        { ...session('Day two', '2026-10-08T14:00:00Z', '2026-10-08T22:00:00Z'), agenda: { ...mockAgenda, nodes: [] } },
      ],
    }
    const text = renderAgenda(rollup)
    expect(text.split('\n')[1]).toBe('Wed, Oct 7, 9:00 AM – Thu, Oct 8, 5:00 PM · Alice, Bob')
    expect(text).not.toContain('## Agenda')
    expect(text).toContain(
      ['## Day one', 'Wed, Oct 7 · 9:00 AM – 12:00 PM', '- 9:10 AM · Q&A session (20 min)'].join('\n'),
    )
    // A session with nothing on it yet is still named, so the days read in order.
    expect(text).toContain(['## Day two', 'Thu, Oct 8 · 9:00 AM – 5:00 PM'].join('\n'))
  })

  it('leaves times out of an undated stub', () => {
    const untimed: Agenda = {
      ...mockAgenda,
      nodes: mockAgenda.nodes.map((node) =>
        node.type === 'section'
          ? { ...node, start: null, lines: node.lines.map((l) => ({ ...l, start: null })) }
          : { ...node, start: null },
      ),
      end: null,
    }
    const brief = renderBrief({ ...input, meeting: { ...mockMeeting, startsAt: null }, agenda: untimed })
    expect(brief.split('\n')[1]).toBe('Alice, Bob')
    expect(brief).toContain('  - Opening remarks — Sarah (5 min)')
    expect(brief).not.toContain('Ends')
  })

  it('says when the agenda runs over', () => {
    const brief = renderBrief({ ...input, agenda: { ...mockAgenda, overflowMinutes: 15 } })
    expect(brief.split('\n')[1]).toContain('15 min over')
  })

  it('includes the lookahead, by date, in both', () => {
    const blocks: GeneratedBlocks = {
      ...mockBlocks,
      lookahead: {
        milestones: [{ id: 'ms-1', projectName: 'Project X', title: 'Release v1.0', dueOn: '2026-10-31' }],
        deadlines: [
          { itemId: 'i', kind: 'action', text: 'Book the hall', dueOn: '2026-10-20', projectName: 'Project X' },
        ],
        meetings: [{ id: 'm', title: 'Next standup', startsAt: new Date('2026-10-14T14:00:00Z') }],
      },
    }

    for (const text of [renderAgenda({ ...input, blocks }), renderBrief({ ...input, blocks })]) {
      expect(text).toContain(
        [
          '## Lookahead',
          '- Oct 20 · Project X: Book the hall [action]',
          '- Oct 31 · Project X: Release v1.0 [milestone]',
          '- Oct 14, 9:00 AM · Next standup [meeting]',
        ].join('\n'),
      )
    }
  })

  it('writes the same outline as HTML, escaped, with notes nested', () => {
    const html = renderBriefHtml(input)
    expect(html).toContain('<h1>Team standup</h1>')
    expect(html).toContain(
      '<li><strong>9:00 AM · Welcome (10 min)</strong><ul><li>9:00 AM · Opening remarks — Sarah (5 min)<ul><li>Five minutes each</li><li>Note: Keep it brief</li></ul></li>',
    )
    expect(html).toContain('Q&amp;A session')
    expect(renderAgendaHtml(input)).not.toContain('Keep it brief')
  })

  it('exports only the parts chosen', () => {
    const text = toMarkdown(pick(briefOutline(input), new Set(['details', 'notes'])))
    expect(text.split('\n').slice(0, 2)).toEqual(['# Team standup', 'Wed, Oct 7 · 9:00 AM – 10:00 AM'])
    expect(text).toContain(
      ['- **Welcome (10 min)**', '  - Opening remarks — Sarah (5 min)', '    - Five minutes each', '    - Note: Keep it brief'].join(
        '\n',
      ),
    )
    expect(text).not.toContain('Ends')
    expect(text).not.toContain('Follow-ups due')

    const bare = toMarkdown(pick(briefOutline({ ...input, meeting: { ...input.meeting, startsAt: null } }), new Set()))
    // A header line with nothing left in it goes.
    expect(bare.split('\n').slice(0, 3)).toEqual(['# Team standup', '', '## Agenda'])
    expect(bare).toContain('  - Opening remarks (5 min)')
  })

  it('never writes a capture prefix, whatever is chosen', () => {
    const outline = briefOutline(input)
    const keys = EXPORTS.agenda.options.map((option) => option.key)
    for (const key of keys) {
      expect(toMarkdown(pick(outline, new Set([key])))).not.toMatch(/(^|[-\s])[TQAD]: /m)
    }
  })

  it('marks private every part Shareable leaves out', () => {
    const shareable = preset('agenda', 'Shareable')
    for (const option of EXPORTS.agenda.options) {
      expect(!!option.private).toBe(!shareable.has(option.key))
    }
  })
})

describe('outline minutes', () => {
  it('reads minutes only from the end of a title', () => {
    const items = parseOutline(`# Review 3 proposals
## Top 3 priorities
## The 2026 budget
## Budget 2026
## Budget (15m)
## Lunch (45)
## Reports 20 min
## Close 5
## 10`)
    expect(items.map((item) => [item.title, item.minutes])).toEqual([
      ['Review 3 proposals', null],
      ['Top 3 priorities', null],
      ['The 2026 budget', null],
      ['Budget 2026', null],
      ['Budget', 15],
      ['Lunch', 45],
      ['Reports', 20],
      ['Close', 5],
      // A title that is only a number stays a title.
      ['10', null],
    ])
  })
})
