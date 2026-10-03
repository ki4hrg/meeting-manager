import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  dismissCandidate,
  getCandidates,
  placeAutomatic,
  placeItem,
  restoreCandidate,
} from '../lib/agenda/candidates'
import { completeItem, createItem } from '../lib/items/items'
import { db, resetBetweenTests } from './helpers/db'
import { actor, makeWorld } from './helpers/fixtures'
import { eq } from 'drizzle-orm'
import * as schema from '../lib/db/schema'

resetBetweenTests()

describe('candidates', () => {
  describe('toPlace: target_meeting_id', () => {
    it('places items targeted at this meeting', async () => {
      const { parish } = await makeWorld()

      const meetingRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        title: 'Meeting',
        startsAt: new Date('2026-10-05T10:00:00Z'),
      }).returning()
      if (meetingRows.length !== 1) throw new Error('Expected one meeting')
      const meeting = meetingRows[0]!

      const item = await createItem(db, actor, {
        contextId: parish.id,
        text: 'targeted item',
        target: { meetingId: meeting.id },
      })

      const candidates = await getCandidates(db, meeting.id)
      expect(candidates.toPlace.map((i) => i.id)).toEqual([item.id])
    })

    it('does not place closed items', async () => {
      const { parish } = await makeWorld()

      const meetingRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        title: 'Meeting',
        startsAt: new Date('2026-10-05T10:00:00Z'),
      }).returning()
      if (meetingRows.length !== 1) throw new Error('Expected one meeting')
      const meeting = meetingRows[0]!

      const item = await createItem(db, actor, {
        contextId: parish.id,
        text: 'done item',
        target: { meetingId: meeting.id },
      })

      await completeItem(db, actor, item.id)

      const candidates = await getCandidates(db, meeting.id)
      expect(candidates.toPlace).toEqual([])
    })
  })

  describe('toPlace: target_series_id to next occurrence', () => {
    it('places series-targeted items only on the next occurrence', async () => {
      const { parish } = await makeWorld()

      const seriesRows = await db.insert(schema.series).values({
        id: randomUUID(),
        contextId: parish.id,
        name: 'Weekly',
      }).returning()
      if (seriesRows.length !== 1) throw new Error('Expected one series')
      const series = seriesRows[0]!

      // Create past, current, and future meetings
      const pastRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        seriesId: series.id,
        title: 'Past',
        startsAt: new Date('2026-10-01T10:00:00Z'),
      }).returning()
      if (pastRows.length !== 1) throw new Error('Expected one past meeting')
      const past = pastRows[0]!

      const nextRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        seriesId: series.id,
        title: 'Next',
        startsAt: new Date('2026-10-08T10:00:00Z'),
      }).returning()
      if (nextRows.length !== 1) throw new Error('Expected one next meeting')
      const next = nextRows[0]!

      const laterRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        seriesId: series.id,
        title: 'Later',
        startsAt: new Date('2026-10-15T10:00:00Z'),
      }).returning()
      if (laterRows.length !== 1) throw new Error('Expected one later meeting')
      const later = laterRows[0]!

      const item = await createItem(db, actor, {
        contextId: parish.id,
        text: 'for series',
        target: { seriesId: series.id },
      })

      const now = new Date('2026-10-05T10:00:00Z')

      // Past doesn't get it
      let candidates = await getCandidates(db, past.id, now)
      expect(candidates.toPlace.map((i) => i.id)).toEqual([])

      // Next does
      candidates = await getCandidates(db, next.id, now)
      expect(candidates.toPlace.map((i) => i.id)).toEqual([item.id])

      // Later doesn't (next already happened)
      candidates = await getCandidates(db, later.id, now)
      expect(candidates.toPlace.map((i) => i.id)).toEqual([])
    })

    it('places series items on an undated stub if it has no earlier dated occurrence', async () => {
      const { parish } = await makeWorld()

      const seriesRows = await db.insert(schema.series).values({
        id: randomUUID(),
        contextId: parish.id,
        name: 'Weekly',
      }).returning()
      if (seriesRows.length !== 1) throw new Error('Expected one series')
      const series = seriesRows[0]!

      const stubRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        seriesId: series.id,
        title: 'Stub',
        startsAt: null,
      }).returning()
      if (stubRows.length !== 1) throw new Error('Expected one stub')
      const stub = stubRows[0]!

      const item = await createItem(db, actor, {
        contextId: parish.id,
        text: 'for series',
        target: { seriesId: series.id },
      })

      const candidates = await getCandidates(db, stub.id)
      expect(candidates.toPlace.map((i) => i.id)).toEqual([item.id])
    })
  })

  describe('toPlace: with-person items in 1:1', () => {
    it('places with-person items in exactly 1:1 meetings', async () => {
      const { parish, sarah } = await makeWorld()

      const meetingRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        title: '1:1 with Sarah',
        startsAt: new Date('2026-10-05T10:00:00Z'),
      }).returning()
      if (meetingRows.length !== 1) throw new Error('Expected one meeting')
      const meeting = meetingRows[0]!

      await db.insert(schema.meetingPeople).values({
        meetingId: meeting.id,
        personId: sarah.id,
      })

      const item = await createItem(db, actor, {
        contextId: parish.id,
        text: 'for sarah',
        parties: [{ personId: sarah.id, role: 'with' }],
      })

      const candidates = await getCandidates(db, meeting.id)
      expect(candidates.toPlace.map((i) => i.id)).toEqual([item.id])
    })

    it('does not place person-only items in group meetings', async () => {
      const { parish, sarah, tom } = await makeWorld()

      const meetingRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        title: 'Group meeting',
        startsAt: new Date('2026-10-05T10:00:00Z'),
      }).returning()
      if (meetingRows.length !== 1) throw new Error('Expected one meeting')
      const meeting = meetingRows[0]!

      await db.insert(schema.meetingPeople).values([
        { meetingId: meeting.id, personId: sarah.id },
        { meetingId: meeting.id, personId: tom.id },
      ])

      const item = await createItem(db, actor, {
        contextId: parish.id,
        text: 'for sarah',
        parties: [{ personId: sarah.id, role: 'with' }],
      })

      const candidates = await getCandidates(db, meeting.id)
      expect(candidates.toPlace.map((i) => i.id)).toEqual([])
      expect(candidates.more.length).toBe(1)
      expect(candidates.more[0]!.items.map((i) => i.id)).toEqual([item.id])
    })
  })

  describe('suggested: by project', () => {
    it('suggests items whose project is a meeting project', async () => {
      const { parish, retreat } = await makeWorld()

      const meetingRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        title: 'Retreat prep',
        startsAt: new Date('2026-10-05T10:00:00Z'),
      }).returning()
      if (meetingRows.length !== 1) throw new Error('Expected one meeting')
      const meeting = meetingRows[0]!

      await db.insert(schema.meetingProjects).values({
        meetingId: meeting.id,
        projectId: retreat.id,
      })

      const item = await createItem(db, actor, {
        contextId: parish.id,
        text: 'retreat task',
        projectId: retreat.id,
      })

      const candidates = await getCandidates(db, meeting.id)
      expect(candidates.suggested.length).toBe(1)
      expect(candidates.suggested[0]!.by).toMatchObject({ type: 'project', id: retreat.id })
      expect(candidates.suggested[0]!.items.map((i) => i.id)).toEqual([item.id])
    })
  })

  describe('suggested: by group', () => {
    it('suggests items with owner or with group', async () => {
      const { parish, staff } = await makeWorld()

      const meetingRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        title: 'Staff meeting',
        startsAt: new Date('2026-10-05T10:00:00Z'),
      }).returning()
      await db.insert(schema.meetingGroups).values({ meetingId: meetingRows[0]!.id, groupId: staff.id })
      if (meetingRows.length !== 1) throw new Error('Expected one meeting')
      const meeting = meetingRows[0]!

      const item = await createItem(db, actor, {
        contextId: parish.id,
        text: 'staff matter',
        parties: [{ groupId: staff.id, role: 'owner' }],
      })

      const candidates = await getCandidates(db, meeting.id)
      expect(candidates.suggested.length).toBe(1)
      expect(candidates.suggested[0]!.by).toMatchObject({ type: 'group', id: staff.id })
      expect(candidates.suggested[0]!.items.map((i) => i.id)).toEqual([item.id])
    })
  })

  describe('suggested: by attendee + project or group', () => {
    it('suggests items owned by an attendee that also have a meeting project', async () => {
      const { parish, sarah, retreat } = await makeWorld()

      const meetingRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        title: 'Retreat meeting',
        startsAt: new Date('2026-10-05T10:00:00Z'),
      }).returning()
      if (meetingRows.length !== 1) throw new Error('Expected one meeting')
      const meeting = meetingRows[0]!

      await db.insert(schema.meetingPeople).values({
        meetingId: meeting.id,
        personId: sarah.id,
      })

      await db.insert(schema.meetingProjects).values({
        meetingId: meeting.id,
        projectId: retreat.id,
      })

      const item = await createItem(db, actor, {
        contextId: parish.id,
        text: 'sarah owns retreat task',
        projectId: retreat.id,
        parties: [{ personId: sarah.id, role: 'owner' }],
      })

      const candidates = await getCandidates(db, meeting.id)
      expect(candidates.suggested.length).toBe(1)
      expect(candidates.suggested[0]!.by).toMatchObject({ type: 'project', id: retreat.id })
      expect(candidates.suggested[0]!.items.map((i) => i.id)).toEqual([item.id])
    })
  })

  describe('exclusions', () => {
    it('excludes anything matched only through John', async () => {
      const { parish, john } = await makeWorld()

      const meetingRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        title: 'Meeting',
        startsAt: new Date('2026-10-05T10:00:00Z'),
      }).returning()
      if (meetingRows.length !== 1) throw new Error('Expected one meeting')
      const meeting = meetingRows[0]!

      await createItem(db, actor, {
        contextId: parish.id,
        text: "john's item",
        parties: [{ personId: john.id, role: 'owner' }],
      })

      const candidates = await getCandidates(db, meeting.id)
      expect(candidates.toPlace).toEqual([])
      expect(candidates.suggested).toEqual([])
      expect(candidates.more).toEqual([])
    })

    it('excludes already placed items', async () => {
      const { parish, retreat } = await makeWorld()

      const meetingRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        title: 'Meeting',
        startsAt: new Date('2026-10-05T10:00:00Z'),
      }).returning()
      if (meetingRows.length !== 1) throw new Error('Expected one meeting')
      const meeting = meetingRows[0]!

      await db.insert(schema.meetingProjects).values({
        meetingId: meeting.id,
        projectId: retreat.id,
      })

      const item = await createItem(db, actor, {
        contextId: parish.id,
        text: 'item',
        projectId: retreat.id,
      })

      await db.insert(schema.agendaLines).values({
        id: randomUUID(),
        meetingId: meeting.id,
        itemId: item.id,
        position: 0,
      })

      const candidates = await getCandidates(db, meeting.id)
      expect(candidates.suggested).toEqual([])
    })

    it('excludes dismissed items', async () => {
      const { parish, retreat } = await makeWorld()

      const meetingRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        title: 'Meeting',
        startsAt: new Date('2026-10-05T10:00:00Z'),
      }).returning()
      if (meetingRows.length !== 1) throw new Error('Expected one meeting')
      const meeting = meetingRows[0]!

      await db.insert(schema.meetingProjects).values({
        meetingId: meeting.id,
        projectId: retreat.id,
      })

      const item = await createItem(db, actor, {
        contextId: parish.id,
        text: 'dismissed item',
        projectId: retreat.id,
      })

      await dismissCandidate(db, actor, meeting.id, item.id)

      const candidates = await getCandidates(db, meeting.id)
      expect(candidates.suggested).toEqual([])
    })
  })

  describe('context isolation', () => {
    it('excludes items from other contexts', async () => {
      const { parish, diocese, synod, retreat } = await makeWorld()

      const meetingRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        title: 'Parish meeting',
        startsAt: new Date('2026-10-05T10:00:00Z'),
      }).returning()
      if (meetingRows.length !== 1) throw new Error('Expected one meeting')
      const meeting = meetingRows[0]!

      await db.insert(schema.meetingProjects).values({
        meetingId: meeting.id,
        projectId: retreat.id,
      })

      // Create an item in the same context
      const item = await createItem(db, actor, {
        contextId: parish.id,
        text: 'in parish',
        projectId: retreat.id,
      })

      // Create an item in a different context
      await createItem(db, actor, {
        contextId: diocese.id,
        text: 'in diocese',
        projectId: synod.id,
      })

      const candidates = await getCandidates(db, meeting.id)
      expect(candidates.suggested.map((g) => g.items.map((i) => i.id)).flat()).toEqual([item.id])
    })
  })

  describe('placeAutomatic', () => {
    it('places all toPlace items and returns count', async () => {
      const { parish } = await makeWorld()

      const meetingRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        title: 'Meeting',
        startsAt: new Date('2026-10-05T10:00:00Z'),
      }).returning()
      if (meetingRows.length !== 1) throw new Error('Expected one meeting')
      const meeting = meetingRows[0]!

      const item1 = await createItem(db, actor, {
        contextId: parish.id,
        text: 'one',
        target: { meetingId: meeting.id },
      })

      const item2 = await createItem(db, actor, {
        contextId: parish.id,
        text: 'two',
        target: { meetingId: meeting.id },
      })

      const count = await placeAutomatic(db, actor, meeting.id)
      expect(count).toBe(2)

      const agenda = await db.query.agendaLines.findMany({
        where: eq(schema.agendaLines.meetingId, meeting.id),
      })
      expect(agenda).toHaveLength(2)
      expect(new Set(agenda.map((a) => a.itemId))).toEqual(new Set([item1.id, item2.id]))
    })

    it('is idempotent: running twice places zero more', async () => {
      const { parish } = await makeWorld()

      const meetingRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        title: 'Meeting',
        startsAt: new Date('2026-10-05T10:00:00Z'),
      }).returning()
      if (meetingRows.length !== 1) throw new Error('Expected one meeting')
      const meeting = meetingRows[0]!

      await createItem(db, actor, {
        contextId: parish.id,
        text: 'item',
        target: { meetingId: meeting.id },
      })

      const count1 = await placeAutomatic(db, actor, meeting.id)
      expect(count1).toBe(1)

      const count2 = await placeAutomatic(db, actor, meeting.id)
      expect(count2).toBe(0)
    })

    it('does not place dismissed items', async () => {
      const { parish } = await makeWorld()

      const meetingRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        title: 'Meeting',
        startsAt: new Date('2026-10-05T10:00:00Z'),
      }).returning()
      if (meetingRows.length !== 1) throw new Error('Expected one meeting')
      const meeting = meetingRows[0]!

      const item = await createItem(db, actor, {
        contextId: parish.id,
        text: 'dismissed',
        target: { meetingId: meeting.id },
      })

      await dismissCandidate(db, actor, meeting.id, item.id)
      const count = await placeAutomatic(db, actor, meeting.id)
      expect(count).toBe(0)
    })
  })

  describe('placeItem', () => {
    it('places one item from suggestions', async () => {
      const { parish, retreat } = await makeWorld()

      const meetingRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        title: 'Meeting',
        startsAt: new Date('2026-10-05T10:00:00Z'),
      }).returning()
      if (meetingRows.length !== 1) throw new Error('Expected one meeting')
      const meeting = meetingRows[0]!

      await db.insert(schema.meetingProjects).values({
        meetingId: meeting.id,
        projectId: retreat.id,
      })

      const item = await createItem(db, actor, {
        contextId: parish.id,
        text: 'suggested',
        projectId: retreat.id,
      })

      await placeItem(db, actor, meeting.id, item.id)

      const agenda = await db.query.agendaLines.findMany({
        where: eq(schema.agendaLines.meetingId, meeting.id),
      })
      expect(agenda).toHaveLength(1)
      expect(agenda[0]!.itemId).toBe(item.id)
    })

    it('clears dismissal when placing', async () => {
      const { parish, retreat } = await makeWorld()

      const meetingRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        title: 'Meeting',
        startsAt: new Date('2026-10-05T10:00:00Z'),
      }).returning()
      if (meetingRows.length !== 1) throw new Error('Expected one meeting')
      const meeting = meetingRows[0]!

      await db.insert(schema.meetingProjects).values({
        meetingId: meeting.id,
        projectId: retreat.id,
      })

      const item = await createItem(db, actor, {
        contextId: parish.id,
        text: 'item',
        projectId: retreat.id,
      })

      await dismissCandidate(db, actor, meeting.id, item.id)
      await placeItem(db, actor, meeting.id, item.id)

      const dismissals = await db.query.meetingDismissals.findMany({
        where: eq(schema.meetingDismissals.meetingId, meeting.id),
      })
      expect(dismissals).toEqual([])
    })

    it('is idempotent', async () => {
      const { parish, retreat } = await makeWorld()

      const meetingRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        title: 'Meeting',
        startsAt: new Date('2026-10-05T10:00:00Z'),
      }).returning()
      if (meetingRows.length !== 1) throw new Error('Expected one meeting')
      const meeting = meetingRows[0]!

      await db.insert(schema.meetingProjects).values({
        meetingId: meeting.id,
        projectId: retreat.id,
      })

      const item = await createItem(db, actor, {
        contextId: parish.id,
        text: 'item',
        projectId: retreat.id,
      })

      await placeItem(db, actor, meeting.id, item.id)
      await placeItem(db, actor, meeting.id, item.id)

      const agenda = await db.query.agendaLines.findMany({
        where: eq(schema.agendaLines.meetingId, meeting.id),
      })
      expect(agenda).toHaveLength(1)
    })

    it('validates item is open', async () => {
      const { parish, retreat } = await makeWorld()

      const meetingRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        title: 'Meeting',
        startsAt: new Date('2026-10-05T10:00:00Z'),
      }).returning()
      if (meetingRows.length !== 1) throw new Error('Expected one meeting')
      const meeting = meetingRows[0]!

      const item = await createItem(db, actor, {
        contextId: parish.id,
        text: 'done',
        projectId: retreat.id,
      })

      await completeItem(db, actor, item.id)

      await expect(placeItem(db, actor, meeting.id, item.id)).rejects.toThrow()
    })
  })

  describe('dismissCandidate / restoreCandidate', () => {
    it('dismisses and restores candidates', async () => {
      const { parish, retreat } = await makeWorld()

      const meetingRows = await db.insert(schema.meetings).values({
        id: randomUUID(),
        contextId: parish.id,
        title: 'Meeting',
        startsAt: new Date('2026-10-05T10:00:00Z'),
      }).returning()
      if (meetingRows.length !== 1) throw new Error('Expected one meeting')
      const meeting = meetingRows[0]!

      await db.insert(schema.meetingProjects).values({
        meetingId: meeting.id,
        projectId: retreat.id,
      })

      const item = await createItem(db, actor, {
        contextId: parish.id,
        text: 'item',
        projectId: retreat.id,
      })

      const candidates1 = await getCandidates(db, meeting.id)
      expect(candidates1.suggested[0]!.items.map((i) => i.id)).toEqual([item.id])

      await dismissCandidate(db, actor, meeting.id, item.id)
      const candidates2 = await getCandidates(db, meeting.id)
      expect(candidates2.suggested).toEqual([])

      await restoreCandidate(db, actor, meeting.id, item.id)
      const candidates3 = await getCandidates(db, meeting.id)
      expect(candidates3.suggested[0]!.items.map((i) => i.id)).toEqual([item.id])
    })
  })
})
