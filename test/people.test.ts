import { describe, expect, it } from 'vitest'
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
