/*
 * The candidate and leak rules, case by case from docs/SPEC.md ("Agendas pull
 * candidates" and "Verification"). Each asserts on exact ids: a rule that lets
 * one extra item through is a leak.
 */

import { describe, expect, it } from 'vitest'
import {
  dismissCandidate,
  getCandidates,
  placeAutomatic,
  placeItem,
  restoreCandidate,
  type Candidates,
} from '../lib/agenda/candidates'
import { computeBlocks } from '../lib/agenda/generated'
import { getAgenda, removeLine } from '../lib/agenda/lines'
import { agendaLines } from '../lib/db/schema'
import { createPerson } from '../lib/directory/people'
import { addMember } from '../lib/directory/groups'
import { completeItem, createItem, recordDecision } from '../lib/items/items'
import { createMeeting } from '../lib/meetings/meetings'
import { createSeries } from '../lib/meetings/series'
import { db, resetBetweenTests } from './helpers/db'
import { actor, makeWorld } from './helpers/fixtures'

resetBetweenTests()

const NOW = new Date('2026-10-05T15:00:00Z')
const TODAY = '2026-10-05'
const ALL_ON = { followUps: true, sinceLast: true, lookahead: true }

const ids = (list: { id: string }[]) => list.map((item) => item.id).sort()
const grouped = (groups: Candidates['suggested']) => ids(groups.flatMap((group) => group.items))
/** Every item a meeting could show anywhere before John places it. */
const offered = (c: Candidates) => [...ids(c.toPlace), ...grouped(c.suggested)].sort()

async function blockItemIds(meetingId: string): Promise<string[]> {
  const blocks = await computeBlocks(db, meetingId, { today: TODAY, now: NOW, force: ALL_ON })
  return [
    ...(blocks.followUps ?? []).flatMap((entry) => entry.items.map((item) => item.itemId)),
    ...(blocks.sinceLast
      ? [...blocks.sinceLast.decisions, ...blocks.sinceLast.closed, ...blocks.sinceLast.stillOpen].map(
          (entry) => entry.itemId,
        )
      : []),
    ...(blocks.lookahead?.deadlines ?? []).map((entry) => entry.itemId),
  ]
}

describe('a larger meeting', () => {
  it('a ten-person staff meeting places nothing person-only and suggests none of it', async () => {
    const w = await makeWorld()
    const extras = []
    for (let n = 0; n < 8; n++) extras.push(await createPerson(db, { name: `Staffer ${n}` }))
    const everyone = [w.sarah, w.tom, ...extras]
    const meeting = await createMeeting(db, actor, {
      contextId: w.parish.id,
      title: 'Staff',
      startsAt: new Date('2026-10-06T15:00:00Z'),
      personIds: everyone.map((person) => person.id),
    })
    expect(meeting.people).toHaveLength(10)

    const personOnly = []
    for (const person of everyone) {
      personOnly.push(
        await createItem(db, actor, {
          contextId: w.parish.id,
          text: `raise with ${person.name}`,
          parties: [{ personId: person.id, role: 'with' }],
        }),
        await createItem(db, actor, {
          contextId: w.parish.id,
          kind: 'action',
          text: `${person.name} owes this`,
          parties: [{ personId: person.id, role: 'owner' }],
        }),
      )
    }

    const candidates = await getCandidates(db, meeting.id, NOW)
    expect(offered(candidates)).toEqual([])
    expect(grouped(candidates.more)).toEqual(ids(personOnly))
    expect(await placeAutomatic(db, actor, meeting.id, NOW)).toBe(0)
    expect(await blockItemIds(meeting.id)).toEqual([])
  })

  it('a private 1:1 item never reaches a group agenda or its blocks', async () => {
    const w = await makeWorld()
    const priv = await createItem(db, actor, {
      contextId: w.parish.id,
      kind: 'action',
      text: 'performance concern',
      dueOn: '2026-10-10',
      parties: [
        { personId: w.sarah.id, role: 'owner' },
        { personId: w.john.id, role: 'with' },
      ],
    })
    const staffItem = await createItem(db, actor, {
      contextId: w.parish.id,
      text: 'rota',
      parties: [{ groupId: w.staff.id, role: 'with' }],
    })
    const meeting = await createMeeting(db, actor, {
      contextId: w.parish.id,
      groupId: w.staff.id,
      projectIds: [w.retreat.id],
      startsAt: new Date('2026-10-06T15:00:00Z'),
    })
    expect(ids(meeting.people)).toEqual(ids([w.sarah, w.tom]))

    const candidates = await getCandidates(db, meeting.id, NOW)
    expect(offered(candidates)).toEqual([staffItem.id])
    expect(grouped(candidates.more)).toEqual([priv.id])
    await placeAutomatic(db, actor, meeting.id, NOW)
    expect(await blockItemIds(meeting.id)).toEqual([])

    // The same person in a 1:1: now it is offered, under her name.
    const oneToOne = await createMeeting(db, actor, { contextId: w.parish.id, personIds: [w.sarah.id] })
    const solo = await getCandidates(db, oneToOne.id, NOW)
    expect(ids(solo.toPlace)).toEqual([])
    expect(solo.suggested.map((group) => group.by)).toEqual([
      { type: 'person', id: w.sarah.id, name: 'Sarah Jones' },
    ])
    expect(grouped(solo.suggested)).toEqual([priv.id])
  })

  it('an attendee item on a project the meeting does not carry waits under more', async () => {
    const w = await makeWorld()
    const item = await createItem(db, actor, {
      contextId: w.parish.id,
      text: 'campaign thing',
      projectId: w.campaign.id,
      parties: [{ personId: w.tom.id, role: 'with' }],
    })
    const meeting = await createMeeting(db, actor, {
      contextId: w.parish.id,
      personIds: [w.sarah.id, w.tom.id, w.bishop.id],
      projectIds: [w.retreat.id],
    })
    const candidates = await getCandidates(db, meeting.id, NOW)
    expect(offered(candidates)).toEqual([])
    expect(grouped(candidates.more)).toEqual([item.id])
  })
})

