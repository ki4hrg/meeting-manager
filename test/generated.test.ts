import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { computeBlocks } from '../lib/agenda/generated'
import { createItem } from '../lib/items/items'
import { db, resetBetweenTests } from './helpers/db'
import { actor, makeWorld } from './helpers/fixtures'
import * as schema from '../lib/db/schema'

resetBetweenTests()

describe('generated blocks', () => {
  describe('followUps', () => {
    it('includes open questions and actions placed on the agenda, grouped by owner', async () => {
      const { parish, sarah } = await makeWorld()

      const meetingRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        title: 'Meeting',
        startsAt: new Date('2026-10-05T10:00:00Z'),
        blocks: { followUps: true, sinceLast: false, lookahead: false },
      }).returning()
      if (meetingRows.length !== 1) throw new Error('Expected one meeting')
      const meeting = meetingRows[0]!

      const action = await createItem(db, actor, {
        contextId: parish.id,
        text: 'do something',
        kind: 'action',
        parties: [{ personId: sarah.id, role: 'owner' }],
      })

      // Place the item on the agenda
      await db.insert(schema.agendaLines).values({
        id: randomUUID(),
        meetingId: meeting.id,
        itemId: action.id,
        position: 0,
      })

      const blocks = await computeBlocks(db, meeting.id, { today: '2026-10-05' })
      expect(blocks.followUps).not.toBeNull()
      expect(blocks.followUps![0]!.party).toMatchObject({ type: 'person', id: sarah.id })
      expect(blocks.followUps![0]!.items.map((i) => i.itemId)).toEqual([action.id])
    })

    it('includes items originating in this meeting', async () => {
      const { parish, sarah } = await makeWorld()

      const meetingRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        title: 'Meeting',
        startsAt: new Date('2026-10-05T10:00:00Z'),
        blocks: { followUps: true, sinceLast: false, lookahead: false },
      }).returning()
      if (meetingRows.length !== 1) throw new Error('Expected one meeting')
      const meeting = meetingRows[0]!

      const action = await createItem(db, actor, {
        contextId: parish.id,
        text: 'from meeting',
        kind: 'action',
        parties: [{ personId: sarah.id, role: 'owner' }],
        originMeetingId: meeting.id,
      })

      const blocks = await computeBlocks(db, meeting.id, { today: '2026-10-05' })
      expect(blocks.followUps![0]!.items.map((i) => i.itemId)).toEqual([action.id])
    })

    it('LEAK RULE: does not include raw candidates', async () => {
      const { parish, sarah, retreat } = await makeWorld()

      const meetingRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        title: 'Meeting',
        startsAt: new Date('2026-10-05T10:00:00Z'),
        blocks: { followUps: true, sinceLast: false, lookahead: false },
      }).returning()
      if (meetingRows.length !== 1) throw new Error('Expected one meeting')
      const meeting = meetingRows[0]!

      await db.insert(schema.meetingProjects).values({
        meetingId: meeting.id,
        projectId: retreat.id,
      })

      // Create an action that would be a candidate but is not placed
      await createItem(db, actor, {
        contextId: parish.id,
        text: 'candidate but not placed',
        kind: 'action',
        projectId: retreat.id,
        parties: [{ personId: sarah.id, role: 'owner' }],
      })

      const blocks = await computeBlocks(db, meeting.id, { today: '2026-10-05' })
      expect(blocks.followUps).toBeNull()
    })

    it('marks items overdue when due_on < today', async () => {
      const { parish, sarah } = await makeWorld()

      const meetingRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        title: 'Meeting',
        startsAt: new Date('2026-10-05T10:00:00Z'),
        blocks: { followUps: true, sinceLast: false, lookahead: false },
      }).returning()
      if (meetingRows.length !== 1) throw new Error('Expected one meeting')
      const meeting = meetingRows[0]!

      const overdue = await createItem(db, actor, {
        contextId: parish.id,
        text: 'overdue',
        kind: 'action',
        parties: [{ personId: sarah.id, role: 'owner' }],
        dueOn: '2026-10-04',
      })

      const upcoming = await createItem(db, actor, {
        contextId: parish.id,
        text: 'upcoming',
        kind: 'action',
        parties: [{ personId: sarah.id, role: 'owner' }],
        dueOn: '2026-10-06',
      })

      await db.insert(schema.agendaLines).values([
        { id: randomUUID(), meetingId: meeting.id, itemId: overdue.id, position: 0 },
        { id: randomUUID(), meetingId: meeting.id, itemId: upcoming.id, position: 1 },
      ])

      const blocks = await computeBlocks(db, meeting.id, { today: '2026-10-05' })
      const items = blocks.followUps![0]!.items
      expect(items.find((i) => i.itemId === overdue.id)?.overdue).toBe(true)
      expect(items.find((i) => i.itemId === upcoming.id)?.overdue).toBe(false)
    })

    it('is null when block is off', async () => {
      const { parish, sarah } = await makeWorld()

      const meetingRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        title: 'Meeting',
        startsAt: new Date('2026-10-05T10:00:00Z'),
        blocks: { followUps: false, sinceLast: false, lookahead: false },
      }).returning()
      if (meetingRows.length !== 1) throw new Error('Expected one meeting')
      const meeting = meetingRows[0]!

      const action = await createItem(db, actor, {
        contextId: parish.id,
        text: 'action',
        kind: 'action',
        parties: [{ personId: sarah.id, role: 'owner' }],
      })

      await db.insert(schema.agendaLines).values({
        id: randomUUID(),
        meetingId: meeting.id,
        itemId: action.id,
        position: 0,
      })

      const blocks = await computeBlocks(db, meeting.id, { today: '2026-10-05' })
      expect(blocks.followUps).toBeNull()
    })
  })

  describe('sinceLast', () => {
    it('finds the previous meeting in the same series', async () => {
      const { parish } = await makeWorld()

      const seriesRows = await db.insert(schema.series).values({
        id: randomUUID(),
        contextId: parish.id,
        name: 'Weekly',
      }).returning()
      if (seriesRows.length !== 1) throw new Error('Expected one series')
      const series = seriesRows[0]!

      const prevRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        seriesId: series.id,
        title: 'Last week',
        startsAt: new Date('2026-09-28T10:00:00Z'),
        blocks: { followUps: false, sinceLast: false, lookahead: false },
      }).returning()
      if (prevRows.length !== 1) throw new Error('Expected one prev meeting')
      const prev = prevRows[0]!

      const currentRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        seriesId: series.id,
        title: 'This week',
        startsAt: new Date('2026-10-05T10:00:00Z'),
        blocks: { followUps: false, sinceLast: true, lookahead: false },
      }).returning()
      if (currentRows.length !== 1) throw new Error('Expected one current meeting')
      const current = currentRows[0]!

      // Nothing was raised there, so there is nothing to say about it.
      expect((await computeBlocks(db, current.id, { today: '2026-10-05' })).sinceLast).toBeNull()

      const raised = await createItem(db, actor, { contextId: parish.id, text: 'raised last week' })
      await db.insert(schema.agendaLines).values({ meetingId: prev.id, itemId: raised.id })

      const blocks = await computeBlocks(db, current.id, { today: '2026-10-05' })
      expect(blocks.sinceLast?.meeting.id).toBe(prev.id)
      expect(blocks.sinceLast?.stillOpen.map((entry) => entry.itemId)).toEqual([raised.id])
    })

    it('includes decisions made at the previous meeting', async () => {
      const { parish } = await makeWorld()

      const seriesRows = await db.insert(schema.series).values({
        id: randomUUID(),
        contextId: parish.id,
        name: 'Weekly',
      }).returning()
      if (seriesRows.length !== 1) throw new Error('Expected one series')
      const series = seriesRows[0]!

      const prevRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        seriesId: series.id,
        title: 'Last week',
        startsAt: new Date('2026-09-28T10:00:00Z'),
      }).returning()
      if (prevRows.length !== 1) throw new Error('Expected one prev meeting')
      const prev = prevRows[0]!

      const currentRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        seriesId: series.id,
        title: 'This week',
        startsAt: new Date('2026-10-05T10:00:00Z'),
        blocks: { followUps: false, sinceLast: true, lookahead: false },
      }).returning()
      if (currentRows.length !== 1) throw new Error('Expected one current meeting')
      const current = currentRows[0]!

      const decision = await createItem(db, actor, {
        contextId: parish.id,
        text: 'decided',
        kind: 'decision',
        originMeetingId: prev.id,
      })

      const blocks = await computeBlocks(db, current.id, { today: '2026-10-05' })
      expect(blocks.sinceLast?.decisions.map((d) => d.itemId)).toContain(decision.id)
    })

    it('is null when no previous meeting', async () => {
      const { parish } = await makeWorld()

      const seriesRows = await db.insert(schema.series).values({
        id: randomUUID(),
        contextId: parish.id,
        name: 'Weekly',
      }).returning()
      if (seriesRows.length !== 1) throw new Error('Expected one series')
      const series = seriesRows[0]!

      const currentRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        seriesId: series.id,
        title: 'First meeting',
        startsAt: new Date('2026-10-05T10:00:00Z'),
        blocks: { followUps: false, sinceLast: true, lookahead: false },
      }).returning()
      if (currentRows.length !== 1) throw new Error('Expected one current meeting')
      const current = currentRows[0]!

      const blocks = await computeBlocks(db, current.id, { today: '2026-10-05' })
      expect(blocks.sinceLast).toBeNull()
    })

    it('is null when block is off', async () => {
      const { parish } = await makeWorld()

      const seriesRows = await db.insert(schema.series).values({
        id: randomUUID(),
        contextId: parish.id,
        name: 'Weekly',
      }).returning()
      if (seriesRows.length !== 1) throw new Error('Expected one series')
      const series = seriesRows[0]!

      const prevRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        seriesId: series.id,
        title: 'Last week',
        startsAt: new Date('2026-09-28T10:00:00Z'),
      }).returning()
      if (prevRows.length !== 1) throw new Error('Expected one prev meeting')

      const currentRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        seriesId: series.id,
        title: 'This week',
        startsAt: new Date('2026-10-05T10:00:00Z'),
        blocks: { followUps: false, sinceLast: false, lookahead: false },
      }).returning()
      if (currentRows.length !== 1) throw new Error('Expected one current meeting')
      const current = currentRows[0]!

      const blocks = await computeBlocks(db, current.id, { today: '2026-10-05' })
      expect(blocks.sinceLast).toBeNull()
    })
  })

  describe('lookahead', () => {
    it('includes milestones for meeting projects in next 60 days', async () => {
      const { parish, retreat } = await makeWorld()

      const meetingRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        title: 'Meeting',
        startsAt: new Date('2026-10-05T10:00:00Z'),
        blocks: { followUps: false, sinceLast: false, lookahead: true },
      }).returning()
      if (meetingRows.length !== 1) throw new Error('Expected one meeting')
      const meeting = meetingRows[0]!

      await db.insert(schema.meetingProjects).values({
        meetingId: meeting.id,
        projectId: retreat.id,
      })

      const milestoneRows = await db.insert(schema.milestones).values({
        id: randomUUID(),
        projectId: retreat.id,
        title: 'Upcoming milestone',
        dueOn: '2026-11-15',
      }).returning()
      if (milestoneRows.length !== 1) throw new Error('Expected one milestone')
      const milestone = milestoneRows[0]!

      const blocks = await computeBlocks(db, meeting.id, { today: '2026-10-05' })
      expect(blocks.lookahead?.milestones.map((m) => m.id)).toEqual([milestone.id])
    })

    it('excludes done milestones', async () => {
      const { parish, retreat } = await makeWorld()

      const meetingRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        title: 'Meeting',
        startsAt: new Date('2026-10-05T10:00:00Z'),
        blocks: { followUps: false, sinceLast: false, lookahead: true },
      }).returning()
      if (meetingRows.length !== 1) throw new Error('Expected one meeting')
      const meeting = meetingRows[0]!

      await db.insert(schema.meetingProjects).values({
        meetingId: meeting.id,
        projectId: retreat.id,
      })

      // Create an undone milestone that should appear
      const undoneRows = await db.insert(schema.milestones).values({
        id: randomUUID(),
        projectId: retreat.id,
        title: 'Undone milestone',
        dueOn: '2026-11-15',
      }).returning()
      if (undoneRows.length !== 1) throw new Error('Expected one undone milestone')
      const undone = undoneRows[0]!

      // Create a done milestone that should be excluded
      await db.insert(schema.milestones).values({
        id: randomUUID(),
        projectId: retreat.id,
        title: 'Done milestone',
        dueOn: '2026-11-10',
        doneAt: new Date('2026-11-10T10:00:00Z'),
      })

      const blocks = await computeBlocks(db, meeting.id, { today: '2026-10-05' })
      expect(blocks.lookahead?.milestones).toHaveLength(1)
      expect(blocks.lookahead?.milestones[0]?.id).toBe(undone.id)
    })

    it('includes next meetings sharing series or projects', async () => {
      const { parish, retreat } = await makeWorld()

      const seriesRows = await db.insert(schema.series).values({
        id: randomUUID(),
        contextId: parish.id,
        name: 'Weekly',
      }).returning()
      if (seriesRows.length !== 1) throw new Error('Expected one series')
      const series = seriesRows[0]!

      const currentRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        seriesId: series.id,
        title: 'This week',
        startsAt: new Date('2026-10-05T10:00:00Z'),
        blocks: { followUps: false, sinceLast: false, lookahead: true },
      }).returning()
      if (currentRows.length !== 1) throw new Error('Expected one current meeting')
      const current = currentRows[0]!

      const nextInSeriesRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        seriesId: series.id,
        title: 'Next week',
        startsAt: new Date('2026-10-12T10:00:00Z'),
      }).returning()
      if (nextInSeriesRows.length !== 1) throw new Error('Expected one next meeting')
      const nextInSeries = nextInSeriesRows[0]!

      await db.insert(schema.meetingProjects).values({
        meetingId: current.id,
        projectId: retreat.id,
      })

      const blocks = await computeBlocks(db, current.id, { today: '2026-10-05' })
      expect(blocks.lookahead?.meetings.map((m) => m.id)).toContain(nextInSeries.id)
    })

    it('is null when block is off', async () => {
      const { parish, retreat } = await makeWorld()

      const meetingRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        title: 'Meeting',
        startsAt: new Date('2026-10-05T10:00:00Z'),
        blocks: { followUps: false, sinceLast: false, lookahead: false },
      }).returning()
      if (meetingRows.length !== 1) throw new Error('Expected one meeting')
      const meeting = meetingRows[0]!

      await db.insert(schema.meetingProjects).values({
        meetingId: meeting.id,
        projectId: retreat.id,
      })

      await db.insert(schema.milestones).values({
        id: randomUUID(),
        projectId: retreat.id,
        title: 'Milestone',
        dueOn: '2026-11-15',
      })

      const blocks = await computeBlocks(db, meeting.id, { today: '2026-10-05' })
      expect(blocks.lookahead).toBeNull()
    })

    it('null when has nothing', async () => {
      const { parish } = await makeWorld()

      const meetingRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        title: 'Meeting',
        startsAt: new Date('2026-10-05T10:00:00Z'),
        blocks: { followUps: false, sinceLast: false, lookahead: true },
      }).returning()
      if (meetingRows.length !== 1) throw new Error('Expected one meeting')
      const meeting = meetingRows[0]!

      const blocks = await computeBlocks(db, meeting.id, { today: '2026-10-05' })
      expect(blocks.lookahead).toBeNull()
    })
  })

  describe('force options', () => {
    it('force.followUps=true overrides blocks setting', async () => {
      const { parish, sarah } = await makeWorld()

      const meetingRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        title: 'Meeting',
        startsAt: new Date('2026-10-05T10:00:00Z'),
        blocks: { followUps: false, sinceLast: false, lookahead: false },
      }).returning()
      if (meetingRows.length !== 1) throw new Error('Expected one meeting')
      const meeting = meetingRows[0]!

      const action = await createItem(db, actor, {
        contextId: parish.id,
        text: 'action',
        kind: 'action',
        parties: [{ personId: sarah.id, role: 'owner' }],
      })

      await db.insert(schema.agendaLines).values({
        id: randomUUID(),
        meetingId: meeting.id,
        itemId: action.id,
        position: 0,
      })

      const blocks = await computeBlocks(db, meeting.id, {
        today: '2026-10-05',
        force: { followUps: true },
      })
      expect(blocks.followUps).not.toBeNull()
    })
  })

  describe('context isolation', () => {
    it('only includes items from meeting context', async () => {
      const { parish, diocese, sarah } = await makeWorld()

      const meetingRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        title: 'Parish meeting',
        startsAt: new Date('2026-10-05T10:00:00Z'),
        blocks: { followUps: true, sinceLast: false, lookahead: false },
      }).returning()
      if (meetingRows.length !== 1) throw new Error('Expected one meeting')
      const meeting = meetingRows[0]!

      // Item from correct context
      const parishAction = await createItem(db, actor, {
        contextId: parish.id,
        text: 'in parish',
        kind: 'action',
        parties: [{ personId: sarah.id, role: 'owner' }],
      })

      // Item from wrong context
      await createItem(db, actor, {
        contextId: diocese.id,
        text: 'in diocese',
        kind: 'action',
        parties: [{ personId: sarah.id, role: 'owner' }],
      })

      await db.insert(schema.agendaLines).values([
        { id: randomUUID(), meetingId: meeting.id, itemId: parishAction.id, position: 0 },
      ])

      const blocks = await computeBlocks(db, meeting.id, { today: '2026-10-05' })
      expect(blocks.followUps![0]!.items.map((i) => i.itemId)).toEqual([parishAction.id])
    })
  })
})
