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

import { and, eq, inArray, notInArray, sql } from 'drizzle-orm'
import { ValidationError, inTransaction, type ActorContext, type Executor } from '../core/types'
import {
  groupMembers,
  meetingAbsences,
  meetingGroups,
  meetingPeople,
  meetings,
  notes,
  people,
  personEmails,
  type NoteAttendee,
} from '../db/schema'
import { notDeleted } from '../db/shelf'
import { addGroupEmail, allGroupEmails, getGroup } from '../directory/groups'
import { addPersonEmail, createPerson, getPerson, type Person } from '../directory/people'
import { linkAttendees } from '../processing/proposals'

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
    .innerJoin(people, eq(people.id, personEmails.personId))
    .where(and(inArray(sql`lower(${personEmails.email})`, [...named.keys()]), notDeleted(people)))
  for (const row of known) named.delete(row.email)
  // A group's list address is known too: it brought the group.
  const lists = await allGroupEmails(exec)
  for (const email of [...named.keys()]) if (lists.has(email)) named.delete(email)
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
      await linkAttendees(tx, meetingId)
    }
    return person
  })
}

/**
 * An unknown attendee was a group's list: the group takes the address and
 * joins the meeting. Once attendance is settled a group no longer stands for
 * its members, so they are put on the meeting as brought by it, as settling
 * would have: not John, not whoever is on it already, and not anyone marked out.
 */
export async function attendeeIsGroup(
  exec: Executor,
  meetingId: string,
  email: string,
  groupId: string,
): Promise<void> {
  await inTransaction(exec, async (tx) => {
    const attendee = await offered(tx, meetingId, email)
    const group = await getGroup(tx, groupId)
    const [meeting] = await tx
      .select({ contextId: meetings.contextId, attendanceAt: meetings.attendanceAt })
      .from(meetings)
      .where(eq(meetings.id, meetingId))
    if (group.contextId !== meeting?.contextId) throw new ValidationError('That group belongs to another context.')
    await addGroupEmail(tx, groupId, attendee.email)
    await tx.insert(meetingGroups).values({ meetingId, groupId }).onConflictDoNothing()
    if (meeting.attendanceAt) {
      const out = tx.select({ id: meetingAbsences.personId }).from(meetingAbsences).where(eq(meetingAbsences.meetingId, meetingId))
      const members = await tx
        .select({ id: people.id })
        .from(groupMembers)
        .innerJoin(people, eq(people.id, groupMembers.personId))
        .where(and(eq(groupMembers.groupId, groupId), eq(people.isSelf, false), notDeleted(people), notInArray(people.id, out)))
      if (members.length > 0) {
        await tx
          .insert(meetingPeople)
          .values(members.map((member) => ({ meetingId, personId: member.id, groupId })))
          .onConflictDoNothing()
      }
    }
    await linkAttendees(tx, meetingId)
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
