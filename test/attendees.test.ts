/* Unknown attendees: offered at review, named or waved away, never added unasked. */

import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { meetingPeople, personEmails } from '../lib/db/schema'
import { createMeeting } from '../lib/meetings/meetings'
import { dismissAttendee, nameAttendee, unknownAttendees } from '../lib/notes/attendees'
import { saveNote } from '../lib/notes/notes'
import { db, resetBetweenTests } from './helpers/db'
import { actor, makeWorld } from './helpers/fixtures'

resetBetweenTests()

describe('people a note names who are not in the directory', () => {
  async function setup() {
    const w = await makeWorld()
    const meeting = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Drop-in', personIds: [] })
    const sarah = (await db.select().from(personEmails).where(eq(personEmails.personId, w.sarah.id)))[0]
    await saveNote(db, actor, {
      meetingId: meeting.id,
      source: 'granola',
      externalId: 'not_1',
      body: 'D: go ahead',
      attendees: [
        ...(sarah ? [{ email: sarah.email, name: 'Sarah' }] : []),
        { email: 'priya@example.test', name: 'Priya Shah' },
        { email: 'new.face@example.test', name: null },
      ],
    })
    return { w, meeting }
  }
  const on = async (meetingId: string) =>
    (await db.select().from(meetingPeople).where(eq(meetingPeople.meetingId, meetingId))).map((row) => row.personId)

  it('offers only the addresses nobody in the directory has', async () => {
    const { meeting } = await setup()
    expect(await unknownAttendees(db, meeting.id)).toEqual([
      { email: 'priya@example.test', name: 'Priya Shah' },
      { email: 'new.face@example.test', name: null },
    ])
  })

  it('makes a new person with the address and puts them on the meeting', async () => {
    const { meeting } = await setup()
    const person = await nameAttendee(db, actor, meeting.id, 'Priya@Example.test', { name: 'Priya Shah' })
    expect(person).toMatchObject({ name: 'Priya Shah', email: 'priya@example.test' })
    expect(await on(meeting.id)).toEqual([person.id])
    expect((await unknownAttendees(db, meeting.id)).map((one) => one.email)).toEqual(['new.face@example.test'])
  })

  it('gives the address to someone already known, keeping their primary', async () => {
    const { w, meeting } = await setup()
    const before = (await db.select().from(personEmails).where(eq(personEmails.personId, w.tom.id))).length
    await nameAttendee(db, actor, meeting.id, 'new.face@example.test', { personId: w.tom.id })
    const emails = await db.select().from(personEmails).where(eq(personEmails.personId, w.tom.id))
    expect(emails).toHaveLength(before + 1)
    expect(emails.find((row) => row.email === 'new.face@example.test')?.isPrimary).toBe(before === 0)
    expect(await on(meeting.id)).toEqual([w.tom.id])
  })

  it('refuses an address the note does not offer', async () => {
    const { w, meeting } = await setup()
    await expect(
      nameAttendee(db, actor, meeting.id, 'stranger@example.test', { personId: w.tom.id }),
    ).rejects.toThrow(/no longer waiting/)
    expect(await on(meeting.id)).toEqual([])
  })

  it('does not bring back someone dismissed when the note is delivered again', async () => {
    const { meeting } = await setup()
    await dismissAttendee(db, meeting.id, 'priya@example.test')
    await saveNote(db, actor, {
      meetingId: meeting.id,
      source: 'granola',
      externalId: 'not_1',
      body: 'D: go ahead\nD: and again',
      attendees: [{ email: 'priya@example.test', name: 'Priya Shah' }],
    })
    expect((await unknownAttendees(db, meeting.id)).map((one) => one.email)).toEqual(['new.face@example.test'])
  })
})
