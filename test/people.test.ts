import { describe, expect, it } from 'vitest'
import { archive } from '../lib/archive/archive'
import { createContext } from '../lib/directory/contexts'
import { addMember, createGroup, groupsOf } from '../lib/directory/groups'
import {
  addPersonEmail,
  createPerson,
  getPerson,
  makePrimaryEmail,
  removePersonEmail,
} from '../lib/directory/people'
import { db, resetBetweenTests } from './helpers/db'

resetBetweenTests()

describe('a person’s addresses', () => {
  it('adds, promotes and removes addresses, keeping one primary', async () => {
    const adlene = await createPerson(db, { name: 'Adlene', email: 'a@work.test' })
    await addPersonEmail(db, adlene.id, 'A@Home.test')
    expect((await getPerson(db, adlene.id)).emails).toEqual(['a@work.test', 'a@home.test'])

    await makePrimaryEmail(db, adlene.id, 'a@home.test')
    expect(await getPerson(db, adlene.id)).toMatchObject({ email: 'a@home.test', emails: ['a@home.test', 'a@work.test'] })

    // Taking the primary away hands it to what is left.
    await removePersonEmail(db, adlene.id, 'a@home.test')
    expect(await getPerson(db, adlene.id)).toMatchObject({ email: 'a@work.test', emails: ['a@work.test'] })

    await expect(makePrimaryEmail(db, adlene.id, 'a@home.test')).rejects.toThrow(/not theirs/)
  })

  it('refuses an address already on someone else, by name', async () => {
    await createPerson(db, { name: 'Sarah Jones', email: 'sarah@example.test' })
    const tom = await createPerson(db, { name: 'Tom' })
    await expect(addPersonEmail(db, tom.id, 'Sarah@example.test')).rejects.toThrow('belongs to Sarah Jones')
    await expect(createPerson(db, { name: 'Other', emails: ['sarah@example.test'] })).rejects.toThrow(
      'Sarah Jones',
    )
  })
})

describe('the groups a person is in', () => {
  it('lists the live ones in the context asked about, by name', async () => {
    const parish = await createContext(db, { name: 'Parish' })
    const school = await createContext(db, { name: 'School' })
    const sarah = await createPerson(db, { name: 'Sarah' })
    const vestry = await createGroup(db, { contextId: parish.id, name: 'Vestry' })
    const altar = await createGroup(db, { contextId: parish.id, name: 'altar guild' })
    const choir = await createGroup(db, { contextId: parish.id, name: 'Choir' })
    const board = await createGroup(db, { contextId: school.id, name: 'Board' })
    for (const group of [vestry, altar, choir, board]) await addMember(db, group.id, sarah.id)
    await archive(db, 'group', choir.id)

    expect(await groupsOf(db, parish.id, sarah.id)).toEqual([
      { id: altar.id, name: 'altar guild' },
      { id: vestry.id, name: 'Vestry' },
    ])
  })
})
