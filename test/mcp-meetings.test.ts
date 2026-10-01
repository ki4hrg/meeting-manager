import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agendaLines, meetingDismissals, meetings, series, users } from '../lib/db/schema'
import { listItems } from '../lib/items/items'
import { db, resetBetweenTests } from './helpers/db'
import { makeWorld } from './helpers/fixtures'
import { connect, dataOf, identityFor, makeUser, textOf, type ConnectedClient } from './helpers/mcp'

resetBetweenTests()

type World = Awaited<ReturnType<typeof makeWorld>>
type Named = { id: string; name: string }
type Item = {
  id: string
  text: string
  context_id: string
  target_meeting_id: string | null
  target_series_id: string | null
  origin_meeting_id: string | null
}
type Line = {
  id: string
  text: string
  item_id: string | null
  item_kind: string | null
  minutes: number | null
  pinned_start: string | null
  start: string | null
  private_note: string | null
}
type Row =
  | ({ type: 'line' } & Line)
  | { type: 'section'; id: string; title: string; minutes: number | null; start: string | null; lines: Line[] }
type Candidate = { id: string; kind: string; text: string; due_on: string | null }
type CandidateGroup = { by: { type: string; id: string; name: string }; items: Candidate[] }
type Meeting = {
  id: string
  context_id: string
  title: string
  starts_at: string | null
  starts_at_local: string | null
  ends_at: string | null
  ends_at_local: string | null
  series: Named | null
  group: Named | null
  people: Named[]
  projects: Named[]
}
type View = {
  meeting: Meeting & { blocks: { follow_ups: boolean; since_last: boolean; lookahead: boolean } }
  agenda: { rows: Row[]; total_minutes: number; end: string | null; overflow_minutes: number }
  candidates: {
    to_place: Candidate[]
    suggested: CandidateGroup[]
    more: CandidateGroup[]
    dismissed: Candidate[]
  }
}
type Series = {
  id: string
  context_id: string
  name: string
  group: Named | null
  people: Named[]
  projects: Named[]
  skeleton: { title: string; lines: { text: string; minutes: number | null }[] }[]
  blocks: { follow_ups: boolean; since_last: boolean; lookahead: boolean }
}

let world: World
let connection: ConnectedClient

beforeEach(async () => {
  world = await makeWorld()
  const userId = await makeUser()
  // Not UTC and not the machine's zone, so a rendering that ignored it would show.
  await db.update(users).set({ timeZone: 'America/Chicago' }).where(eq(users.id, userId))
  connection = await connect(identityFor(userId))
})
afterEach(() => connection.close())

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await connection.client.callTool({ name, arguments: args })) as CallToolResult
}

/* The data of a call that must have worked; a refusal fails with its own text. */
async function ok<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = await call(name, args)
  expect(result.isError, textOf(result)).toBeFalsy()
  return dataOf<T>(result)
}

async function refusal(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await call(name, args)
  expect(result.isError).toBe(true)
  return textOf(result)
}

async function capture(args: Record<string, unknown>): Promise<Item> {
  return (await ok<{ item: Item }>('capture_item', args)).item
}

/* The agenda reduced to what a test compares: titles and texts, in order. */
function shape(view: View): unknown[] {
  return view.agenda.rows.map((row) =>
    row.type === 'line' ? row.text : { [row.title]: row.lines.map((line) => line.text) },
  )
}

function sectionOf(view: View, title: string) {
  const row = view.agenda.rows.find((r) => r.type === 'section' && r.title === title)
  if (!row || row.type !== 'section') throw new Error(`no section ${title}`)
  return row
}

function lineOf(view: View, text: string): Line {
  const all = view.agenda.rows.flatMap((row) => (row.type === 'line' ? [row] : row.lines))
  const line = all.find((candidate) => candidate.text === text)
  if (!line) throw new Error(`no line ${text}`)
  return line
}

