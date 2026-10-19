import { describe, expect, it } from 'vitest'
import { archive } from '../lib/archive/archive'
import { createContext, listContexts } from '../lib/directory/contexts'
import { createItem, parkItem } from '../lib/items/items'
import { createMeeting } from '../lib/meetings/meetings'
import { saveNote } from '../lib/notes/notes'
import { addProposals } from '../lib/processing/proposals'
import { meetingsEverywhere, owedEverywhere } from '../lib/today'
import { db, resetBetweenTests } from './helpers/db'
import { actor, makeWorld } from './helpers/fixtures'

resetBetweenTests()

const TODAY = '2026-10-04'

describe('Today', () => {
  it('lists what I owe and wait on from every context, with what is due by today ahead', async () => {
    const { parish, diocese, john, sarah } = await makeWorld()
    const mine = (contextId: string, text: string, dueOn?: string) =>
      createItem(db, actor, {
        contextId,
        kind: 'action',
        text,
        dueOn,
        parties: [{ personId: john.id, role: 'owner' }],
      })
    const theirs = (contextId: string, text: string, dueOn?: string) =>
      createItem(db, actor, {
        contextId,
        kind: 'action',
        text,
        dueOn,
        parties: [{ personId: sarah.id, role: 'owner' }],
      })

    await mine(parish.id, 'overdue in the parish', '2026-10-01')
    await mine(diocese.id, 'due soon in the diocese', '2026-10-10')
    await theirs(diocese.id, 'Sarah owes today', TODAY)
    await theirs(parish.id, 'Sarah owes next week', '2026-10-11')
    await mine(diocese.id, 'undated')
    const parked = await mine(parish.id, 'parked', '2026-12-01')
    await parkItem(db, actor, parked.id, { until: null })

    const owed = await owedEverywhere(db, await listContexts(db), john.id, TODAY)
    expect(owed.due.map((item) => item.text)).toEqual(['overdue in the parish', 'Sarah owes today'])
    expect(owed.mine.map((item) => item.text)).toEqual(['due soon in the diocese'])
    expect(owed.waiting.map((item) => item.text)).toEqual(['Sarah owes next week'])
    expect(owed.later.mine.map((item) => item.text).sort()).toEqual(['parked', 'undated'])
    // Each keeps its context, so the row can say where it is and open there.
    expect(owed.due.map((item) => item.contextId)).toEqual([parish.id, diocese.id])
  })

  it('leaves out an archived context', async () => {
    const { parish, john } = await makeWorld()
    const attic = await createContext(db, { name: 'Attic' })
    await createItem(db, actor, {
      contextId: attic.id,
      kind: 'action',
      text: 'in the attic',
      dueOn: TODAY,
      parties: [{ personId: john.id, role: 'owner' }],
    })
    await createItem(db, actor, {
      contextId: parish.id,
      kind: 'action',
      text: 'in the parish',
      dueOn: TODAY,
      parties: [{ personId: john.id, role: 'owner' }],
    })
    await archive(db, 'context', attic.id)

    const owed = await owedEverywhere(db, await listContexts(db), john.id, TODAY)
    expect(owed.due.map((item) => item.text)).toEqual(['in the parish'])
  })

  it('merges the next meetings of every context, soonest first', async () => {
    const { parish, diocese } = await makeWorld()
    const now = new Date('2026-10-04T12:00:00Z')
    const at = (iso: string) => new Date(iso)
    await createMeeting(db, actor, { contextId: diocese.id, title: 'Council', startsAt: at('2026-10-06T15:00:00Z'), endsAt: at('2026-10-06T16:00:00Z') })
    await createMeeting(db, actor, { contextId: parish.id, title: 'Staff', startsAt: at('2026-10-05T15:00:00Z'), endsAt: at('2026-10-05T16:00:00Z') })
    await createMeeting(db, actor, { contextId: parish.id, title: 'Vestry', startsAt: at('2026-10-07T15:00:00Z'), endsAt: at('2026-10-07T16:00:00Z') })

    const { today, next } = await meetingsEverywhere(db, await listContexts(db), { timeZone: 'UTC', now, events: [] })
    expect(today).toEqual([])
    expect(next.map((entry) => [entry.meeting?.title, entry.contextId])).toEqual([
      ['Staff', parish.id],
      ['Council', diocese.id],
      ['Vestry', parish.id],
    ])
  })

  it('counts a question I asked of no one in particular as Waiting on', async () => {
    const { parish, john, sarah } = await makeWorld()
    const question = (text: string, parties: Parameters<typeof createItem>[2]['parties'], dueOn?: string) =>
      createItem(db, actor, { contextId: parish.id, kind: 'question', text, dueOn, parties })

    await question('per-delegate cost', [{ personId: john.id, role: 'with' }], '2026-10-08')
    await question('nobody named', [], '2026-10-09')
    await question('undated, asked by me', [{ personId: john.id, role: 'with' }])
    // Sarah asked it and nobody answers: not mine to wait on.
    await question('Sarah wonders', [{ personId: sarah.id, role: 'with' }], '2026-10-08')
    // Asked of me: I owe it.
    await question('asked of me', [{ personId: john.id, role: 'owner' }], '2026-10-08')
    // An action with nobody on it is not waited on.
    await createItem(db, actor, { contextId: parish.id, kind: 'action', text: 'loose action', dueOn: '2026-10-08' })

    const owed = await owedEverywhere(db, await listContexts(db), john.id, TODAY)
    expect(owed.waiting.map((item) => item.text)).toEqual(['per-delegate cost', 'nobody named'])
    // No date: it waits in Later, findable without crowding the list.
    expect(owed.later.waiting.map((item) => item.text)).toEqual(['undated, asked by me'])
    expect(owed.mine.map((item) => item.text)).toEqual(['asked of me'])
  })

  it('leaves an ongoing question off I owe and Waiting on, whoever it is asked of', async () => {
    const { parish, john, sarah } = await makeWorld()
    const ongoing = (text: string, personId: string) =>
      createItem(db, actor, {
        contextId: parish.id,
        kind: 'question',
        text,
        dueOn: '2026-10-08',
        ongoing: true,
        parties: [{ personId, role: 'owner' }],
      })
    await ongoing('2028 pilgrimage dates', john.id)
    await ongoing('Long-term venue', sarah.id)

    const owed = await owedEverywhere(db, await listContexts(db), john.id, TODAY)
    expect([...owed.mine, ...owed.waiting, ...owed.later.mine, ...owed.later.waiting]).toEqual([])
  })

  it('waits on a topic someone else raises; one I raise or collaborate on is owed by nobody', async () => {
    const { parish, john, sarah, tom, bishop } = await makeWorld()
    const topic = (text: string, owners: string[]) =>
      createItem(db, actor, {
        contextId: parish.id,
        kind: 'topic',
        text,
        dueOn: '2026-10-08',
        parties: [
          ...owners.map((personId) => ({ personId, role: 'owner' as const })),
          { personId: bishop.id, role: 'with' as const },
        ],
      })
    await topic('Sarah raises it', [sarah.id, john.id])
    await topic('I raise it', [john.id, tom.id])

    const owed = await owedEverywhere(db, await listContexts(db), john.id, TODAY)
    expect(owed.mine).toEqual([])
    expect(owed.waiting.map((item) => item.text)).toEqual(['Sarah raises it'])
  })

  it("lists today's meetings by the user's clock, apart from Next up", async () => {
    const { parish, diocese } = await makeWorld()
    // 10:00 in New York (UTC-4) on Oct 4.
    const now = new Date('2026-10-04T14:00:00Z')
    const meeting = (contextId: string, title: string, startsAt: string, endsAt: string) =>
      createMeeting(db, actor, { contextId, title, startsAt: new Date(startsAt), endsAt: new Date(endsAt) })

    await meeting(parish.id, 'Last night', '2026-10-04T03:00:00Z', '2026-10-04T03:45:00Z') // 23:00 on Oct 3
    const early = await meeting(parish.id, 'Early', '2026-10-04T04:30:00Z', '2026-10-04T05:00:00Z') // 00:30
    const noted = await meeting(diocese.id, 'Noted', '2026-10-04T12:00:00Z', '2026-10-04T13:00:00Z')
    const proposed = await meeting(parish.id, 'Proposed', '2026-10-04T12:30:00Z', '2026-10-04T13:30:00Z')
    await meeting(diocese.id, 'Under way', '2026-10-04T13:30:00Z', '2026-10-04T14:30:00Z')
    await meeting(parish.id, 'Late', '2026-10-05T03:30:00Z', '2026-10-05T04:00:00Z') // 23:30, Oct 5 in UTC
    await meeting(parish.id, 'After midnight', '2026-10-05T04:30:00Z', '2026-10-05T05:00:00Z') // 00:30 on Oct 5

    await saveNote(db, actor, { meetingId: noted.id, source: 'pasted', body: 'We met.' })
    const note = await saveNote(db, actor, { meetingId: proposed.id, source: 'pasted', body: 'Book the hall.' })
    await addProposals(db, { meetingId: proposed.id, noteId: note.note.id }, [
      { payload: { type: 'item', kind: 'action', text: 'Book the hall', parties: [] } },
    ])

    const { today, next } = await meetingsEverywhere(db, await listContexts(db), {
      timeZone: 'America/New_York',
      now,
      events: [],
    })
    expect(today.map((entry) => [entry.meeting?.title, entry.phase, entry.step])).toEqual([
      ['Early', 'done', 'log'],
      ['Noted', 'done', 'recap'],
      ['Proposed', 'done', 'review'],
      ['Under way', 'now', null],
      ['Late', 'later', null],
    ])
    expect(today.find((entry) => entry.meeting?.id === proposed.id)?.pending).toBe(1)
    expect(today[0]!.meeting!.id).toBe(early.id)
    expect(next.map((entry) => entry.meeting?.title)).toEqual(['After midnight'])
  })

  it("lists a meeting's sessions of today in its place", async () => {
    const { parish } = await makeWorld()
    const now = new Date('2026-10-05T14:00:00Z')
    const conference = await createMeeting(db, actor, {
      contextId: parish.id,
      title: 'Annual Conference',
      startsAt: new Date('2026-10-04T13:00:00Z'),
      endsAt: new Date('2026-10-06T21:00:00Z'),
    })
    const session = (title: string, startsAt: string, endsAt: string) =>
      createMeeting(db, actor, {
        contextId: parish.id,
        parentMeetingId: conference.id,
        title,
        startsAt: new Date(startsAt),
        endsAt: new Date(endsAt),
      })
    await session('Day one', '2026-10-04T13:00:00Z', '2026-10-04T21:00:00Z')
    await session('Day two', '2026-10-05T13:00:00Z', '2026-10-05T21:00:00Z')
    await session('Day three', '2026-10-06T13:00:00Z', '2026-10-06T21:00:00Z')

    const { today, next } = await meetingsEverywhere(db, await listContexts(db), { timeZone: 'UTC', now, events: [] })
    expect(today.map((entry) => [entry.meeting?.title, entry.phase])).toEqual([
      ['Annual Conference · Day two', 'now'],
    ])
    expect(next).toEqual([])
  })
})
