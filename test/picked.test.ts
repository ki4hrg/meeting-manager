import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createContext } from '../lib/directory/contexts'
import { createGroup } from '../lib/directory/groups'
import { createPerson } from '../lib/directory/people'
import { groups, people } from '../lib/db/schema'
import { pickedParties, pickedPeople } from '../lib/web/action'
import { db, resetBetweenTests } from './helpers/db'

resetBetweenTests()

/* A picker's form: its chips under `name`, what is left in the box, and whether it offers new names. */
function form(name: string, chips: string[], typed = '', offersNew = false): FormData {
  const data = new FormData()
  for (const chip of chips) data.append(name, chip)
  if (typed) data.set(`${name}Text`, typed)
  if (offersNew) data.set(`${name}New`, 'person,group')
  return data
}

describe('what a party picker submits', () => {
  it('makes a new person and a new group from their chips, the group in the context given', async () => {
    const parish = await createContext(db, { name: 'Parish' })
    const picked = await pickedParties(
      db,
      form('party', ['new-person:Sarah Jones', 'new-group:Vestry']),
      'party',
      parish.id,
    )

    expect(picked.people).toHaveLength(1)
    expect(picked.groups).toHaveLength(1)
    const [sarah] = await db.select().from(people).where(eq(people.id, picked.people[0]!))
    expect(sarah?.name).toBe('Sarah Jones')
    const [vestry] = await db.select().from(groups).where(eq(groups.id, picked.groups[0]!))
    expect(vestry).toMatchObject({ name: 'Vestry', contextId: parish.id })
  })

  it('still reads the older new: as a person', async () => {
    const [id] = await pickedPeople(db, form('people', ['new:Tom Baker']), 'people')
    const [tom] = await db.select().from(people).where(eq(people.id, id!))
    expect(tom?.name).toBe('Tom Baker')
  })

  it('refuses a new name already taken, and makes nothing', async () => {
    const parish = await createContext(db, { name: 'Parish' })
    await createPerson(db, { name: 'Sarah Jones' })
    await createGroup(db, { contextId: parish.id, name: 'Vestry' })

    await expect(
      pickedParties(db, form('party', ['new-person:sarah jones']), 'party', parish.id),
    ).rejects.toThrow('There is already a person called sarah jones')
    await expect(pickedParties(db, form('party', ['new-group:Vestry']), 'party', parish.id)).rejects.toThrow(
      /Vestry/,
    )
    expect(await db.select().from(people)).toHaveLength(1)
    expect(await db.select().from(groups)).toHaveLength(1)
  })

  it('takes no group where only people go', async () => {
    const parish = await createContext(db, { name: 'Parish' })
    const vestry = await createGroup(db, { contextId: parish.id, name: 'Vestry' })
    await expect(pickedPeople(db, form('people', ['new-group:Choir']), 'people')).rejects.toThrow('Pick a person.')
    await expect(pickedPeople(db, form('people', [`group:${vestry.id}`]), 'people')).rejects.toThrow('Pick a person.')
  })

  it('finds a typed name, a group among them, and makes a new person of one nobody has when the picker offers new', async () => {
    const parish = await createContext(db, { name: 'Parish' })
    const sarah = await createPerson(db, { name: 'Sarah Jones' })
    const vestry = await createGroup(db, { contextId: parish.id, name: 'Vestry' })

    const picked = await pickedParties(db, form('party', [], 'sarah, vestry, Neil Carter', true), 'party', parish.id)
    expect(picked.groups).toEqual([vestry.id])
    expect(picked.people).toHaveLength(2)
    expect(picked.people[0]).toBe(sarah.id)
    const [neil] = await db.select().from(people).where(eq(people.id, picked.people[1]!))
    expect(neil?.name).toBe('Neil Carter')
  })

  it('refuses a typed name nobody has when the picker does not offer new, and an ambiguous one always', async () => {
    const parish = await createContext(db, { name: 'Parish' })
    await createPerson(db, { name: 'Sarah Jones' })
    await createPerson(db, { name: 'Sarah Smith' })

    await expect(pickedParties(db, form('party', [], 'Neil'), 'party', parish.id)).rejects.toThrow(
      'No person or group matches Neil.',
    )
    await expect(pickedParties(db, form('party', [], 'Sarah', true), 'party', parish.id)).rejects.toThrow(
      /could be Sarah Jones, Sarah Smith/,
    )
    expect(await db.select().from(people)).toHaveLength(2)
  })
})
