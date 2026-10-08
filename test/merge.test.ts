import { describe, expect, it } from 'vitest'
import { addMember, createGroup, getGroup, listGroupEmails, addGroupEmail, listMembers } from '../lib/directory/groups'
import { mergeGroups, mergePeople } from '../lib/directory/merge'
import { createPerson, getPerson } from '../lib/directory/people'
import { createItem, getItem } from '../lib/items/items'
import { createMeeting, getMeeting } from '../lib/meetings/meetings'
import { createSeries, getSeries } from '../lib/meetings/series'
import { db, resetBetweenTests } from './helpers/db'
import { actor, makeWorld } from './helpers/fixtures'

resetBetweenTests()

describe('merging two people', () => {
  it('moves everything on the duplicate to the one kept, which keeps its name', async () => {
    const world = await makeWorld()
    const dupe = await createPerson(db, { name: 'S. Jones', email: 'sj@home.test' })
    const council = await createGroup(db, { contextId: world.parish.id, name: 'Council' })
    await addMember(db, council.id, dupe.id)
    // Both in Staff already: one membership is left.
    await addMember(db, world.staff.id, dupe.id)

    const hers = await createItem(db, actor, {
      contextId: world.parish.id,
      text: 'Book the hall',
      kind: 'action',
      parties: [{ personId: dupe.id, role: 'owner' }],
    })
    // On the same item twice: the kept one's role stands.
    const both = await createItem(db, actor, {
      contextId: world.parish.id,
      text: 'Budget',
      kind: 'action',
      parties: [
        { personId: world.sarah.id, role: 'owner' },
        { personId: dupe.id, role: 'with' },
      ],
    })
    const series = await createSeries(db, {
      contextId: world.parish.id,
      name: 'Check-in',
      personIds: [world.sarah.id, dupe.id],
    })
    const meeting = await createMeeting(db, actor, { contextId: world.parish.id, personIds: [dupe.id] })

    await mergePeople(db, dupe.id, world.sarah.id)

    await expect(getPerson(db, dupe.id)).rejects.toThrow()
    const sarah = await getPerson(db, world.sarah.id)
    expect(sarah).toMatchObject({ name: 'Sarah Jones', email: 'sarah@example.test' })
    expect(sarah.emails).toEqual(['sarah@example.test', 'sj@home.test'])

    expect((await getItem(db, hers.id)).parties).toMatchObject([{ id: world.sarah.id, role: 'owner' }])
    expect((await getItem(db, both.id)).parties).toMatchObject([{ id: world.sarah.id, role: 'owner' }])
    expect((await getSeries(db, series.id)).people.map((one) => one.id)).toEqual([world.sarah.id])
    expect((await getMeeting(db, meeting.id)).people.map((one) => one.id)).toEqual([world.sarah.id])
    expect((await listMembers(db, council.id)).map((one) => one.id)).toEqual([world.sarah.id])
    expect((await listMembers(db, world.staff.id)).filter((one) => one.id === world.sarah.id)).toHaveLength(1)
  })

  it('never folds John away, or someone into themselves', async () => {
    const world = await makeWorld()
    await expect(mergePeople(db, world.john.id, world.sarah.id)).rejects.toThrow(/merge the other one into you/)
    await expect(mergePeople(db, world.sarah.id, world.sarah.id)).rejects.toThrow(/someone else/)
    // A duplicate of John folds into him.
    const me = await createPerson(db, { name: 'John F.' })
    await mergePeople(db, me.id, world.john.id)
    expect(await getPerson(db, world.john.id)).toMatchObject({ isSelf: true, name: 'John' })
  })
})

describe('merging two groups', () => {
  it('unites members, addresses, items and rosters under the one kept', async () => {
    const world = await makeWorld()
    const dupe = await createGroup(db, { contextId: world.parish.id, name: 'Parish staff' })
    await addMember(db, dupe.id, world.sarah.id)
    await addMember(db, dupe.id, world.bishop.id)
    await addGroupEmail(db, dupe.id, 'staff@parish.test')
    const item = await createItem(db, actor, {
      contextId: world.parish.id,
      text: 'Rota',
      parties: [{ groupId: dupe.id, role: 'with' }],
    })
    const series = await createSeries(db, {
      contextId: world.parish.id,
      name: 'Staff meeting',
      groupIds: [dupe.id, world.staff.id],
    })

    await mergeGroups(db, dupe.id, world.staff.id)

    await expect(getGroup(db, dupe.id)).rejects.toThrow()
    expect((await getGroup(db, world.staff.id)).name).toBe('Staff')
    expect((await listMembers(db, world.staff.id)).map((one) => one.name).sort()).toEqual([
      'Bishop Wright',
      'Sarah Jones',
      'Tom Baker',
    ])
    expect(await listGroupEmails(db, world.staff.id)).toEqual(['staff@parish.test'])
    expect((await getItem(db, item.id)).parties).toMatchObject([{ id: world.staff.id, role: 'with' }])
    expect((await getSeries(db, series.id)).groups.map((one) => one.id)).toEqual([world.staff.id])
  })

  it('merges only within one context', async () => {
    const world = await makeWorld()
    await expect(mergeGroups(db, world.council.id, world.staff.id)).rejects.toThrow(/one context/)
  })
})