describe('what is never a candidate', () => {
  it('items matched only through John, closed items and decisions', async () => {
    const w = await makeWorld()
    await addMember(db, w.staff.id, w.john.id)
    await createItem(db, actor, {
      contextId: w.parish.id,
      kind: 'action',
      text: 'mine alone',
      parties: [{ personId: w.john.id, role: 'owner' }],
    })
    const closed = await createItem(db, actor, {
      contextId: w.parish.id,
      text: 'finished',
      parties: [{ personId: w.sarah.id, role: 'with' }],
    })
    await completeItem(db, actor, closed.id)
    await recordDecision(db, actor, {
      contextId: w.parish.id,
      text: 'we decided',
      projectId: w.retreat.id,
      parties: [{ personId: w.sarah.id, role: 'with' }],
    })

    for (const personIds of [[w.sarah.id], [w.sarah.id, w.tom.id]]) {
      const meeting = await createMeeting(db, actor, {
        contextId: w.parish.id,
        personIds,
        projectIds: [w.retreat.id],
      })
      const candidates = await getCandidates(db, meeting.id, NOW)
      expect(offered(candidates)).toEqual([])
      expect(grouped(candidates.more)).toEqual([])
    }
  })

  it('an item with no target is not placed on a meeting with no series', async () => {
    const w = await makeWorld()
    await createItem(db, actor, { contextId: w.parish.id, text: 'loose' })
    const meeting = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Ad hoc' })
    expect(offered(await getCandidates(db, meeting.id, NOW))).toEqual([])
  })
})

describe('context isolation', () => {
  it('nothing from one context reaches another through a person, a target or a block', async () => {
    const w = await makeWorld()
    // The bishop is met in both contexts.
    const parishItem = await createItem(db, actor, {
      contextId: w.parish.id,
      kind: 'question',
      text: 'parish question',
      dueOn: '2026-10-08',
      projectId: w.retreat.id,
      parties: [{ personId: w.bishop.id, role: 'with' }],
    })
    const dioceseItem = await createItem(db, actor, {
      contextId: w.diocese.id,
      kind: 'question',
      text: 'diocese question',
      dueOn: '2026-10-08',
      projectId: w.synod.id,
      parties: [{ personId: w.bishop.id, role: 'owner' }],
    })

    const inDiocese = await createMeeting(db, actor, {
      contextId: w.diocese.id,
      personIds: [w.bishop.id],
      groupId: w.council.id,
      projectIds: [w.synod.id],
    })
    const candidates = await getCandidates(db, inDiocese.id, NOW)
    expect([...offered(candidates), ...grouped(candidates.more)]).toEqual([dioceseItem.id])
    await placeAutomatic(db, actor, inDiocese.id, NOW)
    expect(await blockItemIds(inDiocese.id)).not.toContain(parishItem.id)

    // Aiming or placing across the boundary is refused outright.
    await expect(
      createItem(db, actor, { contextId: w.parish.id, text: 'x', target: { meetingId: inDiocese.id } }),
    ).rejects.toThrow(/another context/)
    await expect(placeItem(db, actor, inDiocese.id, parishItem.id)).rejects.toThrow(/another context/)
    await expect(createMeeting(db, actor, { contextId: w.diocese.id, projectIds: [w.retreat.id] })).rejects.toThrow(
      /another context/,
    )
  })
})

