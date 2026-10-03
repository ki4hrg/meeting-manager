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
import { getAgenda, removeLine } from '../lib/agenda/lines'
import { getRecap, renderPersonSnippet, renderRecap, renderRecapHtml } from '../lib/agenda/recap'
import { agendaLines, items } from '../lib/db/schema'
import { createPerson } from '../lib/directory/people'
import { addMember } from '../lib/directory/groups'
import { completeItem, createItem, recordDecision } from '../lib/items/items'
import { createMeeting, getMeeting, setMeetingPeople, updateMeeting } from '../lib/meetings/meetings'
import { prepMeeting } from '../lib/meetings/prep'
import { joinRoster, outOfStep, recordAbsences, syncRoster } from '../lib/meetings/roster'
import { createSeries, setSeriesPeople } from '../lib/meetings/series'
import { addMilestone, nextMilestones } from '../lib/projects/projects'
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

describe('a roster change', () => {
  // Far enough ahead that the meetings are not over whenever the suite runs.
  const at = (day: string) => new Date(`2030-01-${day}T15:00:00Z`)

  it('reaches the series’ upcoming meetings, and an item for the person added is placed', async () => {
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
    const placed = (await getAgenda(db, first.id)).nodes.flatMap((node) =>
      node.type === 'line' && node.item ? [node.item.id] : [],
    )
    expect(placed).toEqual([owedToHer.id])
    // What she owes is one click away in her 1:1, as at prep.
    expect(grouped((await getCandidates(db, first.id, NOW)).suggested)).toEqual([topic.id])
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

  it('what is aimed at the whole meeting goes to its next session, and the meeting places nothing itself', async () => {
    const { w, retreat, done, first, second } = await retreatWithSessions()
    const aimed = await createItem(db, actor, { contextId: w.parish.id, text: 'for the retreat', target: { meetingId: retreat.id } })
    // A 1:1-shaped roster would place this on a meeting of its own.
    const withSarah = await createItem(db, actor, {
      contextId: w.parish.id,
      text: 'ask sarah',
      parties: [{ personId: w.sarah.id, role: 'with' }],
    })

    expect(ids((await getCandidates(db, retreat.id, NOW)).toPlace)).toEqual([])
    expect(await placeAutomatic(db, actor, retreat.id, NOW)).toBe(0)
    expect(ids((await getCandidates(db, done.id, NOW)).toPlace)).toEqual([withSarah.id])
    expect(ids((await getCandidates(db, first.id, NOW)).toPlace)).toEqual([aimed.id, withSarah.id].sort())
    expect(ids((await getCandidates(db, second.id, NOW)).toPlace)).toEqual([withSarah.id])
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
