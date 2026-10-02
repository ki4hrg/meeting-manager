/*
 * People a note names who are not in the directory (docs/SPEC.md, "Drop-ins":
 * the review asks for people first).
 *
 * Granola says who was there by address. The ones the directory knows are put
 * on the meeting when the note is filed; the rest wait here, on the note, until
 * John says who each is. Nobody is added to the directory without him.
 *
 * "Unknown" is worked out, not stored: an address stops being offered the
 * moment anyone in the directory has it, on every meeting at once.
 */

import { eq, inArray, sql } from 'drizzle-orm'
import { ValidationError, inTransaction, type ActorContext, type Executor } from '../core/types'
import { meetingPeople, notes, personEmails, type NoteAttendee } from '../db/schema'
import { addPersonEmail, createPerson, getPerson, type Person } from '../directory/people'

/** Who this meeting's notes name that the directory does not have, in the order given. */
export async function unknownAttendees(exec: Executor, meetingId: string): Promise<NoteAttendee[]> {
  const rows = await exec
    .select({ attendees: notes.attendees })
    .from(notes)
    .where(eq(notes.meetingId, meetingId))
    .orderBy(notes.createdAt)

  const named = new Map<string, NoteAttendee>()
  for (const attendee of rows.flatMap((row) => row.attendees)) {
    const email = attendee.email.toLowerCase()
    const held = named.get(email)
    if (!held) named.set(email, { email, name: attendee.name })
    else if (!held.name && attendee.name) held.name = attendee.name
  }
  if (named.size === 0) return []

  const known = await exec
    .select({ email: sql<string>`lower(${personEmails.email})` })
    .from(personEmails)
    .where(inArray(sql`lower(${personEmails.email})`, [...named.keys()]))
  for (const row of known) named.delete(row.email)
  return [...named.values()]
}

async function offered(exec: Executor, meetingId: string, email: string): Promise<NoteAttendee> {
  const wanted = email.trim().toLowerCase()
  const found = (await unknownAttendees(exec, meetingId)).find((one) => one.email === wanted)
  if (!found) throw new ValidationError('That address is no longer waiting to be named.')
  return found
}

/**
 * Say who an unknown attendee is: someone already in the directory, who gains
 * the address, or a new person by the given name. Either way they are put on
 * the meeting, unless it is John, who is at every meeting and a row on none.
 */
export async function nameAttendee(
  exec: Executor,
  _actor: ActorContext,
  meetingId: string,
  email: string,
  who: { personId: string } | { name: string },
): Promise<Person> {
  return inTransaction(exec, async (tx) => {
    const attendee = await offered(tx, meetingId, email)

    let person: Person
    if ('personId' in who) {
      person = await getPerson(tx, who.personId)
      await addPersonEmail(tx, person.id, attendee.email)
    } else {
      person = await createPerson(tx, { name: who.name, email: attendee.email })
    }

    if (!person.isSelf) {
      await tx.insert(meetingPeople).values({ meetingId, personId: person.id }).onConflictDoNothing()
    }
    return person
  })
}

/** Not someone to keep: the address is taken off this meeting's notes and not offered again. */
export async function dismissAttendee(exec: Executor, meetingId: string, email: string): Promise<void> {
  const wanted = email.trim().toLowerCase()
  await inTransaction(exec, async (tx) => {
    const rows = await tx
      .select({ id: notes.id, attendees: notes.attendees })
      .from(notes)
      .where(eq(notes.meetingId, meetingId))
    for (const row of rows) {
      const left = row.attendees.filter((one) => one.email.toLowerCase() !== wanted)
      if (left.length !== row.attendees.length) {
        await tx.update(notes).set({ attendees: left }).where(eq(notes.id, row.id))
      }
    }
  })
}