describe('dismissal', () => {
  it('a dismissed suggestion stays dismissed until restored, and taking a line off dismisses it', async () => {
    const w = await makeWorld()
    const suggestion = await createItem(db, actor, {
      contextId: w.parish.id,
      text: 'retreat venue',
      projectId: w.retreat.id,
    })
    const placed = await createItem(db, actor, {
      contextId: w.parish.id,
      text: 'raise with sarah',
      parties: [{ personId: w.sarah.id, role: 'with' }],
    })
    const meeting = await createMeeting(db, actor, {
      contextId: w.parish.id,
      personIds: [w.sarah.id],
      projectIds: [w.retreat.id],
    })

    await dismissCandidate(db, actor, meeting.id, suggestion.id)
    expect(await placeAutomatic(db, actor, meeting.id, NOW)).toBe(1)
    for (let round = 0; round < 2; round++) {
      const candidates = await getCandidates(db, meeting.id, NOW)
      expect(offered(candidates)).toEqual([])
      expect(ids(candidates.dismissed)).toEqual([suggestion.id])
    }

    // Removing an automatically placed line must not see it placed again.
    const agenda = await getAgenda(db, meeting.id)
    const line = agenda.nodes.find((node) => node.type === 'line' && node.item?.id === placed.id)!
    await removeLine(db, actor, line.id)
    expect(await placeAutomatic(db, actor, meeting.id, NOW)).toBe(0)
    expect(ids((await getCandidates(db, meeting.id, NOW)).dismissed)).toEqual(ids([suggestion, placed]))

    await restoreCandidate(db, actor, meeting.id, suggestion.id)
    expect(grouped((await getCandidates(db, meeting.id, NOW)).suggested)).toEqual([suggestion.id])

    await completeItem(db, actor, placed.id)
    expect(ids((await getCandidates(db, meeting.id, NOW)).dismissed)).toEqual([])
  })
})

describe('a series target', () => {
  it('goes to the next occurrence only', async () => {
    const w = await makeWorld()
    const series = await createSeries(db, { contextId: w.parish.id, name: 'Staff weekly' })
    const at = (iso: string) => createMeeting(db, actor, { contextId: w.parish.id, seriesId: series.id, startsAt: new Date(iso) })
    const past = await at('2026-09-28T15:00:00Z')
    const next = await at('2026-10-06T15:00:00Z')
    const later = await at('2026-10-13T15:00:00Z')
    const item = await createItem(db, actor, {
      contextId: w.parish.id,
      text: 'for staff',
      target: { seriesId: series.id },
    })

    expect(ids((await getCandidates(db, past.id, NOW)).toPlace)).toEqual([])
    expect(ids((await getCandidates(db, later.id, NOW)).toPlace)).toEqual([])
    expect(ids((await getCandidates(db, next.id, NOW)).toPlace)).toEqual([item.id])

    await placeAutomatic(db, actor, next.id, NOW)
    await placeAutomatic(db, actor, next.id, NOW)
    expect(await db.select().from(agendaLines)).toHaveLength(1)
  })
})

describe('follow-ups', () => {
  it('lists only what is on the agenda, however much else the attendee owes', async () => {
    const w = await makeWorld()
    const onAgenda = await createItem(db, actor, {
      contextId: w.parish.id,
      kind: 'action',
      text: 'book the venue',
      dueOn: '2026-10-01',
      projectId: w.retreat.id,
      parties: [{ personId: w.tom.id, role: 'owner' }],
    })
    await createItem(db, actor, {
      contextId: w.parish.id,
      kind: 'action',
      text: 'something else tom owes',
      projectId: w.retreat.id,
      parties: [{ personId: w.tom.id, role: 'owner' }],
    })
    const meeting = await createMeeting(db, actor, {
      contextId: w.parish.id,
      personIds: [w.sarah.id, w.tom.id],
      projectIds: [w.retreat.id],
    })
    await placeItem(db, actor, meeting.id, onAgenda.id)

    const blocks = await computeBlocks(db, meeting.id, { today: TODAY, now: NOW, force: ALL_ON })
    expect(blocks.followUps).toEqual([
      {
        party: { type: 'person', id: w.tom.id, name: 'Tom Baker' },
        items: [{ itemId: onAgenda.id, kind: 'action', text: 'book the venue', dueOn: '2026-10-01', overdue: true }],
      },
    ])
    // Off unless asked for.
    expect(await computeBlocks(db, meeting.id, { today: TODAY })).toEqual({
      followUps: null,
      sinceLast: null,
      lookahead: null,
    })
  })
})