describe('prep_meeting', () => {
  it('preps a stub with a person, places what is saved up for them, and does it once', async () => {
    const raise = await capture({ text: 'Ask about the rota', context: 'Parish', with: ['sarah'] })
    const owed = await capture({
      text: 'Send the budget',
      kind: 'action',
      context: 'Parish',
      owners: ['sarah'],
    })
    await capture({ text: 'For Tom only', context: 'Parish', with: ['tom'] })

    const first = await ok<View>('prep_meeting', { context: 'Parish', person: 'sarah' })
    expect(first.meeting).toMatchObject({
      context_id: world.parish.id,
      title: 'Sarah Jones',
      starts_at: null,
      starts_at_local: null,
      series: null,
      people: [{ id: world.sarah.id, name: 'Sarah Jones' }],
    })
    expect(first.agenda.rows).toHaveLength(1)
    expect(first.agenda.rows[0]).toMatchObject({
      type: 'line',
      text: 'Ask about the rota',
      item_id: raise.id,
      item_kind: 'topic',
    })
    // What she owes is offered in a 1:1, not placed.
    expect(first.candidates.to_place).toEqual([])
    expect(first.candidates.suggested).toEqual([
      {
        by: { type: 'person', id: world.sarah.id, name: 'Sarah Jones' },
        items: [{ id: owed.id, kind: 'action', text: 'Send the budget', due_on: null }],
      },
    ])
    expect(first.candidates.more).toEqual([])

    const later = await capture({ text: 'Thank her for Sunday', context: 'Parish', with: ['sarah'] })
    const second = await ok<View>('prep_meeting', { context: 'Parish', person: 'Sarah Jones' })
    expect(second.meeting.id).toBe(first.meeting.id)
    expect(second.agenda.rows.map((row) => (row.type === 'line' ? row.item_id : null))).toEqual([
      raise.id,
      later.id,
    ])

    const third = await ok<View>('prep_meeting', { context: 'Parish', person: 'sarah' })
    expect(third.agenda.rows).toHaveLength(2)
    expect(await db.select().from(meetings)).toHaveLength(1)
  })

  it('refuses a person with other fields, a group as a person, and nothing at all', async () => {
    expect(await refusal('prep_meeting', { context: 'Parish', person: 'sarah', title: 'x' })).toContain(
      'takes nothing else',
    )
    expect(await refusal('prep_meeting', { context: 'Parish', person: 'staff' })).toContain(
      'No person matches staff',
    )
    expect(await refusal('prep_meeting', { context: 'Parish' })).toContain('Say what to prep')
    expect(await refusal('prep_meeting', { person: 'sarah' })).toContain('Parish, Diocese')
    expect(await db.select().from(meetings)).toHaveLength(0)
  })

  it('reads a time with no offset on the account clock and renders it there', async () => {
    const local = await ok<View>('prep_meeting', {
      context: 'Parish',
      title: 'Planning',
      starts_at: '2030-03-05T09:00',
      ends_at: '2030-03-05T10:30',
      people: ['sarah', 'tom', 'me'],
      projects: ['retreat'],
    })
    expect(local.meeting).toMatchObject({
      title: 'Planning',
      starts_at: '2030-03-05T15:00:00.000Z',
      starts_at_local: 'Tue, Mar 5, 2030, 9:00 AM',
      ends_at: '2030-03-05T16:30:00.000Z',
      ends_at_local: 'Tue, Mar 5, 2030, 10:30 AM',
      // John is at every meeting and is never listed.
      people: [
        { id: world.sarah.id, name: 'Sarah Jones' },
        { id: world.tom.id, name: 'Tom Baker' },
      ],
      projects: [{ id: world.retreat.id, name: 'Retreat' }],
    })

    // 03:30 UTC on the 6th is still the evening of the 5th in Chicago.
    const instant = await ok<View>('prep_meeting', {
      context: 'Parish',
      title: 'Late call',
      starts_at: '2030-03-06T03:30:00Z',
    })
    expect(instant.meeting.starts_at).toBe('2030-03-06T03:30:00.000Z')
    expect(instant.meeting.starts_at_local).toBe('Tue, Mar 5, 2030, 9:30 PM')

    expect(
      await refusal('prep_meeting', { context: 'Parish', title: 'x', starts_at: 'next tuesday' }),
    ).toContain('is not a date and time')
  })

  it('takes its roster from the group when no people are given', async () => {
    const view = await ok<View>('prep_meeting', { title: 'Staff catch-up', group: 'staff' })
    // The context came from the group: there is no Staff in the Diocese.
    expect(view.meeting).toMatchObject({
      context_id: world.parish.id,
      group: { id: world.staff.id, name: 'Staff' },
    })
    expect(view.meeting.people.map((person) => person.name)).toEqual(['Sarah Jones', 'Tom Baker'])
  })
})

describe('list_meetings', () => {
  it('lists one context at a time, by when and by filter', async () => {
    const planning = await ok<View>('prep_meeting', {
      context: 'Parish',
      title: 'Planning',
      starts_at: '2030-03-05T09:00',
      people: ['sarah'],
      projects: ['retreat'],
    })
    const earlier = await ok<View>('prep_meeting', {
      context: 'Parish',
      title: 'Vestry',
      starts_at: '2030-02-01T18:00',
      group: 'staff',
    })
    const old = await ok<View>('prep_meeting', {
      context: 'Parish',
      title: 'Last year',
      starts_at: '2020-01-07T09:00',
    })
    const stub = await ok<View>('prep_meeting', { context: 'Parish', person: 'tom' })
    const synod = await ok<View>('prep_meeting', {
      context: 'Diocese',
      title: 'Synod prep',
      starts_at: '2030-03-05T09:00',
      people: ['sarah'],
    })

    const list = async (args: Record<string, unknown>) =>
      (await ok<{ context: Named; meetings: Meeting[] }>('list_meetings', args)).meetings.map(
        (meeting) => meeting.id,
      )

    const upcoming = await ok<{ context: Named; meetings: Meeting[] }>('list_meetings', {
      context: 'Parish',
    })
    expect(upcoming.context).toEqual({ id: world.parish.id, name: 'Parish' })
    expect(upcoming.meetings.map((meeting) => meeting.id)).toEqual([
      earlier.meeting.id,
      planning.meeting.id,
    ])
    expect(upcoming.meetings[1]).toEqual({
      id: planning.meeting.id,
      context_id: world.parish.id,
      title: 'Planning',
      starts_at: '2030-03-05T15:00:00.000Z',
      starts_at_local: 'Tue, Mar 5, 2030, 9:00 AM',
      ends_at: null,
      ends_at_local: null,
      series: null,
      group: null,
      people: [{ id: world.sarah.id, name: 'Sarah Jones' }],
      projects: [{ id: world.retreat.id, name: 'Retreat' }],
      parent_meeting_id: null,
    })

    expect(await list({ context: 'Diocese' })).toEqual([synod.meeting.id])
    expect(await list({ context: 'Parish', when: 'past' })).toEqual([old.meeting.id])
    expect(await list({ context: 'Parish', when: 'stubs' })).toEqual([stub.meeting.id])
    // Sarah is in both contexts' meetings; only this context's come back.
    expect(await list({ context: 'Parish', person: 'sarah' })).toEqual([
      earlier.meeting.id,
      planning.meeting.id,
    ])
    expect(await list({ context: 'Parish', project: 'retreat' })).toEqual([planning.meeting.id])
    expect(await list({ group: 'staff' })).toEqual([earlier.meeting.id])
    expect(await list({ context: 'Parish', limit: 1 })).toEqual([earlier.meeting.id])

    expect(await refusal('list_meetings', {})).toContain('Parish, Diocese')
  })
})

