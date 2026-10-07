/*
 * The candidate and leak rules, case by case from docs/SPEC.md ("Agendas pull
 * candidates" and "Verification"). Each asserts on exact ids: a rule that lets
 * one extra item through is a leak.
 */

import { eq } from 'drizzle-orm'
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
import { getAgenda, moveToSession, removeLine } from '../lib/agenda/lines'
import { getRecap, renderPersonSnippet, renderRecap, renderRecapHtml } from '../lib/agenda/recap'
import { agendaLines, items } from '../lib/db/schema'
import { createPerson } from '../lib/directory/people'
import { addMember } from '../lib/directory/groups'
import { completeItem, createItem, getItem, markDiscussed, recordDecision } from '../lib/items/items'
import { createMeeting, getMeeting, setMeetingPeople, updateMeeting } from '../lib/meetings/meetings'
import type { CalendarEvent } from '../lib/calendar/feed'
import { prepFromEvent, prepMeeting, prepWithPerson } from '../lib/meetings/prep'
import { joinRoster, outOfStep, recordAbsences, syncRoster } from '../lib/meetings/roster'
import { createSeries, setSeriesPeople } from '../lib/meetings/series'
import { addMilestone, createProject, getProject, nextMilestones, updateProject } from '../lib/projects/projects'
import { resolveProject } from '../lib/directory/resolve'
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
    // The group stands for its members: at it, but not on it by name.
    expect(meeting.people).toEqual([])
    expect(ids(meeting.attendees)).toEqual(ids([w.sarah, w.tom]))

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

  it('a calendar event with one invitee suggests what is for her; prepping a meeting with her places it', async () => {
    const w = await makeWorld()
    const forSarah = await createItem(db, actor, {
      contextId: w.parish.id,
      text: 'accountability process',
      parties: [{ personId: w.sarah.id, role: 'with' }],
    })
    const event: CalendarEvent = {
      calendarId: 'cal-1',
      eventId: 'site-visit',
      seriesId: null,
      title: 'Hold for site visit',
      startsAt: new Date('2026-10-07T15:00:00Z'),
      endsAt: new Date('2026-10-07T16:00:00Z'),
      allDay: false,
      attendees: [{ personId: w.sarah.id, email: 'sarah@example.test', name: null, declined: false }],
      location: null,
      htmlLink: null,
    }

    const visit = await prepFromEvent(db, actor, { contextId: w.parish.id, event }, NOW)
    expect(ids(visit.people)).toEqual([w.sarah.id])
    expect((await getAgenda(db, visit.id)).nodes).toEqual([])
    const offeredThere = await getCandidates(db, visit.id, NOW)
    expect(ids(offeredThere.toPlace)).toEqual([])
    expect(grouped(offeredThere.suggested)).toEqual([forSarah.id])

    const stub = await prepWithPerson(db, actor, { contextId: w.parish.id, personId: w.sarah.id }, NOW)
    const placed = (await getAgenda(db, stub.id)).nodes.flatMap((node) =>
      node.type === 'line' && node.item ? [node.item.id] : [],
    )
    expect(placed).toEqual([forSarah.id])
  })

  it('a group meeting with one member so far is not a 1:1: what is for her alone waits under more', async () => {
    const w = await makeWorld()
    const forSarah = await createItem(db, actor, {
      contextId: w.parish.id,
      text: 'for sarah alone',
      parties: [{ personId: w.sarah.id, role: 'with' }],
    })
    const forStaff = await createItem(db, actor, {
      contextId: w.parish.id,
      text: 'for the staff',
      parties: [{ groupId: w.staff.id, role: 'with' }],
    })
    const meeting = await prepMeeting(db, actor, {
      contextId: w.parish.id,
      personIds: [w.sarah.id],
      groupId: w.staff.id,
    })
    expect((await getAgenda(db, meeting.id)).nodes).toEqual([])
    const candidates = await getCandidates(db, meeting.id, NOW)
    expect(ids(candidates.toPlace)).toEqual([])
    expect(grouped(candidates.suggested)).toEqual([forStaff.id])
    expect(grouped(candidates.more)).toEqual([forSarah.id])
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

  it('what came out of a meeting is not offered back to it, but is at the next one', async () => {
    const w = await makeWorld()
    const meeting = await createMeeting(db, actor, { contextId: w.parish.id, personIds: [w.sarah.id] })
    const outcome = await createItem(db, actor, {
      contextId: w.parish.id,
      kind: 'action',
      text: 'send the minutes',
      parties: [{ personId: w.sarah.id, role: 'owner' }],
      originMeetingId: meeting.id,
    })
    const there = await getCandidates(db, meeting.id, NOW)
    expect(offered(there)).toEqual([])
    expect(grouped(there.more)).toEqual([])

    const next = await createMeeting(db, actor, { contextId: w.parish.id, personIds: [w.sarah.id] })
    expect(offered(await getCandidates(db, next.id, NOW))).toEqual([outcome.id])
  })

  it('a question asked of no one in particular is owed by nobody: never offered, never a follow-up', async () => {
    const w = await makeWorld()
    const asked = await createItem(db, actor, {
      contextId: w.parish.id,
      kind: 'question',
      text: 'per-delegate cost?',
      parties: [{ personId: w.john.id, role: 'with' }],
    })
    await createItem(db, actor, { contextId: w.parish.id, kind: 'question', text: 'nobody named?' })

    const oneOnOne = await createMeeting(db, actor, { contextId: w.parish.id, personIds: [w.sarah.id] })
    const candidates = await getCandidates(db, oneOnOne.id, NOW)
    expect(offered(candidates)).toEqual([])
    expect(grouped(candidates.more)).toEqual([])

    // Aimed at a meeting by hand, it is on the agenda, and still nobody owes it.
    await placeItem(db, actor, oneOnOne.id, asked.id)
    const blocks = await computeBlocks(db, oneOnOne.id, { today: TODAY, now: NOW, force: ALL_ON })
    expect(blocks.followUps).toBeNull()
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
    const series = await createSeries(db, { contextId: w.parish.id, name: 'Sarah check-in' })
    const meeting = await createMeeting(db, actor, {
      contextId: w.parish.id,
      seriesId: series.id,
      personIds: [w.sarah.id],
      projectIds: [w.retreat.id],
    })
    const placed = await createItem(db, actor, {
      contextId: w.parish.id,
      text: 'raise with sarah',
      target: { seriesId: series.id },
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

describe('an item aimed elsewhere', () => {
  it('is not offered at another meeting through its person, group or project', async () => {
    const w = await makeWorld()
    const chairs = await createSeries(db, { contextId: w.parish.id, name: 'Chairs' })
    const checkIn = await createSeries(db, { contextId: w.parish.id, name: 'Sarah check-in', personIds: [w.sarah.id] })
    const oneToOne = await prepMeeting(db, actor, {
      contextId: w.parish.id,
      seriesId: checkIn.id,
      startsAt: new Date('2026-10-06T15:00:00Z'),
      projectIds: [w.retreat.id],
    })
    const staff = await createMeeting(db, actor, { contextId: w.parish.id, groupIds: [w.staff.id], startsAt: new Date('2026-10-08T15:00:00Z') })
    const vestry = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Vestry', startsAt: new Date('2026-10-09T15:00:00Z') })
    const project = await createProject(db, { contextId: w.parish.id, name: 'Elsewhere' })
    const tagged = { parties: [{ personId: w.sarah.id, role: 'with' as const }, { groupId: w.staff.id, role: 'with' as const }], projectId: w.retreat.id }
    const toChairs = await createItem(db, actor, { contextId: w.parish.id, text: 'to the chairs', target: { seriesId: chairs.id }, ...tagged })
    const toVestry = await createItem(db, actor, { contextId: w.parish.id, text: 'to the vestry', target: { meetingId: vestry.id }, ...tagged })
    const toProject = await createItem(db, actor, { contextId: w.parish.id, text: 'to the project', target: { projectId: project.id }, ...tagged })
    const free = await createItem(db, actor, { contextId: w.parish.id, text: 'free', ...tagged })

    for (const meeting of [oneToOne, staff]) {
      const c = await getCandidates(db, meeting.id, NOW)
      expect([...offered(c), ...grouped(c.more), ...ids(c.dismissed)]).toEqual([free.id])
    }
    // Where it is aimed, it is placed; the others are on their way elsewhere.
    const atVestry = await getCandidates(db, vestry.id, NOW)
    expect(ids(atVestry.toPlace)).toEqual([toVestry.id])
    expect(offered(atVestry)).not.toContain(toChairs.id)
    expect(offered(atVestry)).not.toContain(toProject.id)
  })

  it('whose meeting is over is matched as if it had no aim', async () => {
    const w = await makeWorld()
    const past = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Done', startsAt: new Date('2026-09-28T15:00:00Z') })
    const oneToOne = await createMeeting(db, actor, { contextId: w.parish.id, personIds: [w.sarah.id] })
    const item = await createItem(db, actor, {
      contextId: w.parish.id,
      text: 'left over',
      target: { meetingId: past.id },
      parties: [{ personId: w.sarah.id, role: 'with' }],
    })

    expect(grouped((await getCandidates(db, oneToOne.id, NOW)).suggested)).toEqual([item.id])
  })
})

describe('a meeting target', () => {
  it('taken off the agenda, the aim is spent and the item is suggested again', async () => {
    const w = await makeWorld()
    const meeting = await createMeeting(db, actor, { contextId: w.parish.id, personIds: [w.sarah.id] })
    const item = await createItem(db, actor, {
      contextId: w.parish.id,
      text: 'the long conversation',
      target: { meetingId: meeting.id },
      parties: [{ personId: w.sarah.id, role: 'with' }],
    })
    await placeAutomatic(db, actor, meeting.id, NOW)
    const [line] = (await getAgenda(db, meeting.id)).nodes
    await removeLine(db, actor, line!.id)

    expect((await getItem(db, item.id)).targetMeetingId).toBeNull()
    const candidates = await getCandidates(db, meeting.id, NOW)
    expect(ids(candidates.dismissed)).toEqual([])
    expect(grouped(candidates.suggested)).toEqual([item.id])
    // And at her next meeting too.
    const next = await createMeeting(db, actor, { contextId: w.parish.id, personIds: [w.sarah.id] })
    expect(grouped((await getCandidates(db, next.id, NOW)).suggested)).toEqual([item.id])
  })
})

describe('a series target', () => {
  it('taken off one meeting, is placed on the next', async () => {
    const w = await makeWorld()
    const series = await createSeries(db, { contextId: w.parish.id, name: 'Staff weekly' })
    const at = (iso: string) => createMeeting(db, actor, { contextId: w.parish.id, seriesId: series.id, startsAt: new Date(iso) })
    const next = await at('2026-10-06T15:00:00Z')
    const after = await at('2026-10-13T15:00:00Z')
    const item = await createItem(db, actor, { contextId: w.parish.id, text: 'for staff', target: { seriesId: series.id } })
    await placeAutomatic(db, actor, next.id, NOW)
    const [line] = (await getAgenda(db, next.id)).nodes
    await removeLine(db, actor, line!.id)

    // Once the first is over, the second is the next occurrence.
    const later = new Date('2026-10-07T00:00:00Z')
    expect(ids((await getCandidates(db, next.id, later)).toPlace)).toEqual([])
    expect(ids((await getCandidates(db, after.id, later)).toPlace)).toEqual([item.id])
  })

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

describe('a roster change', () => {
  // Far enough ahead that the meetings are not over whenever the suite runs.
  const at = (day: string) => new Date(`2030-01-${day}T15:00:00Z`)

  it('reaches the series’ upcoming meetings, and what is for the person added is suggested, not placed', async () => {
    const w = await makeWorld()
    const adlene = await createPerson(db, { name: 'Adlene' })
    const series = await createSeries(db, { contextId: w.parish.id, name: 'Adlene/John Check-In' })
    const first = await prepMeeting(db, actor, { contextId: w.parish.id, seriesId: series.id, startsAt: at('07') })
    const second = await prepMeeting(db, actor, { contextId: w.parish.id, seriesId: series.id, startsAt: at('14') })
    const topic = await createItem(db, actor, {
      contextId: w.parish.id,
      text: 'Accountability process for team-to-team collaborations',
      parties: [{ personId: adlene.id, role: 'owner' }],
    })
    const owedToHer = await createItem(db, actor, {
      contextId: w.parish.id,
      text: 'ask about the handbook',
      parties: [{ personId: adlene.id, role: 'with' }],
    })
    expect(offered(await getCandidates(db, first.id, NOW))).toEqual([])

    await setSeriesPeople(db, series.id, [adlene.id])

    for (const meeting of [first, second]) {
      expect((await getMeeting(db, meeting.id)).people.map((person) => person.id)).toEqual([adlene.id])
    }
    for (const meeting of [first, second]) {
      expect(await getAgenda(db, meeting.id)).toMatchObject({ nodes: [] })
      // What she owes and what John wants to raise with her are one click away in her 1:1.
      expect(grouped((await getCandidates(db, meeting.id, NOW)).suggested)).toEqual(ids([topic, owedToHer]))
    }
  })

  it('an item to raise that is not ripe yet waits as a suggestion at each meeting until placed', async () => {
    const w = await makeWorld()
    const series = await createSeries(db, { contextId: w.parish.id, name: 'Sarah check-in', personIds: [w.sarah.id] })
    const first = await prepMeeting(db, actor, { contextId: w.parish.id, seriesId: series.id, startsAt: at('07') })
    const second = await prepMeeting(db, actor, { contextId: w.parish.id, seriesId: series.id, startsAt: at('14') })
    const later = await createItem(db, actor, {
      contextId: w.parish.id,
      text: 'the long conversation',
      parties: [{ personId: w.sarah.id, role: 'with' }],
    })
    const aimed = await createItem(db, actor, {
      contextId: w.parish.id,
      text: 'this week',
      target: { seriesId: series.id },
    })

    // Aimed at the series: placed on its next meeting, by opening it.
    expect(await placeAutomatic(db, actor, first.id, NOW)).toBe(1)
    const itemsOn = async (meetingId: string) =>
      (await getAgenda(db, meetingId)).nodes.flatMap((node) => (node.type === 'line' && node.item ? [node.item.id] : []))
    expect(await itemsOn(first.id)).toEqual([aimed.id])

    // Not this time: it is suggested again at the next one.
    await dismissCandidate(db, actor, first.id, later.id)
    expect(grouped((await getCandidates(db, first.id, NOW)).suggested)).toEqual([])
    expect(await placeAutomatic(db, actor, second.id, NOW)).toBe(0)
    expect(grouped((await getCandidates(db, second.id, NOW)).suggested)).toEqual([later.id])

    // Placed by hand when it is ripe.
    await placeItem(db, actor, second.id, later.id)
    expect(await itemsOn(second.id)).toEqual([later.id])
  })

  it('leaves a meeting edited by hand until asked, and never puts back someone left off it', async () => {
    const w = await makeWorld()
    const series = await createSeries(db, { contextId: w.parish.id, name: 'Staff', personIds: [w.sarah.id] })
    const out = await prepMeeting(db, actor, { contextId: w.parish.id, seriesId: series.id, startsAt: at('07') })
    const edited = await prepMeeting(db, actor, { contextId: w.parish.id, seriesId: series.id, startsAt: at('14') })
    const untouched = await prepMeeting(db, actor, { contextId: w.parish.id, seriesId: series.id, startsAt: at('21') })
    // Sarah is out on the 7th; the bishop joins on the 14th.
    await setMeetingPeople(db, actor, out.id, [])
    await recordAbsences(db, out.id)
    await setMeetingPeople(db, actor, edited.id, [w.sarah.id, w.bishop.id])
    await recordAbsences(db, edited.id)

    await setSeriesPeople(db, series.id, [w.sarah.id, w.tom.id])

    const people = async (id: string) => (await getMeeting(db, id)).people.map((person) => person.id).sort()
    expect(await people(out.id)).toEqual([w.tom.id])
    expect(await people(edited.id)).toEqual([w.sarah.id, w.bishop.id].sort())
    expect(await people(untouched.id)).toEqual([w.sarah.id, w.tom.id].sort())

    expect((await outOfStep(db, series.id)).map((meeting) => meeting.id)).toEqual([edited.id])
    expect(await syncRoster(db, actor, series.id)).toBe(1)
    expect(await people(edited.id)).toEqual([w.sarah.id, w.tom.id, w.bishop.id].sort())
    expect(await people(out.id)).toEqual([w.tom.id])
    expect(await outOfStep(db, series.id)).toEqual([])
  })

  it('a meeting newly in a series takes its roster and projects', async () => {
    const w = await makeWorld()
    const series = await createSeries(db, {
      contextId: w.parish.id,
      name: 'Staff',
      personIds: [w.sarah.id],
      projectIds: [w.retreat.id],
    })
    const byHand = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Check-in', startsAt: at('07') })
    await updateMeeting(db, actor, byHand.id, { seriesId: series.id })
    expect(await joinRoster(db, actor, byHand.id)).toBe(true)
    const meeting = await getMeeting(db, byHand.id)
    expect(meeting.people.map((person) => person.id)).toEqual([w.sarah.id])
    expect(meeting.projects.map((project) => project.id)).toEqual([w.retreat.id])
  })
})

describe('a multi-day meeting', () => {
  async function retreatWithSessions() {
    const w = await makeWorld()
    const retreat = await createMeeting(db, actor, {
      contextId: w.parish.id,
      title: 'Retreat',
      personIds: [w.sarah.id],
      projectIds: [w.retreat.id],
    })
    const session = (title: string, iso: string | null) =>
      createMeeting(db, actor, {
        contextId: w.parish.id,
        title,
        parentMeetingId: retreat.id,
        startsAt: iso ? new Date(iso) : null,
        personIds: [w.sarah.id],
        projectIds: [w.retreat.id],
      })
    const done = await session('Day zero', '2026-10-04T15:00:00Z')
    const first = await session('Day one', '2026-10-06T15:00:00Z')
    const second = await session('Day two', '2026-10-07T15:00:00Z')
    return { w, retreat, done, first, second }
  }

  it('a line bumped to the next session goes there, and is not placed back where it was', async () => {
    const { w, retreat, first, second } = await retreatWithSessions()
    const aimed = await createItem(db, actor, { contextId: w.parish.id, text: 'for the retreat', target: { meetingId: retreat.id } })
    await placeAutomatic(db, actor, first.id, NOW)
    const lineOf = async (meetingId: string) =>
      (await getAgenda(db, meetingId)).nodes.flatMap((node) => (node.type === 'line' && node.item ? [node] : []))
    const [line] = await lineOf(first.id)
    expect(line!.item!.id).toBe(aimed.id)

    await moveToSession(db, actor, line!.id, second.id)
    expect(await lineOf(first.id)).toEqual([])
    expect((await lineOf(second.id)).map((one) => one.item!.id)).toEqual([aimed.id])
    expect(await placeAutomatic(db, actor, first.id, NOW)).toBe(0)
    expect(ids((await getCandidates(db, first.id, NOW)).dismissed)).toEqual([aimed.id])

    // Only between sessions of one meeting.
    const elsewhere = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Staff' })
    const [moved] = await lineOf(second.id)
    await expect(moveToSession(db, actor, moved!.id, elsewhere.id)).rejects.toThrow('same meeting')
  })

  it('what is aimed at the whole meeting goes to its next session, and the meeting places nothing itself', async () => {
    const { w, retreat, done, first, second } = await retreatWithSessions()
    const aimed = await createItem(db, actor, { contextId: w.parish.id, text: 'for the retreat', target: { meetingId: retreat.id } })
    // Offered on each session with her, never placed.
    const withSarah = await createItem(db, actor, {
      contextId: w.parish.id,
      text: 'ask sarah',
      parties: [{ personId: w.sarah.id, role: 'with' }],
    })

    expect(ids((await getCandidates(db, retreat.id, NOW)).toPlace)).toEqual([])
    expect(await placeAutomatic(db, actor, retreat.id, NOW)).toBe(0)
    expect(ids((await getCandidates(db, done.id, NOW)).toPlace)).toEqual([])
    expect(ids((await getCandidates(db, first.id, NOW)).toPlace)).toEqual([aimed.id])
    expect(ids((await getCandidates(db, second.id, NOW)).toPlace)).toEqual([])
    for (const one of [done, first, second]) {
      expect(grouped((await getCandidates(db, one.id, NOW)).suggested)).toContain(withSarah.id)
    }
  })

  it('follow-ups of the whole meeting are drawn from its sessions’ agendas, and nothing else', async () => {
    const { w, retreat, first } = await retreatWithSessions()
    const owed = (text: string) =>
      createItem(db, actor, {
        contextId: w.parish.id,
        kind: 'action',
        text,
        projectId: w.retreat.id,
        parties: [{ personId: w.tom.id, role: 'owner' }],
      })
    const placed = await owed('book the hall')
    await owed('never raised')
    await placeItem(db, actor, first.id, placed.id)

    expect(await blockItemIds(retreat.id)).toEqual(expect.arrayContaining([placed.id]))
    const blocks = await computeBlocks(db, retreat.id, { today: TODAY, now: NOW, force: ALL_ON })
    expect(blocks.followUps?.flatMap((entry) => entry.items.map((item) => item.itemId))).toEqual([placed.id])
    // Its own sessions are not "next" in its lookahead.
    expect(blocks.lookahead?.meetings ?? []).toEqual([])
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

/*
 * The recap is sent to the people who were in the room, so a leak here leaves
 * the building. It may speak only of what was placed on the agenda or came out
 * of the meeting.
 */
describe('the recap', () => {
  /** Everything a recap says, in every form it is copied out in. */
  async function recapText(meetingId: string, selfId: string): Promise<string> {
    const recap = await getRecap(db, meetingId, { today: TODAY, timeZone: 'America/Chicago', selfId, now: NOW })
    const parties = [
      ...recap.meeting.people.map((person) => ({ type: 'person' as const, id: person.id })),
      { type: 'person' as const, id: selfId },
      ...recap.owed.flatMap((group) => (group.party ? [{ type: group.party.type, id: group.party.id }] : [])),
    ]
    return [
      JSON.stringify(recap),
      renderRecap(recap),
      renderRecapHtml(recap),
      ...parties.map((party) => renderPersonSnippet(recap, party)),
    ].join('\n')
  }

  it('a private 1:1 item never appears in a group meeting, whatever it carries; a placed one does', async () => {
    const w = await makeWorld()
    // Everything about these matches the meeting: its people, its group, its project, a date in range.
    const privates = [
      await createItem(db, actor, {
        contextId: w.parish.id,
        kind: 'action',
        text: 'performance concern',
        dueOn: '2026-10-10',
        projectId: w.retreat.id,
        parties: [
          { personId: w.sarah.id, role: 'owner' },
          { personId: w.john.id, role: 'with' },
        ],
      }),
      await createItem(db, actor, {
        contextId: w.parish.id,
        kind: 'question',
        text: 'salary review',
        dueOn: '2026-10-12',
        parties: [
          { personId: w.john.id, role: 'owner' },
          { personId: w.sarah.id, role: 'with' },
        ],
      }),
      await createItem(db, actor, {
        contextId: w.parish.id,
        text: 'quiet word about the rota',
        dueOn: '2026-10-09',
        projectId: w.retreat.id,
        parties: [{ groupId: w.staff.id, role: 'with' }],
      }),
    ]
    const closedPrivate = await createItem(db, actor, {
      contextId: w.parish.id,
      kind: 'action',
      text: 'warning letter',
      projectId: w.retreat.id,
      parties: [{ personId: w.sarah.id, role: 'owner' }],
    })
    await completeItem(db, actor, closedPrivate.id, { resolution: 'sent' })
    await recordDecision(db, actor, { fromItemId: closedPrivate.id, text: 'probation extended' })

    const placed = await createItem(db, actor, {
      contextId: w.parish.id,
      kind: 'action',
      text: 'book the venue',
      projectId: w.retreat.id,
      parties: [{ personId: w.sarah.id, role: 'owner' }],
    })
    const meeting = await createMeeting(db, actor, {
      contextId: w.parish.id,
      groupId: w.staff.id,
      projectIds: [w.retreat.id],
      startsAt: new Date('2026-10-06T15:00:00Z'),
    })
    // Offered as candidates, and still not the recap's to mention.
    await placeAutomatic(db, actor, meeting.id, NOW)
    expect(offered(await getCandidates(db, meeting.id, NOW)).length).toBeGreaterThan(0)
    await placeItem(db, actor, meeting.id, placed.id)

    const text = await recapText(meeting.id, w.john.id)
    expect(text).toContain('book the venue')
    for (const item of [...privates, closedPrivate]) {
      expect(text).not.toContain(item.text)
      expect(text).not.toContain(item.id)
    }
    expect(text).not.toContain('probation')

    // John places one of them: now it is the meeting's.
    await placeItem(db, actor, meeting.id, privates[0]!.id)
    expect(await recapText(meeting.id, w.john.id)).toContain('performance concern')
  })

  it('an item originating in the meeting appears, and one originating in another does not', async () => {
    const w = await makeWorld()
    const meeting = await createMeeting(db, actor, {
      contextId: w.parish.id,
      personIds: [w.sarah.id, w.tom.id],
      startsAt: new Date('2026-10-06T15:00:00Z'),
    })
    const oneToOne = await createMeeting(db, actor, {
      contextId: w.parish.id,
      personIds: [w.sarah.id],
      startsAt: new Date('2026-10-06T17:00:00Z'),
    })
    const from = (meetingId: string, text: string, kind: 'action' | 'decision') =>
      createItem(db, actor, {
        contextId: w.parish.id,
        kind,
        text,
        originMeetingId: meetingId,
        parties: [{ personId: w.sarah.id, role: 'owner' }],
      })
    await from(meeting.id, 'send the minutes', 'action')
    await from(meeting.id, 'meet monthly', 'decision')
    await from(oneToOne.id, 'see a counsellor', 'action')
    await from(oneToOne.id, 'hours reduced', 'decision')

    const text = await recapText(meeting.id, w.john.id)
    expect(text).toContain('send the minutes')
    expect(text).toContain('meet monthly')
    expect(text).not.toContain('counsellor')
    expect(text).not.toContain('hours reduced')
  })

  it('a dismissed suggestion does not appear, and an item taken off the agenda leaves', async () => {
    const w = await makeWorld()
    const make = (text: string) =>
      createItem(db, actor, {
        contextId: w.parish.id,
        kind: 'action',
        text,
        projectId: w.retreat.id,
        parties: [{ personId: w.tom.id, role: 'owner' }],
      })
    const dismissed = await make('dismissed suggestion')
    const removed = await make('placed then removed')
    await make('never looked at')
    const meeting = await createMeeting(db, actor, {
      contextId: w.parish.id,
      personIds: [w.sarah.id, w.tom.id],
      projectIds: [w.retreat.id],
    })
    await dismissCandidate(db, actor, meeting.id, dismissed.id)
    await placeItem(db, actor, meeting.id, removed.id)
    expect(await recapText(meeting.id, w.john.id)).toContain('placed then removed')

    const agenda = await getAgenda(db, meeting.id)
    await removeLine(db, actor, agenda.nodes.find((node) => node.type === 'line' && node.item?.id === removed.id)!.id)

    const text = await recapText(meeting.id, w.john.id)
    for (const gone of ['dismissed suggestion', 'placed then removed', 'never looked at']) {
      expect(text).not.toContain(gone)
    }
  })

  it('nothing from another context appears, even through a stray reference', async () => {
    const w = await makeWorld()
    // The bishop is met in both contexts.
    const meeting = await createMeeting(db, actor, {
      contextId: w.diocese.id,
      personIds: [w.bishop.id],
      groupId: w.council.id,
      projectIds: [w.synod.id],
      startsAt: new Date('2026-10-06T15:00:00Z'),
    })
    const parishItems = []
    for (const kind of ['action', 'question', 'decision', 'topic'] as const) {
      parishItems.push(
        await createItem(db, actor, {
          contextId: w.parish.id,
          kind,
          text: `parish ${kind}`,
          dueOn: kind === 'decision' ? null : '2026-10-08',
          projectId: w.retreat.id,
          parties: [{ personId: w.bishop.id, role: 'owner' }],
        }),
      )
    }
    await createItem(db, actor, {
      contextId: w.diocese.id,
      kind: 'action',
      text: 'diocese action',
      parties: [{ personId: w.bishop.id, role: 'owner' }],
      originMeetingId: meeting.id,
    })
    expect(await recapText(meeting.id, w.john.id)).not.toContain('parish')

    // Rows the domain layer refuses to write, written anyway: the recap still holds the line.
    await db.insert(agendaLines).values({ meetingId: meeting.id, itemId: parishItems[0]!.id, position: 0 })
    for (const item of parishItems.slice(1)) {
      await db.update(items).set({ originMeetingId: meeting.id }).where(eq(items.id, item.id))
    }
    const text = await recapText(meeting.id, w.john.id)
    expect(text).toContain('diocese action')
    expect(text).not.toContain('parish')
  })

  it('a deadline on the meeting\'s project is not in the lookahead unless the meeting raised it', async () => {
    const w = await makeWorld()
    await createItem(db, actor, {
      contextId: w.parish.id,
      text: 'private and dated',
      dueOn: '2026-10-20',
      projectId: w.retreat.id,
      parties: [{ personId: w.sarah.id, role: 'with' }],
    })
    const raised = await createItem(db, actor, {
      contextId: w.parish.id,
      text: 'raised and dated',
      dueOn: '2026-10-21',
      projectId: w.retreat.id,
    })
    const meeting = await createMeeting(db, actor, {
      contextId: w.parish.id,
      personIds: [w.sarah.id, w.tom.id],
      projectIds: [w.retreat.id],
      startsAt: new Date('2026-10-04T15:00:00Z'),
    })
    await placeItem(db, actor, meeting.id, raised.id)

    const recap = await getRecap(db, meeting.id, { today: TODAY, timeZone: null, selfId: w.john.id, now: NOW })
    expect(recap.lookahead?.deadlines.map((deadline) => deadline.text)).toEqual(['raised and dated'])
    expect(renderRecap(recap)).not.toContain('private and dated')
  })
})

describe('milestones in the lookahead', () => {
  it('a milestone is upcoming or past by its date alone', async () => {
    const w = await makeWorld()
    const meeting = await createMeeting(db, actor, {
      contextId: w.parish.id,
      title: 'Retreat planning',
      startsAt: new Date('2026-10-06T15:00:00Z'),
      projectIds: [w.retreat.id],
    })
    await addMilestone(db, { projectId: w.retreat.id, title: 'Venue booked', dueOn: '2026-10-04' })
    await addMilestone(db, { projectId: w.retreat.id, title: 'Retreat day', dueOn: TODAY })
    await addMilestone(db, { projectId: w.retreat.id, title: 'Someday' })

    const blocks = await computeBlocks(db, meeting.id, { today: TODAY, now: NOW, force: ALL_ON })
    expect(blocks.lookahead?.milestones.map((m) => m.title)).toEqual(['Retreat day'])
    const next = await nextMilestones(db, w.parish.id, TODAY)
    expect(next.get(w.retreat.id)?.title).toBe('Retreat day')
    expect((await nextMilestones(db, w.parish.id, '2026-10-06')).has(w.retreat.id)).toBe(false)
  })
})

describe('projects within projects', () => {
  async function conference() {
    const w = await makeWorld()
    const standing = await createProject(db, { contextId: w.parish.id, name: 'Annual Conference' })
    const year = await createProject(db, { contextId: w.parish.id, name: '2027 Annual Conference', parentId: standing.id })
    const lastYear = await createProject(db, { contextId: w.parish.id, name: '2026 Annual Conference', parentId: standing.id })
    const worship = await createProject(db, { contextId: w.parish.id, name: 'AC2027 Worship', parentId: year.id })
    const music = await createProject(db, { contextId: w.parish.id, name: 'AC2027 Music', parentId: year.id })
    const on = (projectId: string, text: string) =>
      createItem(db, actor, { contextId: w.parish.id, text, projectId })
    return {
      w,
      standing,
      year,
      lastYear,
      worship,
      music,
      items: {
        standing: await on(standing.id, 'bylaws'),
        year: await on(year.id, 'venue for 2027'),
        lastYear: await on(lastYear.id, '2026 accounts'),
        worship: await on(worship.id, 'hymn list'),
        music: await on(music.id, 'organist'),
      },
    }
  }
  const meetingOn = (contextId: string, projectId: string) =>
    createMeeting(db, actor, { contextId, title: 'Planning', personIds: [], projectIds: [projectId] })

  it('a meeting on a project suggests its sub-projects’ items by sub-project, and keeps its parent’s under more', async () => {
    const { w, year, worship, music, standing, items } = await conference()
    const meeting = await meetingOn(w.parish.id, year.id)
    const c = await getCandidates(db, meeting.id, NOW)

    expect(ids(c.toPlace)).toEqual([])
    expect(c.suggested.map((group) => [group.by.id, ids(group.items)]).sort()).toEqual(
      [
        [year.id, [items.year.id]],
        [worship.id, [items.worship.id]],
        [music.id, [items.music.id]],
      ].sort(),
    )
    expect(c.more.map((group) => [group.by.id, ids(group.items)])).toEqual([[standing.id, [items.standing.id]]])
    // A sibling of the meeting's project is nobody's business here.
    expect([...offered(c), ...grouped(c.more)]).not.toContain(items.lastYear.id)
    expect(await placeAutomatic(db, actor, meeting.id, NOW)).toBe(0)
  })

  it('a meeting on a leaf reaches every project above it under more, and no sibling', async () => {
    const { w, worship, year, standing, items } = await conference()
    const meeting = await meetingOn(w.parish.id, worship.id)
    const c = await getCandidates(db, meeting.id, NOW)
    expect(grouped(c.suggested)).toEqual([items.worship.id])
    expect(c.more.map((group) => group.by.id).sort()).toEqual([year.id, standing.id].sort())
    expect(grouped(c.more)).toEqual([items.year.id, items.standing.id].sort())
    expect([...offered(c), ...grouped(c.more)]).not.toContain(items.music.id)
  })

  it('the lookahead reads up and down the tree, not sideways', async () => {
    const { w, year, worship, standing, lastYear, music } = await conference()
    await addMilestone(db, { projectId: standing.id, title: 'Bylaws vote', dueOn: '2026-10-20' })
    await addMilestone(db, { projectId: year.id, title: 'Registration opens', dueOn: '2026-10-21' })
    await addMilestone(db, { projectId: worship.id, title: 'Hymns chosen', dueOn: '2026-10-22' })
    await addMilestone(db, { projectId: music.id, title: 'Organist booked', dueOn: '2026-10-23' })
    await addMilestone(db, { projectId: lastYear.id, title: '2026 accounts closed', dueOn: '2026-10-24' })

    const onLeaf = await meetingOn(w.parish.id, worship.id)
    const leaf = await computeBlocks(db, onLeaf.id, { today: TODAY, now: NOW, force: ALL_ON })
    expect(leaf.lookahead?.milestones.map((m) => `${m.projectName}: ${m.title}`)).toEqual([
      'Annual Conference: Bylaws vote',
      '2027 Annual Conference: Registration opens',
      'AC2027 Worship: Hymns chosen',
    ])

    const onYear = await meetingOn(w.parish.id, year.id)
    const middle = await computeBlocks(db, onYear.id, { today: TODAY, now: NOW, force: ALL_ON })
    expect(middle.lookahead?.milestones.map((m) => m.title)).toEqual([
      'Bylaws vote',
      'Registration opens',
      'Hymns chosen',
      'Organist booked',
    ])
  })

  it('refuses a cycle and a parent in another context, and names a child by path', async () => {
    const { w, standing, worship } = await conference()
    await expect(updateProject(db, standing.id, { parentId: worship.id })).rejects.toThrow(/inside itself/)
    await expect(updateProject(db, standing.id, { parentId: standing.id })).rejects.toThrow(/inside itself/)
    const elsewhere = await createProject(db, { contextId: w.diocese.id, name: 'Synod 2027' })
    await expect(updateProject(db, elsewhere.id, { parentId: standing.id })).rejects.toThrow(/another context/)

    expect((await resolveProject(db, w.parish.id, 'AC2027/Worship')).id).toBe(worship.id)
    expect((await resolveProject(db, w.parish.id, '2027/Worship')).id).toBe(worship.id)
    await expect(resolveProject(db, w.parish.id, '2026/Worship')).rejects.toThrow(/No project/)
  })

  it("leaves a parent's sub-projects alone when its status changes, unless asked to take them along", async () => {
    const { standing, year, lastYear, worship } = await conference()
    const status = async (id: string) => (await getProject(db, id)).status

    await updateProject(db, year.id, { status: 'paused' })
    expect(await status(year.id)).toBe('paused')
    expect(await status(worship.id)).toBe('active')

    // Asked: every project under it, at any depth, and nothing beside or above it.
    await updateProject(db, standing.id, { status: 'done', subProjects: true })
    expect(await status(year.id)).toBe('done')
    expect(await status(worship.id)).toBe('done')
    expect(await status(lastYear.id)).toBe('done')

    await updateProject(db, year.id, { status: 'active', subProjects: true })
    expect(await status(worship.id)).toBe('active')
    expect(await status(lastYear.id)).toBe('done')
    expect(await status(standing.id)).toBe('done')
  })
})

describe('the next meeting for a project', () => {
  const at = (day: string) => new Date(`2030-01-${day}T15:00:00Z`)

  it('waits until a meeting carries the project, then goes to the next one only, until discussed', async () => {
    const w = await makeWorld()
    const worship = await createProject(db, { contextId: w.parish.id, name: 'Worship', parentId: w.retreat.id })
    const item = await createItem(db, actor, {
      contextId: w.parish.id,
      text: 'choose the hymns',
      target: { projectId: w.retreat.id },
    })
    const unrelated = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Staff', startsAt: at('06') })
    expect(ids((await getCandidates(db, unrelated.id, NOW)).toPlace)).toEqual([])

    // A meeting on a project within it counts; a past one does not.
    await createMeeting(db, actor, { contextId: w.parish.id, title: 'Old', startsAt: new Date('2026-09-01T15:00:00Z'), projectIds: [w.retreat.id] })
    const later = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Later', startsAt: at('20'), projectIds: [w.retreat.id] })
    const first = await prepMeeting(db, actor, { contextId: w.parish.id, title: 'Worship planning', startsAt: at('13'), projectIds: [worship.id] })
    expect(ids((await getCandidates(db, later.id)).toPlace)).toEqual([])
    const placed = (await getAgenda(db, first.id)).nodes.flatMap((node) => (node.type === 'line' && node.item ? [node.item.id] : []))
    expect(placed).toEqual([item.id])

    // Discussed there, it is aimed nowhere any more.
    await markDiscussed(db, actor, item.id, first.id)
    expect((await getItem(db, item.id)).targetProjectId).toBeNull()
  })

  it('a meeting with sessions hands it to its next session, and another context never sees it', async () => {
    const w = await makeWorld()
    const item = await createItem(db, actor, { contextId: w.parish.id, text: 'budget', target: { projectId: w.retreat.id } })
    const retreat = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Retreat', startsAt: at('10'), projectIds: [w.retreat.id] })
    const day = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Day one', parentMeetingId: retreat.id, startsAt: at('10') })
    expect(ids((await getCandidates(db, retreat.id)).toPlace)).toEqual([])
    expect(ids((await getCandidates(db, day.id)).toPlace)).toEqual([item.id])

    const synod = await createMeeting(db, actor, { contextId: w.diocese.id, title: 'Synod', startsAt: at('09'), projectIds: [w.synod.id] })
    expect(offered(await getCandidates(db, synod.id))).toEqual([])
    await expect(
      createItem(db, actor, { contextId: w.diocese.id, text: 'x', target: { projectId: w.retreat.id } }),
    ).rejects.toThrow(/another context/)
  })
})

describe('an archived meeting', () => {
  it('places nothing, and is passed over as a series’ next occurrence and a project’s next meeting', async () => {
    const w = await makeWorld()
    const { archive } = await import('../lib/archive/archive')
    const series = await createSeries(db, { contextId: w.parish.id, name: 'Staff weekly' })
    const at = (iso: string) =>
      createMeeting(db, actor, { contextId: w.parish.id, seriesId: series.id, startsAt: new Date(iso), projectIds: [w.retreat.id] })
    const skipped = await at('2026-10-06T15:00:00Z')
    const next = await at('2026-10-13T15:00:00Z')
    const forSeries = await createItem(db, actor, { contextId: w.parish.id, text: 'for staff', target: { seriesId: series.id } })
    const forProject = await createItem(db, actor, { contextId: w.parish.id, text: 'for the retreat', target: { projectId: w.retreat.id } })
    const forMeeting = await createItem(db, actor, { contextId: w.parish.id, text: 'for that one', target: { meetingId: skipped.id } })

    await archive(db, 'meeting', skipped.id)
    expect(await placeAutomatic(db, actor, skipped.id, NOW)).toBe(0)
    expect(await db.select().from(agendaLines).where(eq(agendaLines.meetingId, skipped.id))).toEqual([])
    expect(ids((await getCandidates(db, next.id, NOW)).toPlace)).toEqual(ids([forSeries, forProject]))
    // What was aimed at it alone waits; it is not passed on.
    expect(ids((await getCandidates(db, next.id, NOW)).toPlace)).not.toContain(forMeeting.id)
  })
})

describe('several groups', () => {
  it('suggests through any of a meeting’s groups, by group, and keeps a member’s own items under more', async () => {
    const w = await makeWorld()
    const { createGroup } = await import('../lib/directory/groups')
    const wardens = await createGroup(db, { contextId: w.parish.id, name: 'Wardens' })
    await addMember(db, wardens.id, w.bishop.id)
    const forStaff = await createItem(db, actor, { contextId: w.parish.id, text: 'rota', parties: [{ groupId: w.staff.id, role: 'with' }] })
    const forWardens = await createItem(db, actor, { contextId: w.parish.id, text: 'roof', parties: [{ groupId: wardens.id, role: 'with' }] })
    const forTom = await createItem(db, actor, { contextId: w.parish.id, text: 'Tom’s own', parties: [{ personId: w.tom.id, role: 'with' }] })
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
    // Two groups and someone from outside both.
    const outsider = await createPerson(db, { name: 'Visiting Speaker' })
    const meeting = await createMeeting(db, actor, {
      contextId: w.parish.id,
      title: 'Joint meeting',
      groupIds: [w.staff.id, wardens.id],
      personIds: [outsider.id],
      startsAt: new Date('2026-10-06T15:00:00Z'),
    })
    expect(ids(meeting.attendees)).toEqual(ids([w.sarah, w.tom, w.bishop, outsider]))

    const candidates = await getCandidates(db, meeting.id, NOW)
    expect(ids(candidates.toPlace)).toEqual([])
    expect(candidates.suggested.map((group) => group.by.name)).toEqual(['Staff', 'Wardens'])
    expect(grouped(candidates.suggested)).toEqual(ids([forStaff, forWardens]))
    expect(grouped(candidates.more)).toEqual(ids([forTom, priv]))

    // Nothing private reaches its blocks or recap.
    await placeAutomatic(db, actor, meeting.id, NOW)
    expect(await blockItemIds(meeting.id)).toEqual([])
    const recap = await getRecap(db, meeting.id, { today: TODAY, timeZone: null, now: NOW, selfId: w.john.id })
    expect(renderRecap(recap)).not.toContain('performance concern')
  })

  it('stand for their members until attendance is settled, then the record stays as it was', async () => {
    const w = await makeWorld()
    const { settleAttendance } = await import('../lib/meetings/attendance')
    const meeting = await createMeeting(db, actor, {
      contextId: w.parish.id,
      groupId: w.staff.id,
      startsAt: new Date('2026-10-06T15:00:00Z'),
    })
    const late = await createPerson(db, { name: 'New Curate' })
    const forHer = await createItem(db, actor, { contextId: w.parish.id, text: 'welcome', parties: [{ personId: late.id, role: 'with' }] })

    // Joining the group before it is settled puts her at it, and her items under more.
    await addMember(db, w.staff.id, late.id)
    expect(ids((await getMeeting(db, meeting.id)).attendees)).toEqual(ids([w.sarah, w.tom, late]))
    expect(grouped((await getCandidates(db, meeting.id, NOW)).more)).toEqual([forHer.id])

    // Settled with Tom out: he is not at it, and someone joining later is not either.
    await settleAttendance(db, meeting.id, [w.sarah.id, late.id], NOW)
    const extra = await createPerson(db, { name: 'Later Still' })
    await addMember(db, w.staff.id, extra.id)
    const after = await getMeeting(db, meeting.id)
    expect(ids(after.attendees)).toEqual(ids([w.sarah, late]))
    expect(after.groups.map((group) => group.id)).toEqual([w.staff.id])
  })

  it('a group on a series’ roster carries to its meetings not yet over', async () => {
    const w = await makeWorld()
    const { updateSeries } = await import('../lib/meetings/series')
    const weekly = await createSeries(db, { contextId: w.parish.id, name: 'Weekly' })
    const past = await createMeeting(db, actor, { contextId: w.parish.id, seriesId: weekly.id, startsAt: new Date('2026-09-28T15:00:00Z') })
    // Roster changes reach meetings not yet over by the clock, so this one is always ahead.
    const next = await createMeeting(db, actor, { contextId: w.parish.id, seriesId: weekly.id, startsAt: new Date(Date.now() + 86_400_000) })
    const forStaff = await createItem(db, actor, { contextId: w.parish.id, text: 'rota', parties: [{ groupId: w.staff.id, role: 'with' }] })

    await updateSeries(db, weekly.id, { groupIds: [w.staff.id] })
    expect((await getMeeting(db, next.id)).groups.map((group) => group.id)).toEqual([w.staff.id])
    expect((await getMeeting(db, past.id)).groups).toEqual([])
    expect(grouped((await getCandidates(db, next.id, NOW)).suggested)).toEqual([forStaff.id])
    // A meeting made after takes the series' groups too.
    const later = await createMeeting(db, actor, { contextId: w.parish.id, seriesId: weekly.id, startsAt: new Date('2026-10-13T15:00:00Z') })
    expect(later.groups.map((group) => group.id)).toEqual([w.staff.id])
  })
})

describe('a group’s list address', () => {
  it('on an invite brings the group, in its own context only, and is refused for a person', async () => {
    const w = await makeWorld()
    const { addGroupEmail } = await import('../lib/directory/groups')
    const { addPersonEmail } = await import('../lib/directory/people')
    const { unknownAttendees } = await import('../lib/notes/attendees')
    const { saveNote } = await import('../lib/notes/notes')
    await addGroupEmail(db, w.staff.id, 'Staff-List@example.test')
    await expect(addPersonEmail(db, w.tom.id, 'staff-list@example.test')).rejects.toThrow('belongs to Staff')
    await expect(addGroupEmail(db, w.council.id, 'sarah@example.test')).rejects.toThrow('belongs to Sarah Jones')

    const forStaff = await createItem(db, actor, { contextId: w.parish.id, text: 'rota', parties: [{ groupId: w.staff.id, role: 'with' }] })
    const invite = (contextEvent: string): CalendarEvent => ({
      calendarId: 'cal-1',
      eventId: contextEvent,
      seriesId: null,
      title: 'Planning',
      startsAt: new Date('2026-10-07T15:00:00Z'),
      endsAt: new Date('2026-10-07T16:00:00Z'),
      allDay: false,
      attendees: [
        { personId: w.bishop.id, email: 'bishop@example.test', name: null, declined: false },
        { email: 'staff-list@example.test', name: 'Staff list', declined: false },
      ],
      location: null,
      htmlLink: null,
    })

    const planning = await prepFromEvent(db, actor, { contextId: w.parish.id, event: invite('evt-parish') }, NOW)
    expect(planning.groups.map((group) => group.id)).toEqual([w.staff.id])
    expect(ids(planning.attendees)).toEqual(ids([w.bishop, w.sarah, w.tom]))
    expect(grouped((await getCandidates(db, planning.id, NOW)).suggested)).toEqual([forStaff.id])

    // The staff is the parish's: in the diocese the address brings nobody.
    const elsewhere = await prepFromEvent(db, actor, { contextId: w.diocese.id, event: invite('evt-diocese') }, NOW)
    expect(elsewhere.groups).toEqual([])

    // A note naming the list does not ask who it is.
    await saveNote(db, actor, {
      meetingId: planning.id,
      source: 'pasted',
      body: 'notes',
      attendees: [{ email: 'staff-list@example.test', name: 'Staff list' }],
    })
    expect(await unknownAttendees(db, planning.id)).toEqual([])
  })
})
