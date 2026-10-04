/*
 * Database tests for agenda operations.
 */

import { describe, expect, it } from 'vitest'
import { NotFoundError, ValidationError } from '../lib/core/types'
import {
  getAgenda,
  addSection,
  addLine,
  updateLine,
  moveLine,
  nudgeLine,
  removeLine,
  applySkeleton,
  importOutline,
} from '../lib/agenda/lines'
import { createItem, getItem, updateItem } from '../lib/items/items'
import { createSeries } from '../lib/meetings/series'
import { db, resetBetweenTests } from './helpers/db'
import { actor, makeWorld } from './helpers/fixtures'
import { meetings, meetingDismissals } from '../lib/db/schema'

resetBetweenTests()

describe('agenda operations', () => {
  it('gets an empty agenda for a new meeting', async () => {
    const { parish } = await makeWorld()

    const meeting = await db
      .insert(meetings)
      .values({ contextId: parish.id, title: 'Team meeting', startsAt: new Date('2026-10-07T09:00:00Z') })
      .returning()

    const agenda = await getAgenda(db, meeting[0]!.id)
    expect(agenda.meetingId).toBe(meeting[0]!.id)
    expect(agenda.nodes).toHaveLength(0)
    expect(agenda.totalMinutes).toBe(0)
  })

  it('adds sections and lines with renumbering', async () => {
    const { parish } = await makeWorld()

    const meeting = await db
      .insert(meetings)
      .values({ contextId: parish.id, title: 'Team meeting' })
      .returning()

    const section1 = await addSection(db, actor, meeting[0]!.id, { title: 'Welcome' })
    const section2 = await addSection(db, actor, meeting[0]!.id, { title: 'Items' })

    await addLine(db, actor, meeting[0]!.id, {
      sectionId: section1,
      text: 'Opening',
      minutes: 5,
    })
    await addLine(db, actor, meeting[0]!.id, {
      sectionId: section2,
      text: 'Discussion',
      minutes: 10,
    })

    const agenda = await getAgenda(db, meeting[0]!.id)
    expect(agenda.nodes).toHaveLength(2)
    expect(agenda.totalMinutes).toBe(15)

    const node0 = agenda.nodes[0]!
    expect(node0.type).toBe('section')
    if (node0.type === 'section') {
      expect(node0.title).toBe('Welcome')
      expect(node0.lines).toHaveLength(1)
      expect(node0.lines[0]!.text).toBe('Opening')
    }

    const node1 = agenda.nodes[1]!
    expect(node1.type).toBe('section')
    if (node1.type === 'section') {
      expect(node1.title).toBe('Items')
      expect(node1.lines).toHaveLength(1)
      expect(node1.lines[0]!.text).toBe('Discussion')
    }
  })

  it('a line carries a public description and a leader; a section carries neither', async () => {
    const { parish, sarah, john } = await makeWorld()
    const [meeting] = await db.insert(meetings).values({ contextId: parish.id, title: 'Council' }).returning()

    const sectionId = await addSection(db, actor, meeting!.id, { title: 'Reports' })
    const lineId = await addLine(db, actor, meeting!.id, {
      text: 'Treasurer',
      sectionId,
      description: '  Q3 figures\n- the budget  ',
      leaderPersonId: sarah.id,
    })
    let [line] = (await getAgenda(db, meeting!.id)).nodes.flatMap((node) =>
      node.type === 'section' ? node.lines : [node],
    )
    expect(line).toMatchObject({
      description: 'Q3 figures\n- the budget',
      leader: { id: sarah.id, name: 'Sarah Jones', isSelf: false },
    })

    await updateLine(db, actor, lineId, { leaderPersonId: john.id, description: '' })
    ;[line] = (await getAgenda(db, meeting!.id)).nodes.flatMap((node) =>
      node.type === 'section' ? node.lines : [node],
    )
    expect(line).toMatchObject({ description: null, leader: { id: john.id, isSelf: true } })
    await updateLine(db, actor, lineId, { leaderPersonId: null })
    ;[line] = (await getAgenda(db, meeting!.id)).nodes.flatMap((node) =>
      node.type === 'section' ? node.lines : [node],
    )
    expect(line!.leader).toBeNull()

    await expect(updateLine(db, actor, sectionId, { description: 'no' })).rejects.toThrow(ValidationError)
    await expect(
      addLine(db, actor, meeting!.id, { text: 'x', leaderPersonId: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toThrow(NotFoundError)
  })

  it('refuses a line without text or item', async () => {
    const { parish } = await makeWorld()

    const meeting = await db.insert(meetings).values({ contextId: parish.id, title: 'Meeting' }).returning()

    await expect(addLine(db, actor, meeting[0]!.id, {})).rejects.toThrow('needs text or an item')
  })

  it('item line shows live item text and follows edits', async () => {
    const { parish } = await makeWorld()

    const meeting = await db.insert(meetings).values({ contextId: parish.id, title: 'Meeting' }).returning()

    const item = await createItem(db, actor, { contextId: parish.id, text: 'Original text' })

    await addLine(db, actor, meeting[0]!.id, { itemId: item.id })

    let agenda = await getAgenda(db, meeting[0]!.id)
    const node = agenda.nodes[0]!
    expect(node.type).toBe('line')
    if (node.type === 'line') {
      expect(node.text).toBe('Original text')
      expect(node.item!.text).toBe('Original text')

      // Update the item
      await updateItem(db, actor, item.id, { text: 'Updated text' })

      agenda = await getAgenda(db, meeting[0]!.id)
      const updatedNode = agenda.nodes[0]!
      if (updatedNode.type === 'line') {
        expect(updatedNode.text).toBe('Updated text')
      }
    }
  })

  it('override text wins over item text', async () => {
    const { parish } = await makeWorld()

    const meeting = await db.insert(meetings).values({ contextId: parish.id, title: 'Meeting' }).returning()

    const item = await createItem(db, actor, { contextId: parish.id, text: 'Item text' })

    await addLine(db, actor, meeting[0]!.id, { itemId: item.id, text: 'Override text' })

    const agenda = await getAgenda(db, meeting[0]!.id)
    const node = agenda.nodes[0]!
    if (node.type === 'line') {
      expect(node.text).toBe('Override text')
      expect(node.ownText).toBe('Override text')
    }
  })

  it('refuses duplicate item placement', async () => {
    const { parish } = await makeWorld()

    const meeting = await db.insert(meetings).values({ contextId: parish.id, title: 'Meeting' }).returning()

    const item = await createItem(db, actor, { contextId: parish.id, text: 'An item' })

    await addLine(db, actor, meeting[0]!.id, { itemId: item.id })

    await expect(addLine(db, actor, meeting[0]!.id, { itemId: item.id })).rejects.toThrow(
      'already on this agenda',
    )
  })

  it('removing the line of an item aimed at the series records a dismissal', async () => {
    const { parish } = await makeWorld()

    const series = await createSeries(db, { contextId: parish.id, name: 'Weekly' })
    const meeting = await db.insert(meetings).values({ contextId: parish.id, title: 'Meeting', seriesId: series.id }).returning()

    const item = await createItem(db, actor, {
      contextId: parish.id,
      text: 'An action',
      target: { seriesId: series.id },
    })

    const line = await addLine(db, actor, meeting[0]!.id, { itemId: item.id })

    await removeLine(db, actor, line)

    const dismissals = await db.select().from(meetingDismissals)

    const thisDismissal = dismissals.find((d) => d.meetingId === meeting[0]!.id && d.itemId === item.id)
    expect(thisDismissal).toBeDefined()
  })

  it('removing the line of any other item records nothing: it is suggested again', async () => {
    const { parish } = await makeWorld()

    const meeting = await db.insert(meetings).values({ contextId: parish.id, title: 'Meeting' }).returning()
    const item = await createItem(db, actor, { contextId: parish.id, text: 'An action' })
    const line = await addLine(db, actor, meeting[0]!.id, { itemId: item.id })

    await removeLine(db, actor, line)

    expect(await db.select().from(meetingDismissals)).toEqual([])
  })

  it('removing the line of an item aimed at this meeting alone clears its aim', async () => {
    const { parish } = await makeWorld()

    const meeting = await db.insert(meetings).values({ contextId: parish.id, title: 'Meeting' }).returning()
    const item = await createItem(db, actor, {
      contextId: parish.id,
      text: 'An action',
      target: { meetingId: meeting[0]!.id },
    })
    const line = await addLine(db, actor, meeting[0]!.id, { itemId: item.id })

    await removeLine(db, actor, line)

    expect(await db.select().from(meetingDismissals)).toEqual([])
    expect((await getItem(db, item.id)).targetMeetingId).toBeNull()
  })

  it('re-adding item clears dismissal', async () => {
    const { parish } = await makeWorld()

    const series = await createSeries(db, { contextId: parish.id, name: 'Weekly' })
    const meeting = await db.insert(meetings).values({ contextId: parish.id, title: 'Meeting', seriesId: series.id }).returning()

    const item = await createItem(db, actor, {
      contextId: parish.id,
      text: 'An item',
      target: { seriesId: series.id },
    })

    const line1 = await addLine(db, actor, meeting[0]!.id, { itemId: item.id })

    await removeLine(db, actor, line1)

    let dismissals = await db.select().from(meetingDismissals)
    expect(dismissals.some((d) => d.itemId === item.id)).toBe(true)

    // Re-add the item
    await addLine(db, actor, meeting[0]!.id, { itemId: item.id })

    dismissals = await db.select().from(meetingDismissals)
    expect(dismissals.some((d) => d.itemId === item.id)).toBe(false)
  })

  it('moving lines renumbers siblings', async () => {
    const { parish } = await makeWorld()

    const meeting = await db.insert(meetings).values({ contextId: parish.id, title: 'Meeting' }).returning()

    await addLine(db, actor, meeting[0]!.id, { text: 'First' })
    const line2 = await addLine(db, actor, meeting[0]!.id, { text: 'Second' })
    await addLine(db, actor, meeting[0]!.id, { text: 'Third' })

    let agenda = await getAgenda(db, meeting[0]!.id)
    expect(agenda.nodes).toHaveLength(3)
    if (agenda.nodes[0]?.type === 'line') expect(agenda.nodes[0].text).toBe('First')
    if (agenda.nodes[1]?.type === 'line') expect(agenda.nodes[1].text).toBe('Second')
    if (agenda.nodes[2]?.type === 'line') expect(agenda.nodes[2].text).toBe('Third')

    // Move line2 to position 0
    await moveLine(db, actor, line2, { sectionId: null, position: 0 })

    agenda = await getAgenda(db, meeting[0]!.id)
    expect(agenda.nodes).toHaveLength(3)
    if (agenda.nodes[0]?.type === 'line') expect(agenda.nodes[0].text).toBe('Second')
    if (agenda.nodes[1]?.type === 'line') expect(agenda.nodes[1].text).toBe('First')
    if (agenda.nodes[2]?.type === 'line') expect(agenda.nodes[2].text).toBe('Third')
  })

  it('moves lines between sections', async () => {
    const { parish } = await makeWorld()

    const meeting = await db.insert(meetings).values({ contextId: parish.id, title: 'Meeting' }).returning()

    const section1 = await addSection(db, actor, meeting[0]!.id, { title: 'Section 1' })
    const section2 = await addSection(db, actor, meeting[0]!.id, { title: 'Section 2' })

    const line1 = await addLine(db, actor, meeting[0]!.id, { sectionId: section1, text: 'Line 1' })

    // Move line to section 2
    await moveLine(db, actor, line1, { sectionId: section2, position: 0 })

    const agenda = await getAgenda(db, meeting[0]!.id)
    if (agenda.nodes[0]?.type === 'section') {
      expect(agenda.nodes[0].lines).toHaveLength(0)
    }
    if (agenda.nodes[1]?.type === 'section') {
      expect(agenda.nodes[1].lines).toHaveLength(1)
    }
  })

  it('removing a section records dismissals for the items aimed at the series among its lines', async () => {
    const { parish } = await makeWorld()

    const series = await createSeries(db, { contextId: parish.id, name: 'Weekly' })
    const meeting = await db.insert(meetings).values({ contextId: parish.id, title: 'Meeting', seriesId: series.id }).returning()

    const section = await addSection(db, actor, meeting[0]!.id, { title: 'Section' })

    const item1 = await createItem(db, actor, {
      contextId: parish.id,
      text: 'Item 1',
      target: { seriesId: series.id },
    })
    const item2 = await createItem(db, actor, { contextId: parish.id, text: 'Item 2' })

    await addLine(db, actor, meeting[0]!.id, { sectionId: section, itemId: item1.id })
    await addLine(db, actor, meeting[0]!.id, { sectionId: section, itemId: item2.id })

    // Remove the section
    await removeLine(db, actor, section)

    const dismissals = await db.select().from(meetingDismissals)
    expect(dismissals.filter((d) => d.itemId === item1.id).length).toBe(1)
    expect(dismissals.filter((d) => d.itemId === item2.id).length).toBe(0)
  })

  it('applySkeleton appends sections', async () => {
    const { parish } = await makeWorld()

    const meeting = await db.insert(meetings).values({ contextId: parish.id, title: 'Meeting' }).returning()

    const skeleton = [
      {
        title: 'Opening',
        lines: [{ text: 'Welcome', minutes: 5 }],
      },
      {
        title: 'Work',
        lines: [
          { text: 'Item 1', minutes: 10 },
          { text: 'Item 2', minutes: 15 },
        ],
      },
    ]

    await applySkeleton(db, actor, meeting[0]!.id, skeleton)

    const agenda = await getAgenda(db, meeting[0]!.id)
    expect(agenda.nodes).toHaveLength(2)
    if (agenda.nodes[0]?.type === 'section') {
      expect(agenda.nodes[0].title).toBe('Opening')
      expect(agenda.nodes[0].lines).toHaveLength(1)
    }
    if (agenda.nodes[1]?.type === 'section') {
      expect(agenda.nodes[1].title).toBe('Work')
      expect(agenda.nodes[1].lines).toHaveLength(2)
    }
  })

  it('importOutline parses and creates sections', async () => {
    const { parish } = await makeWorld()

    const meeting = await db.insert(meetings).values({ contextId: parish.id, title: 'Meeting' }).returning()

    const outline = `# Welcome
## Opening remarks
## Overview

# Work
## Discussion
## Action items`

    const result = await importOutline(db, actor, meeting[0]!.id, outline)
    expect(result.sections).toBe(2)
    expect(result.lines).toBe(4)

    const agenda = await getAgenda(db, meeting[0]!.id)
    expect(agenda.nodes).toHaveLength(2)
  })

  it('importOutline with replace keeps item lines', async () => {
    const { parish } = await makeWorld()

    const meeting = await db.insert(meetings).values({ contextId: parish.id, title: 'Meeting' }).returning()

    const item = await createItem(db, actor, { contextId: parish.id, text: 'Keep me' })

    // Add an item line and some free-text lines
    await addLine(db, actor, meeting[0]!.id, { itemId: item.id })
    await addLine(db, actor, meeting[0]!.id, { text: 'Free text to remove' })

    // Import with replace
    const outline = `# New Section
## New line`

    await importOutline(db, actor, meeting[0]!.id, outline, { replace: true })

    const agenda = await getAgenda(db, meeting[0]!.id)
    // Should have the new section and the kept item line
    const itemLine = agenda.nodes.find((n) => n.type === 'line' && n.item?.id === item.id)
    expect(itemLine).toBeDefined()
  })

  it('validates minutes and pinnedStart', async () => {
    const { parish } = await makeWorld()

    const meeting = await db.insert(meetings).values({ contextId: parish.id, title: 'Meeting' }).returning()

    const line = await addLine(db, actor, meeting[0]!.id, { text: 'Test' })

    // Valid pinnedStart
    await updateLine(db, actor, line, { pinnedStart: '09:30' })

    // Invalid pinnedStart format
    await expect(updateLine(db, actor, line, { pinnedStart: '9:30' })).rejects.toThrow('HH:MM')

    // Invalid minutes (negative)
    await expect(updateLine(db, actor, line, { minutes: -5 })).rejects.toThrow('non-negative')
  })

  it('computes start times for dated meeting with non-UTC timezone', async () => {
    const { parish } = await makeWorld()

    const meeting = await db
      .insert(meetings)
      .values({
        contextId: parish.id,
        title: 'Meeting',
        startsAt: new Date('2026-10-07T14:00:00Z'), // 9 AM in Chicago
        endsAt: new Date('2026-10-07T15:00:00Z'),
      })
      .returning()

    await addLine(db, actor, meeting[0]!.id, { text: 'First', minutes: 10 })
    await addLine(db, actor, meeting[0]!.id, { text: 'Second', minutes: 20 })

    const agenda = await getAgenda(db, meeting[0]!.id, { timeZone: 'America/Chicago' })
    expect(agenda.totalMinutes).toBe(30)
    expect(agenda.end).not.toBeNull()
  })

  it('null start times for undated stub with correct totalMinutes', async () => {
    const { parish } = await makeWorld()

    const meeting = await db.insert(meetings).values({ contextId: parish.id, title: 'Stub' }).returning()

    await addLine(db, actor, meeting[0]!.id, { text: 'Item 1', minutes: 5 })
    await addLine(db, actor, meeting[0]!.id, { text: 'Item 2', minutes: 10 })

    const agenda = await getAgenda(db, meeting[0]!.id)
    expect(agenda.nodes[0]!.start).toBeNull()
    expect(agenda.nodes[1]!.start).toBeNull()
    expect(agenda.totalMinutes).toBe(15)
  })

  it('computes overflowMinutes against endsAt', async () => {
    const { parish } = await makeWorld()

    const meeting = await db
      .insert(meetings)
      .values({
        contextId: parish.id,
        title: 'Meeting',
        startsAt: new Date('2026-10-07T14:00:00Z'),
        endsAt: new Date('2026-10-07T14:30:00Z'), // 30 minutes
      })
      .returning()

    await addLine(db, actor, meeting[0]!.id, { text: 'Item', minutes: 45 }) // 45 minutes

    const agenda = await getAgenda(db, meeting[0]!.id)
    expect(agenda.overflowMinutes).toBe(15)
  })

  it('refuses cross-context item placement', async () => {
    const { parish, diocese } = await makeWorld()

    const meeting = await db
      .insert(meetings)
      .values({ contextId: parish.id, title: 'Meeting' })
      .returning()

    const item = await createItem(db, actor, { contextId: diocese.id, text: 'Wrong context' })

    await expect(addLine(db, actor, meeting[0]!.id, { itemId: item.id })).rejects.toThrow(
      'different context'
    )
  })
  /* The agenda as it reads: "Section[a,b]" for a section, the text for a loose line. */
  async function shape(meetingId: string): Promise<string[]> {
    const agenda = await getAgenda(db, meetingId)
    return agenda.nodes.map((node) =>
      node.type === 'section' ? `${node.title}[${node.lines.map((l) => l.text).join(',')}]` : node.text,
    )
  }

  it('moves a line down its own list without leaving a gap or a tie', async () => {
    const { parish } = await makeWorld()
    const [meeting] = await db.insert(meetings).values({ contextId: parish.id, title: 'Meeting' }).returning()

    const a = await addLine(db, actor, meeting!.id, { text: 'a' })
    await addLine(db, actor, meeting!.id, { text: 'b' })
    await addLine(db, actor, meeting!.id, { text: 'c' })

    await moveLine(db, actor, a, { sectionId: null, position: 2 })
    expect(await shape(meeting!.id)).toEqual(['b', 'c', 'a'])
    await moveLine(db, actor, a, { sectionId: null, position: 1 })
    expect(await shape(meeting!.id)).toEqual(['b', 'a', 'c'])
    // Out of range lands at the end.
    await moveLine(db, actor, a, { sectionId: null, position: 99 })
    expect(await shape(meeting!.id)).toEqual(['b', 'c', 'a'])
  })

  it('refuses a section from another meeting, and a line as a section', async () => {
    const { parish } = await makeWorld()
    const [one] = await db.insert(meetings).values({ contextId: parish.id, title: 'One' }).returning()
    const [two] = await db.insert(meetings).values({ contextId: parish.id, title: 'Two' }).returning()
    const elsewhere = await addSection(db, actor, two!.id, { title: 'Elsewhere' })
    const plain = await addLine(db, actor, one!.id, { text: 'plain' })
    const moving = await addLine(db, actor, one!.id, { text: 'moving' })

    await expect(addLine(db, actor, one!.id, { text: 'x', sectionId: elsewhere })).rejects.toThrow('not on this agenda')
    await expect(moveLine(db, actor, moving, { sectionId: elsewhere, position: 0 })).rejects.toThrow('not on this agenda')
    await expect(moveLine(db, actor, moving, { sectionId: plain, position: 0 })).rejects.toThrow('not on this agenda')
  })

  it('nudges a line through the agenda as it reads, into and out of sections', async () => {
    const { parish } = await makeWorld()
    const [meeting] = await db.insert(meetings).values({ contextId: parish.id, title: 'Meeting' }).returning()

    const x = await addLine(db, actor, meeting!.id, { text: 'x' })
    const section = await addSection(db, actor, meeting!.id, { title: 'S' })
    await addLine(db, actor, meeting!.id, { text: 'a', sectionId: section })
    await addLine(db, actor, meeting!.id, { text: 'b', sectionId: section })
    await addLine(db, actor, meeting!.id, { text: 'y' })
    expect(await shape(meeting!.id)).toEqual(['x', 'S[a,b]', 'y'])

    for (const expected of ['S[x,a,b]|y', 'S[a,x,b]|y', 'S[a,b,x]|y', 'S[a,b]|x|y', 'S[a,b]|y|x']) {
      await nudgeLine(db, actor, x, 'down')
      expect((await shape(meeting!.id)).join('|')).toBe(expected)
    }
    // Already last: nothing happens.
    await nudgeLine(db, actor, x, 'down')
    expect(await shape(meeting!.id)).toEqual(['S[a,b]', 'y', 'x'])

    for (const expected of ['S[a,b]|x|y', 'S[a,b,x]|y', 'S[a,x,b]|y', 'S[x,a,b]|y', 'x|S[a,b]|y']) {
      await nudgeLine(db, actor, x, 'up')
      expect((await shape(meeting!.id)).join('|')).toBe(expected)
    }

    // A section steps over its neighbour whole.
    await nudgeLine(db, actor, section, 'up')
    expect(await shape(meeting!.id)).toEqual(['S[a,b]', 'x', 'y'])
    await nudgeLine(db, actor, section, 'down')
    await nudgeLine(db, actor, section, 'down')
    expect(await shape(meeting!.id)).toEqual(['x', 'y', 'S[a,b]'])
  })

  it('importOutline with replace keeps an item line that sat inside a section', async () => {
    const { parish } = await makeWorld()
    const [meeting] = await db.insert(meetings).values({ contextId: parish.id, title: 'Meeting' }).returning()
    const item = await createItem(db, actor, { contextId: parish.id, text: 'Keep me' })

    const old = await addSection(db, actor, meeting!.id, { title: 'Old' })
    await addLine(db, actor, meeting!.id, { itemId: item.id, sectionId: old })
    await addLine(db, actor, meeting!.id, { text: 'Old text', sectionId: old })

    await importOutline(db, actor, meeting!.id, '# New\n## Line 10 min', { replace: true })
    expect(await shape(meeting!.id)).toEqual(['Keep me', 'New[Line]'])
    const agenda = await getAgenda(db, meeting!.id)
    expect(agenda.totalMinutes).toBe(10)
  })

  it('imports a flat list as loose lines and keeps what was written under a heading', async () => {
    const { parish } = await makeWorld()
    const [meeting] = await db.insert(meetings).values({ contextId: parish.id, title: 'Meeting' }).returning()

    expect(await importOutline(db, actor, meeting!.id, '- Welcome 5\n- Budget 20\n- Close')).toEqual({
      sections: 0,
      lines: 3,
    })
    expect(await shape(meeting!.id)).toEqual(['Welcome', 'Budget', 'Close'])

    await importOutline(db, actor, meeting!.id, '# Reports\n## Finance\nAsk about the audit\n## Property', {
      replace: true,
    })
    const agenda = await getAgenda(db, meeting!.id)
    const reports = agenda.nodes[0]!
    expect(reports.type === 'section' && reports.lines[0]!.privateNote).toBe('Ask about the audit')

    await expect(importOutline(db, actor, meeting!.id, '   ')).rejects.toThrow('Paste an outline')
  })

  it('pinned starts and the user\'s zone reach the stored agenda', async () => {
    const { parish } = await makeWorld()
    const [meeting] = await db
      .insert(meetings)
      .values({
        contextId: parish.id,
        title: 'Meeting',
        startsAt: new Date('2026-10-07T14:00:00Z'), // 9 AM in Chicago
        endsAt: new Date('2026-10-07T15:00:00Z'),
      })
      .returning()

    await addLine(db, actor, meeting!.id, { text: 'First', minutes: 10 })
    const section = await addSection(db, actor, meeting!.id, { title: 'Break' })
    await updateLine(db, actor, section, { pinnedStart: '09:30' })
    await addLine(db, actor, meeting!.id, { text: 'Coffee', minutes: 15, sectionId: section })
    await addLine(db, actor, meeting!.id, { text: 'Last', minutes: 30 })

    const agenda = await getAgenda(db, meeting!.id, { timeZone: 'America/Chicago' })
    const [first, pause, last] = agenda.nodes
    expect([first!.start, pause!.start, last!.start]).toEqual(['09:00', '09:30', '09:45'])
    expect(agenda.end).toBe('10:15')
    expect(agenda.overflowMinutes).toBe(15)
  })

  it('an item line whose override matches the item follows the item again', async () => {
    const { parish } = await makeWorld()
    const [meeting] = await db.insert(meetings).values({ contextId: parish.id, title: 'Meeting' }).returning()
    const item = await createItem(db, actor, { contextId: parish.id, text: 'Original' })
    const line = await addLine(db, actor, meeting!.id, { itemId: item.id })
    const free = await addLine(db, actor, meeting!.id, { text: 'Free' })

    await updateLine(db, actor, line, { text: 'Original', privateNote: '  mine  ' })
    const agenda = await getAgenda(db, meeting!.id)
    const node = agenda.nodes[0]!
    expect(node.type === 'line' && node.ownText).toBeNull()
    expect(node.type === 'line' && node.privateNote).toBe('mine')

    await expect(updateLine(db, actor, free, { text: '  ' })).rejects.toThrow('Enter some text')
    await expect(updateLine(db, actor, free, { pinnedStart: '25:00' })).rejects.toThrow('HH:MM')
  })
  it('importOutline with replace keeps item lines in the order they read', async () => {
    const { parish } = await makeWorld()
    const [meeting] = await db.insert(meetings).values({ contextId: parish.id, title: 'Meeting' }).returning()
    const item = (text: string) => createItem(db, actor, { contextId: parish.id, text })

    // Reads: one, A[two, text, three], four, B[five]. Section ids are random, so
    // any order that leans on them shows up over a few sections.
    await addLine(db, actor, meeting!.id, { itemId: (await item('one')).id })
    const a = await addSection(db, actor, meeting!.id, { title: 'A' })
    await addLine(db, actor, meeting!.id, { itemId: (await item('two')).id, sectionId: a })
    await addLine(db, actor, meeting!.id, { text: 'text', sectionId: a })
    await addLine(db, actor, meeting!.id, { itemId: (await item('three')).id, sectionId: a })
    await addLine(db, actor, meeting!.id, { itemId: (await item('four')).id })
    const b = await addSection(db, actor, meeting!.id, { title: 'B' })
    await addLine(db, actor, meeting!.id, { itemId: (await item('five')).id, sectionId: b })
    for (const title of ['C', 'D', 'E']) {
      const section = await addSection(db, actor, meeting!.id, { title })
      await addLine(db, actor, meeting!.id, { itemId: (await item(`in ${title}`)).id, sectionId: section })
    }

    await importOutline(db, actor, meeting!.id, '- New', { replace: true })
    expect(await shape(meeting!.id)).toEqual([
      'one', 'two', 'three', 'four', 'five', 'in C', 'in D', 'in E', 'New',
    ])
  })
})