describe('context isolation', () => {
  it('refuses an id or a name from another context, as the item tools do', async () => {
    const weekly = (
      await ok<{ series: Series }>('create_series', { context: 'Parish', name: 'Weekly' })
    ).series
    await ok<{ series: Series }>('create_series', { context: 'Diocese', name: 'Chapter' })

    // An id from the Parish, asked for in the Diocese.
    expect(await refusal('list_meetings', { context: 'Diocese', series: weekly.id })).toContain(
      `No series in this context has the id ${weekly.id}`,
    )
    expect(await refusal('prep_meeting', { context: 'Diocese', series: weekly.id })).toContain(
      'No series in this context has the id',
    )
    expect(await refusal('update_series', { context: 'Diocese', series: 'weekly' })).toContain(
      'No series matches weekly',
    )
    expect(await refusal('list_meetings', { context: 'Diocese', project: 'retreat' })).toContain(
      'No project matches retreat',
    )
    expect(await refusal('list_meetings', { context: 'Diocese', group: 'staff' })).toContain(
      'No group matches staff',
    )
    expect(await db.select().from(meetings)).toHaveLength(0)

    // With no context given, a series found in only one context decides it.
    const prepped = await ok<View>('prep_meeting', { series: 'weekly' })
    expect(prepped.meeting.context_id).toBe(world.parish.id)

    // The same name in both contexts decides nothing.
    await ok<{ series: Series }>('create_series', { context: 'Diocese', name: 'Weekly' })
    expect(await refusal('prep_meeting', { series: 'weekly' })).toContain(
      'Say which context this belongs to: Parish, Diocese',
    )
    const there = await ok<View>('prep_meeting', { context: 'Diocese', series: 'weekly' })
    expect(there.meeting.context_id).toBe(world.diocese.id)
    expect(there.meeting.id).not.toBe(prepped.meeting.id)
  })

  it('keeps items, lines and targets inside the meeting’s context', async () => {
    const parish = await ok<View>('prep_meeting', { context: 'Parish', title: 'Parish meeting' })
    const diocese = await ok<View>('prep_meeting', { context: 'Diocese', title: 'Diocese meeting' })
    const theirs = await capture({ text: 'A diocesan matter', context: 'Diocese' })
    const line = lineOf(
      await ok<View>('edit_agenda', { id: diocese.meeting.id, op: 'add_line', text: 'Their line' }),
      'Their line',
    )

    const id = parish.meeting.id
    expect(await refusal('edit_agenda', { id, op: 'place_item', item_id: theirs.id })).toContain(
      'another context',
    )
    expect(await refusal('edit_agenda', { id, op: 'add_line', item_id: theirs.id })).toContain(
      'different context',
    )
    expect(await refusal('edit_agenda', { id, op: 'dismiss_item', item_id: theirs.id })).toContain(
      'another context',
    )
    expect(
      await refusal('set_agenda', { id, lines: [{ text: 'Mine' }, { item_id: theirs.id }] }),
    ).toContain('different context')
    // A line of another meeting cannot be edited, moved or removed through this one.
    for (const op of ['update_line', 'move_line', 'remove_line']) {
      const args = op === 'update_line' ? { text: 'Changed' } : {}
      expect(await refusal('edit_agenda', { id, op, line_id: line.id, ...args })).toContain(
        'No line or section on this agenda has the id',
      )
    }
    expect(
      await refusal('edit_agenda', { id, op: 'add_line', text: 'x', section_id: line.id }),
    ).toContain('not on this agenda')

    // Nothing was written by any of the refusals.
    expect((await ok<View>('get_meeting', { id })).agenda.rows).toEqual([])
    expect(shape(await ok<View>('get_meeting', { id: diocese.meeting.id }))).toEqual(['Their line'])
    expect(await db.select().from(meetingDismissals)).toHaveLength(0)

    // A target in another context is refused, and the item is not captured.
    expect(
      await refusal('capture_item', { text: 'Stray', context: 'Diocese', target_meeting: id }),
    ).toContain('That meeting belongs to another context')
    expect(
      await refusal('update_item', { id: theirs.id, target_meeting: id }),
    ).toContain('That meeting belongs to another context')
    expect(await listItems(db, { contextId: world.diocese.id })).toHaveLength(1)
    expect(await listItems(db, { contextId: world.parish.id })).toHaveLength(0)
  })
})

