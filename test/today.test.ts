import { describe, expect, it } from 'vitest'
import { archive } from '../lib/archive/archive'
import { createContext, listContexts } from '../lib/directory/contexts'
import { createItem, parkItem } from '../lib/items/items'
import { createMeeting } from '../lib/meetings/meetings'
import { owedEverywhere, upcomingEverywhere } from '../lib/today'
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

    const next = await upcomingEverywhere(db, await listContexts(db), { now, events: [] })
    expect(next.map((entry) => [entry.meeting?.title, entry.contextId])).toEqual([
      ['Staff', parish.id],
      ['Council', diocese.id],
      ['Vestry', parish.id],
    ])
  })
})