describe('set_agenda', () => {
  it('imports an outline, keeps placed items, and replaces what was typed', async () => {
    const raise = await capture({ text: 'Ask about the rota', context: 'Parish', with: ['sarah'] })
    const stub = await ok<View>('prep_meeting', { context: 'Parish', person: 'sarah' })
    const id = stub.meeting.id
    const itemLine = stub.agenda.rows[0]!.id
    await ok<View>('update_meeting', {
      id,
      starts_at: '2030-03-05T09:00',
      ends_at: '2030-03-05T09:15',
    })

    const outline = '# Opening 5\n## Prayer\n# Business\n## Budget 15\nask about the roof'
    const first = await ok<View>('set_agenda', { id, outline })
    expect(shape(first)).toEqual([
      'Ask about the rota',
      { Opening: ['Prayer'] },
      { Business: ['Budget'] },
    ])
    // The item's line is the same row, not a new one.
    expect(first.agenda.rows[0]).toMatchObject({ id: itemLine, item_id: raise.id, start: '09:00' })
    expect(sectionOf(first, 'Opening')).toMatchObject({ minutes: 5, start: '09:00' })
    expect(sectionOf(first, 'Business')).toMatchObject({ minutes: 15, start: '09:05' })
    expect(lineOf(first, 'Budget')).toMatchObject({
      minutes: 15,
      start: '09:05',
      private_note: 'ask about the roof',
      item_id: null,
      item_kind: null,
    })
    // 20 minutes planned in a 15 minute meeting.
    expect(first.agenda).toMatchObject({ total_minutes: 20, end: '09:20', overflow_minutes: 5 })

    const second = await ok<View>('set_agenda', { id, outline: '- Welcome\n- Farewell 10' })
    expect(shape(second)).toEqual(['Ask about the rota', 'Welcome', 'Farewell'])
    expect(second.agenda.rows[0]!.id).toBe(itemLine)
    expect(lineOf(second, 'Farewell').minutes).toBe(10)

    const appended = await ok<View>('set_agenda', { id, outline: '- One more', replace: false })
    expect(shape(appended)).toEqual(['Ask about the rota', 'Welcome', 'Farewell', 'One more'])
    expect(appended.candidates.dismissed).toEqual([])
  })

  it('builds sections and lines, moving a placed item into place and keeping the rest', async () => {
    const a = await capture({ text: 'Item A', context: 'Parish', with: ['sarah'] })
    const b = await capture({ text: 'Item B', context: 'Parish', with: ['sarah'] })
    const c = await capture({ text: 'Item C', kind: 'question', context: 'Parish' })
    const stub = await ok<View>('prep_meeting', { context: 'Parish', person: 'sarah' })
    const id = stub.meeting.id
    expect(shape(stub)).toEqual(['Item A', 'Item B'])
    const lineA = lineOf(stub, 'Item A').id
    const lineB = lineOf(stub, 'Item B').id

    const built = await ok<View>('set_agenda', {
      id,
      lines: [{ text: 'Welcome', pinned_start: '09:00' }],
      sections: [
        {
          title: 'Catch up',
          lines: [
            { item_id: a.id, minutes: 10, private_note: 'push on this' },
            { text: 'Holiday cover', minutes: 5 },
            { item_id: c.id, text: 'The open question' },
          ],
        },
        { title: 'Close', minutes: 5 },
      ],
    })
    // B was not mentioned: it stays, loose, above what was written.
    expect(shape(built)).toEqual([
      'Item B',
      'Welcome',
      { 'Catch up': ['Item A', 'Holiday cover', 'The open question'] },
      { Close: [] },
    ])
    expect(built.agenda.rows[0]!.id).toBe(lineB)
    expect(lineOf(built, 'Item A')).toMatchObject({
      id: lineA,
      item_id: a.id,
      minutes: 10,
      private_note: 'push on this',
      start: '09:00',
    })
    expect(lineOf(built, 'Welcome')).toMatchObject({ pinned_start: '09:00', start: '09:00' })
    expect(lineOf(built, 'Holiday cover')).toMatchObject({ item_id: null, minutes: 5, start: '09:10' })
    expect(lineOf(built, 'The open question')).toMatchObject({ item_id: c.id, item_kind: 'question' })
    expect(sectionOf(built, 'Close')).toMatchObject({ minutes: 5, start: '09:15' })
    expect(built.agenda.total_minutes).toBe(20)
    expect(built.candidates.dismissed).toEqual([])

    // Replacing again: the sections go, every placed item stays, none is dismissed.
    const rebuilt = await ok<View>('set_agenda', {
      id,
      sections: [{ title: 'Only', lines: [{ text: 'One thing' }, { item_id: b.id }] }],
    })
    expect(shape(rebuilt)).toEqual([
      'Item A',
      'The open question',
      { Only: ['One thing', 'Item B'] },
    ])
    expect(lineOf(rebuilt, 'Item B').id).toBe(lineB)
    // What was not restated on a moved line is kept.
    expect(lineOf(rebuilt, 'Item A')).toMatchObject({ id: lineA, private_note: 'push on this' })
    expect(rebuilt.candidates.dismissed).toEqual([])
    expect(await db.select().from(meetingDismissals)).toHaveLength(0)
    expect(await db.select().from(agendaLines)).toHaveLength(5)

    const added = await ok<View>('set_agenda', { id, replace: false, lines: [{ text: 'PS' }] })
    expect(shape(added)).toEqual([
      'Item A',
      'The open question',
      { Only: ['One thing', 'Item B'] },
      'PS',
    ])

    const cleared = await ok<View>('set_agenda', { id, sections: [] })
    expect(shape(cleared)).toEqual(['Item A', 'The open question', 'Item B'])
  })

  it('refuses a muddled call and writes nothing', async () => {
    const item = await capture({ text: 'Item A', context: 'Parish' })
    const { meeting } = await ok<View>('prep_meeting', { context: 'Parish', title: 'M' })
    const id = meeting.id
    await ok<View>('set_agenda', { id, lines: [{ text: 'Keep me' }] })

    expect(await refusal('set_agenda', { id })).toContain('outline text, or as sections and lines')
    expect(await refusal('set_agenda', { id, outline: '- a', lines: [{ text: 'b' }] })).toContain(
      'not both',
    )
    expect(
      await refusal('set_agenda', { id, lines: [{ item_id: item.id }, { item_id: item.id }] }),
    ).toContain('listed twice')
    expect(await refusal('set_agenda', { id, lines: [{ minutes: 5 }] })).toContain(
      'A line needs text or an item_id',
    )
    expect(
      await refusal('set_agenda', { id, lines: [{ text: 'x', pinned_start: '9am' }] }),
    ).toContain('HH:MM')
    // The second line fails after the first was written: the whole call rolls back.
    expect(
      await refusal('set_agenda', {
        id,
        lines: [{ text: 'New' }, { item_id: '00000000-0000-4000-8000-000000000000' }],
      }),
    ).toContain('not found')

    expect(shape(await ok<View>('get_meeting', { id }))).toEqual(['Keep me'])
  })
})

describe('edit_agenda', () => {
  it('adds, updates, moves, removes, places, dismisses and restores', async () => {
    const venue = await capture({
      text: 'Book the venue',
      kind: 'action',
      project: 'retreat',
      owners: ['tom'],
      due_on: '2030-04-01',
    })
    const prepped = await ok<View>('prep_meeting', {
      context: 'Parish',
      title: 'Planning',
      starts_at: '2030-03-05T09:00',
      ends_at: '2030-03-05T09:30',
      people: ['sarah', 'tom'],
      projects: ['retreat'],
    })
    const id = prepped.meeting.id
    const suggestion = {
      by: { type: 'project', id: world.retreat.id, name: 'Retreat' },
      items: [{ id: venue.id, kind: 'action', text: 'Book the venue', due_on: '2030-04-01' }],
    }
    expect(prepped.agenda.rows).toEqual([])
    expect(prepped.candidates.suggested).toEqual([suggestion])
    const edit = (args: Record<string, unknown>) => ok<View>('edit_agenda', { id, ...args })

    // add_line: a section, a line in it, a loose line.
    let view = await edit({ op: 'add_line', as_section: true, text: 'Opening' })
    const opening = sectionOf(view, 'Opening').id
    view = await edit({ op: 'add_line', text: 'Prayer', section_id: opening, minutes: 5 })
    view = await edit({ op: 'add_line', text: 'AOB' })
    expect(shape(view)).toEqual([{ Opening: ['Prayer'] }, 'AOB'])
    const prayer = lineOf(view, 'Prayer').id
    const aob = lineOf(view, 'AOB').id

    // update_line
    view = await edit({
      op: 'update_line',
      line_id: aob,
      text: 'Any other business',
      minutes: 10,
      private_note: 'keep it short',
      pinned_start: '09:20',
    })
    expect(lineOf(view, 'Any other business')).toEqual({
      type: 'line',
      id: aob,
      text: 'Any other business',
      item_id: null,
      item_kind: null,
      item_status: null,
      minutes: 10,
      pinned_start: '09:20',
      start: '09:20',
      private_note: 'keep it short',
    })
    view = await edit({ op: 'update_line', line_id: aob, pinned_start: null, private_note: null })
    expect(lineOf(view, 'Any other business')).toMatchObject({
      pinned_start: null,
      private_note: null,
      minutes: 10,
      start: '09:05',
    })
    view = await edit({ op: 'update_line', line_id: opening, text: 'Welcome' })
    expect(shape(view)).toEqual([{ Welcome: ['Prayer'] }, 'Any other business'])

    // move_line: to the front, out of a section, and back in.
    view = await edit({ op: 'move_line', line_id: aob, position: 0 })
    expect(shape(view)).toEqual(['Any other business', { Welcome: ['Prayer'] }])
    view = await edit({ op: 'move_line', line_id: prayer, section_id: null })
    expect(shape(view)).toEqual(['Any other business', { Welcome: [] }, 'Prayer'])
    view = await edit({ op: 'move_line', line_id: prayer, section_id: opening, position: 0 })
    expect(shape(view)).toEqual(['Any other business', { Welcome: ['Prayer'] }])

    // place_item, straight into the section with its minutes.
    view = await edit({ op: 'place_item', item_id: venue.id, section_id: opening, minutes: 20 })
    expect(shape(view)).toEqual(['Any other business', { Welcome: ['Prayer', 'Book the venue'] }])
    expect(lineOf(view, 'Book the venue')).toMatchObject({
      item_id: venue.id,
      item_kind: 'action',
      item_status: 'open',
      minutes: 20,
      start: '09:15',
    })
    expect(view.candidates.suggested).toEqual([])
    // 10 + 5 + 20 minutes from 09:00, in a meeting that ends at 09:30.
    expect(view.agenda).toMatchObject({ total_minutes: 35, end: '09:35', overflow_minutes: 5 })
    // Placing what is already placed changes nothing.
    view = await edit({ op: 'place_item', item_id: venue.id })
    expect(shape(view)).toEqual(['Any other business', { Welcome: ['Prayer', 'Book the venue'] }])

    // dismiss_item is for what is not on the agenda.
    expect(await refusal('edit_agenda', { id, op: 'dismiss_item', item_id: venue.id })).toContain(
      'remove_line',
    )

    // remove_line on an item line dismisses it; restore_item and dismiss_item undo and redo that.
    view = await edit({ op: 'remove_line', line_id: lineOf(view, 'Book the venue').id })
    expect(shape(view)).toEqual(['Any other business', { Welcome: ['Prayer'] }])
    expect(view.candidates.suggested).toEqual([])
    expect(view.candidates.dismissed).toEqual(suggestion.items)
    view = await edit({ op: 'restore_item', item_id: venue.id })
    expect(view.candidates.suggested).toEqual([suggestion])
    expect(view.candidates.dismissed).toEqual([])
    view = await edit({ op: 'dismiss_item', item_id: venue.id })
    expect(view.candidates.suggested).toEqual([])
    expect(view.candidates.dismissed).toEqual(suggestion.items)

    // Removing a section takes its lines.
    view = await edit({ op: 'remove_line', line_id: opening })
    expect(shape(view)).toEqual(['Any other business'])
    expect(await db.select().from(agendaLines)).toHaveLength(1)
  })

  it('refuses an op without what it needs, or with what it does not take', async () => {
    const { meeting } = await ok<View>('prep_meeting', { context: 'Parish', title: 'M' })
    const id = meeting.id
    const view = await ok<View>('edit_agenda', { id, op: 'add_line', text: 'Only line' })
    const line = lineOf(view, 'Only line').id

    expect(await refusal('edit_agenda', { id, op: 'update_line', text: 'x' })).toContain(
      'update_line needs line_id',
    )
    expect(await refusal('edit_agenda', { id, op: 'update_line', line_id: line })).toContain(
      'needs something to change',
    )
    expect(await refusal('edit_agenda', { id, op: 'remove_line', line_id: line, text: 'x' })).toContain(
      'remove_line does not take text',
    )
    expect(await refusal('edit_agenda', { id, op: 'place_item' })).toContain('place_item needs item_id')
    expect(await refusal('edit_agenda', { id, op: 'add_line' })).toContain(
      'A line needs text or an item reference',
    )
    expect(await refusal('edit_agenda', { id, op: 'tidy' })).toContain('not valid for edit_agenda')
    expect(
      await refusal('edit_agenda', { id: '00000000-0000-4000-8000-000000000000', op: 'add_line', text: 'x' }),
    ).toContain('not found')

    expect(shape(await ok<View>('get_meeting', { id }))).toEqual(['Only line'])
  })
})

describe('update_meeting', () => {
  it('changes the meeting, and null on the start makes it a stub again', async () => {
    const weekly = (
      await ok<{ series: Series }>('create_series', {
        context: 'Parish',
        name: 'Weekly',
        blocks: { follow_ups: true },
      })
    ).series
    const { meeting } = await ok<View>('prep_meeting', {
      context: 'Parish',
      title: 'Planning',
      starts_at: '2030-03-05T09:00',
      ends_at: '2030-03-05T10:00',
      people: ['sarah'],
    })
    expect(meeting.blocks).toEqual({ follow_ups: false, since_last: false, lookahead: false })

    const updated = await ok<View>('update_meeting', {
      id: meeting.id,
      title: 'Planning day',
      starts_at: '2030-03-06T13:00',
      ends_at: '2030-03-06T14:00',
      people: ['tom', 'bishop'],
      projects: ['retreat', 'campaign'],
      group: 'staff',
      series: 'weekly',
      blocks: { lookahead: true },
    })
    expect(updated.meeting).toMatchObject({
      id: meeting.id,
      title: 'Planning day',
      starts_at: '2030-03-06T19:00:00.000Z',
      starts_at_local: 'Wed, Mar 6, 2030, 1:00 PM',
      ends_at_local: 'Wed, Mar 6, 2030, 2:00 PM',
      people: [
        { id: world.bishop.id, name: 'Bishop Wright' },
        { id: world.tom.id, name: 'Tom Baker' },
      ],
      projects: [
        { id: world.campaign.id, name: 'Capital campaign' },
        { id: world.retreat.id, name: 'Retreat' },
      ],
      group: { id: world.staff.id, name: 'Staff' },
      series: { id: weekly.id, name: 'Weekly' },
      blocks: { follow_ups: false, since_last: false, lookahead: true },
    })

    // null hands the blocks back to the series.
    const inherited = await ok<View>('update_meeting', { id: meeting.id, blocks: null })
    expect(inherited.meeting.blocks).toEqual({ follow_ups: true, since_last: false, lookahead: false })

    expect(
      await refusal('update_meeting', { id: meeting.id, ends_at: '2030-03-06T12:00' }),
    ).toContain('End time must not be before start time')
    expect(
      await refusal('update_meeting', { id: meeting.id, starts_at: '2030-03-07T09:00' }),
    ).toContain('End time must not be before start time')

    const stub = await ok<View>('update_meeting', {
      id: meeting.id,
      starts_at: null,
      group: null,
      series: null,
    })
    expect(stub.meeting).toMatchObject({
      starts_at: null,
      starts_at_local: null,
      ends_at: null,
      group: null,
      series: null,
      title: 'Planning day',
    })
    const [row] = await db.select().from(meetings).where(eq(meetings.id, meeting.id))
    expect(row).toMatchObject({ startsAt: null, endsAt: null, groupId: null, seriesId: null })

    expect(await refusal('update_meeting', { id: meeting.id, people: ['staff'] })).toContain(
      'No person matches staff',
    )
  })
})

describe('get_briefing', () => {
  it('carries the private note and placed follow-ups, and nothing an attendee owes in private', async () => {
    const budget = await capture({
      text: 'Send the budget',
      kind: 'action',
      context: 'Parish',
      owners: ['sarah'],
      due_on: '2020-01-01',
    })
    await capture({
      text: 'Explain the missing petty cash',
      kind: 'question',
      context: 'Parish',
      owners: ['sarah'],
    })
    const venue = await capture({ text: 'Book the venue', kind: 'action', project: 'retreat' })

    const { meeting } = await ok<View>('prep_meeting', {
      context: 'Parish',
      title: 'Planning',
      starts_at: '2030-03-05T09:00',
      people: ['sarah', 'tom'],
      projects: ['retreat'],
    })
    const id = meeting.id
    const view = await ok<View>('set_agenda', {
      id,
      lines: [
        { text: 'Numbers', minutes: 10, private_note: 'Check the totals first' },
        { item_id: budget.id },
      ],
    })
    // In a meeting of three, what Sarah alone owes is reachable but never offered.
    expect(view.candidates.more.map((group) => group.items.map((item) => item.text))).toEqual([
      ['Explain the missing petty cash'],
    ])

    type Brief = {
      meeting: Meeting
      markdown: string
      blocks: {
        follow_ups: { party: { type: string; id: string; name: string }; items: unknown[] }[] | null
        since_last: unknown
        lookahead: unknown
      }
      suggested: CandidateGroup[]
    }

    // The blocks are off on a meeting with no series.
    const plain = await call('get_briefing', { id })
    const off = dataOf<Brief>(plain)
    expect(off.blocks).toEqual({ follow_ups: null, since_last: null, lookahead: null })
    expect(off.markdown).toContain('Planning')
    expect(off.markdown).toContain('Numbers')
    expect(off.markdown).toContain('Check the totals first')
    expect(off.markdown).toContain('Send the budget')
    expect(off.markdown).toContain('9:00 AM')
    expect(off.meeting.starts_at_local).toBe('Tue, Mar 5, 2030, 9:00 AM')
    expect(off.suggested).toEqual([
      {
        by: { type: 'project', id: world.retreat.id, name: 'Retreat' },
        items: [{ id: venue.id, kind: 'action', text: 'Book the venue', due_on: null }],
      },
    ])
    expect(textOf(plain)).not.toContain('petty cash')

    const forced = await call('get_briefing', { id, blocks: { follow_ups: true } })
    const on = dataOf<Brief>(forced)
    expect(on.blocks.follow_ups).toEqual([
      {
        party: { type: 'person', id: world.sarah.id, name: 'Sarah Jones' },
        items: [
          {
            item_id: budget.id,
            kind: 'action',
            text: 'Send the budget',
            due_on: '2020-01-01',
            overdue: true,
          },
        ],
      },
    ])
    expect(on.markdown).toContain('Sarah Jones')
    // The leak rule: nowhere in the brief, as data or as text.
    expect(textOf(forced)).not.toContain('petty cash')
    expect(JSON.stringify(forced.structuredContent)).not.toContain('petty cash')

    // The override was for that render only.
    const after = await ok<View>('get_meeting', { id })
    expect(after.meeting.blocks).toEqual({ follow_ups: false, since_last: false, lookahead: false })
  })
})

describe('series', () => {
  it('creates, updates and lists a series, and prep lays its skeleton down once', async () => {
    const created = (
      await ok<{ series: Series }>('create_series', {
        context: 'Parish',
        name: 'Staff meeting',
        group: 'staff',
        people: ['sarah', 'tom'],
        projects: ['retreat'],
        skeleton: [{ title: 'Opening', lines: [{ text: 'Prayer', minutes: 5 }] }],
        blocks: { follow_ups: true },
      })
    ).series
    expect(created).toEqual({
      id: created.id,
      context_id: world.parish.id,
      name: 'Staff meeting',
      group: { id: world.staff.id, name: 'Staff' },
      people: [
        { id: world.sarah.id, name: 'Sarah Jones' },
        { id: world.tom.id, name: 'Tom Baker' },
      ],
      projects: [{ id: world.retreat.id, name: 'Retreat' }],
      skeleton: [{ title: 'Opening', lines: [{ text: 'Prayer', minutes: 5 }] }],
      blocks: { follow_ups: true, since_last: false, lookahead: false },
    })

    expect(await refusal('create_series', { context: 'Parish', name: 'staff meeting' })).toContain(
      'already a series',
    )
    expect(
      await refusal('update_series', {
        series: 'staff',
        skeleton: [],
        skeleton_outline: '# A',
      }),
    ).toContain('not both')

    const updated = (
      await ok<{ series: Series }>('update_series', {
        series: 'staff',
        name: 'Staff weekly',
        people: ['sarah'],
        projects: [],
        group: null,
        skeleton_outline: '# Opening\n## Prayer 5\n# Reports\n## Finance 10\n## Buildings',
        blocks: { lookahead: true },
      })
    ).series
    expect(updated).toEqual({
      id: created.id,
      context_id: world.parish.id,
      name: 'Staff weekly',
      group: null,
      people: [{ id: world.sarah.id, name: 'Sarah Jones' }],
      projects: [],
      skeleton: [
        { title: 'Opening', lines: [{ text: 'Prayer', minutes: 5 }] },
        {
          title: 'Reports',
          lines: [
            { text: 'Finance', minutes: 10 },
            { text: 'Buildings', minutes: null },
          ],
        },
      ],
      blocks: { follow_ups: true, since_last: false, lookahead: true },
    })

    const listed = await ok<{ context: Named; series: Series[] }>('list_series', { context: 'Parish' })
    expect(listed.series).toEqual([updated])
    expect(
      (await ok<{ series: Series[] }>('list_series', { context: 'Diocese' })).series,
    ).toEqual([])

    const first = await ok<View>('prep_meeting', { series: 'staff weekly' })
    expect(first.meeting).toMatchObject({
      context_id: world.parish.id,
      title: 'Staff weekly',
      starts_at: null,
      series: { id: created.id, name: 'Staff weekly' },
      people: [{ id: world.sarah.id, name: 'Sarah Jones' }],
      blocks: { follow_ups: true, since_last: false, lookahead: true },
    })
    expect(shape(first)).toEqual([{ Opening: ['Prayer'] }, { Reports: ['Finance', 'Buildings'] }])
    expect(lineOf(first, 'Finance').minutes).toBe(10)
    expect(first.agenda.total_minutes).toBe(15)

    const again = await ok<View>('prep_meeting', { series: created.id })
    expect(again.meeting.id).toBe(first.meeting.id)
    expect(shape(again)).toEqual(shape(first))
    expect(await db.select().from(meetings)).toHaveLength(1)

    const viaFilter = await ok<{ meetings: Meeting[] }>('list_meetings', {
      series: 'staff weekly',
      when: 'stubs',
    })
    expect(viaFilter.meetings.map((meeting) => meeting.id)).toEqual([first.meeting.id])
  })

  it('puts an item aimed at a series on its next occurrence', async () => {
    const weekly = (
      await ok<{ series: Series }>('create_series', {
        context: 'Parish',
        name: 'Weekly',
        skeleton_outline: '- Opening\n- Close',
      })
    ).series
    expect(weekly.skeleton).toEqual([
      { title: 'Opening', lines: [] },
      { title: 'Close', lines: [] },
    ])

    // No context given: the series decides it.
    const early = await capture({ text: 'Raise the heating', target_series: 'weekly' })
    expect(early).toMatchObject({
      context_id: world.parish.id,
      target_series_id: weekly.id,
      target_meeting_id: null,
      origin_meeting_id: null,
    })

    const first = await ok<View>('prep_meeting', { series: 'weekly' })
    expect(shape(first)).toEqual([{ Opening: [] }, { Close: [] }, 'Raise the heating'])
    expect(lineOf(first, 'Raise the heating').item_id).toBe(early.id)

    // Captured after the meeting exists, it waits under to_place until prep runs again.
    const late = await capture({ text: 'Thank the wardens', context: 'Parish', target_series: weekly.id })
    const waiting = await ok<View>('get_meeting', { id: first.meeting.id })
    expect(waiting.candidates.to_place).toEqual([
      { id: late.id, kind: 'topic', text: 'Thank the wardens', due_on: null },
    ])
    const topped = await ok<View>('prep_meeting', { series: 'weekly' })
    expect(topped.meeting.id).toBe(first.meeting.id)
    expect(shape(topped)).toEqual([
      { Opening: [] },
      { Close: [] },
      'Raise the heating',
      'Thank the wardens',
    ])
    expect(topped.candidates.to_place).toEqual([])
  })
})

describe('item targets', () => {
  it('aims an item at a meeting, moves it to a series, and clears it', async () => {
    const weekly = (await ok<{ series: Series }>('create_series', { context: 'Parish', name: 'Weekly' }))
      .series
    const { meeting } = await ok<View>('prep_meeting', { context: 'Parish', title: 'Planning' })

    // The meeting decides the context when nothing else does.
    const item = await capture({ text: 'Bring the plans', target_meeting: meeting.id })
    expect(item).toMatchObject({
      context_id: world.parish.id,
      target_meeting_id: meeting.id,
      target_series_id: null,
    })
    expect((await ok<View>('get_meeting', { id: meeting.id })).candidates.to_place).toEqual([
      { id: item.id, kind: 'topic', text: 'Bring the plans', due_on: null },
    ])

    const update = async (args: Record<string, unknown>) =>
      (await ok<{ item: Item }>('update_item', { id: item.id, ...args })).item

    expect(await update({ target_series: 'weekly' })).toMatchObject({
      target_meeting_id: null,
      target_series_id: weekly.id,
    })
    expect(await update({ text: 'Bring the new plans' })).toMatchObject({ target_series_id: weekly.id })
    expect(await update({ target_series: null })).toMatchObject({
      target_meeting_id: null,
      target_series_id: null,
    })
    expect(await update({ target_meeting: meeting.id })).toMatchObject({ target_meeting_id: meeting.id })
    expect(await update({ target_meeting: null })).toMatchObject({ target_meeting_id: null })

    expect(
      await refusal('update_item', { id: item.id, target_meeting: meeting.id, target_series: 'weekly' }),
    ).toContain('not both')
    expect(await refusal('update_item', { id: item.id, target_series: 'nothing' })).toContain(
      'No series matches nothing',
    )
    expect(
      await refusal('capture_item', { text: 'x', context: 'Parish', target_series: 'nothing' }),
    ).toContain('No series matches nothing')
    expect(await listItems(db, { contextId: world.parish.id })).toHaveLength(1)
  })
})

describe('idempotency', () => {
  it('replays the first result and does not act twice', async () => {
    const args = {
      context: 'Parish',
      title: 'Planning',
      starts_at: '2030-03-05T09:00',
      idempotency_key: 'prep-key-0001',
    }
    const first = await ok<View>('prep_meeting', args)
    const second = await ok<View>('prep_meeting', args)
    expect(second).toEqual(first)
    expect(await db.select().from(meetings)).toHaveLength(1)
    expect(await refusal('prep_meeting', { ...args, title: 'Something else' })).toContain(
      'different arguments',
    )
    expect(await refusal('create_series', { ...args, name: 'x' })).toContain(
      'already used by prep_meeting',
    )

    const id = first.meeting.id
    const add = { id, replace: false, lines: [{ text: 'Once' }], idempotency_key: 'agenda-key-0001' }
    const built = await ok<View>('set_agenda', add)
    // A change in between shows the replay is the stored result, not a fresh read.
    await ok<View>('edit_agenda', { id, op: 'add_line', text: 'Twice?', idempotency_key: 'edit-key-0001' })
    await ok<View>('edit_agenda', { id, op: 'add_line', text: 'Twice?', idempotency_key: 'edit-key-0001' })
    expect(await ok<View>('set_agenda', add)).toEqual(built)
    expect(shape(built)).toEqual(['Once'])
    expect(shape(await ok<View>('get_meeting', { id }))).toEqual(['Once', 'Twice?'])

    const create = { context: 'Parish', name: 'Weekly', idempotency_key: 'series-key-0001' }
    const made = await ok<{ series: Series }>('create_series', create)
    expect(await ok<{ series: Series }>('create_series', create)).toEqual(made)
    expect(await db.select().from(series)).toHaveLength(1)

    // A refused write leaves no receipt behind: the same key works once the call is right.
    const bad = { id, op: 'update_line', idempotency_key: 'edit-key-0002' }
    expect(await refusal('edit_agenda', bad)).toContain('needs line_id')
    expect(await refusal('edit_agenda', bad)).toContain('needs line_id')
  })
})

describe('scopes', () => {
  it('offers a read connection the read tools only', async () => {
    const read = await connect(identityFor(await makeUser('reader@example.test'), ['meetings:read']))
    const names = (await read.client.listTools()).tools.map((tool) => tool.name)
    expect(names).toEqual(
      expect.arrayContaining(['list_meetings', 'get_meeting', 'get_briefing', 'list_series']),
    )
    for (const write of [
      'prep_meeting',
      'update_meeting',
      'set_agenda',
      'edit_agenda',
      'create_series',
      'update_series',
    ]) {
      expect(names).not.toContain(write)
    }

    const refused = (await read.client.callTool({
      name: 'prep_meeting',
      arguments: { context: 'Parish', title: 'x' },
    })) as CallToolResult
    expect(refused.isError).toBe(true)
    expect(await db.select().from(meetings)).toHaveLength(0)
    await read.close()
  })

  it('advertises every tool with an object schema', async () => {
    const tools = (await connection.client.listTools()).tools
    const mine = tools.filter((tool) =>
      [
        'list_meetings',
        'get_meeting',
        'prep_meeting',
        'update_meeting',
        'set_agenda',
        'edit_agenda',
        'get_briefing',
        'list_series',
        'create_series',
        'update_series',
      ].includes(tool.name),
    )
    expect(mine).toHaveLength(10)
    for (const tool of mine) expect(tool.inputSchema.type).toBe('object')
  })
})
