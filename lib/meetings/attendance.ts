/*
 * Who was at a meeting (docs/SPEC.md, "Groups among a meeting's attendees").
 *
 * Until a meeting's attendance is settled, each of its groups stands for its
 * members as they are now: someone who joins the group is at the next
 * meeting. Settling copies who was there onto the meeting (meeting_people) and
 * stamps `attendance_at`; from then on a change to a group does not rewrite
 * who was there.
 *
 * It is settled by the roll call, taken on the meeting's page while it is
 * under way. If no one takes it, the first look at the meeting after its end
 * (opening it, its review or recap, or processing its notes) settles it as it
 * stands. The review can still correct it until a proposal is accepted.
 */

import { and, eq, inArray } from 'drizzle-orm'
import { ValidationError, inTransaction, type Executor } from '../core/types'
import { groupMembers, meetingAbsences, meetingPeople, meetings, people, proposals } from '../db/schema'
import { notDeleted } from '../db/shelf'
import { getMeeting, isOver, type MeetingView } from './meetings'

export type RollCallEntry = {
  id: string
  name: string
  /** At it, as things stand. */
  present: boolean
  /** On it by name, or brought by one of its groups. */
  via: 'person' | 'group'
}

/**
 * Everyone expected at a meeting, each marked present or out: its people, and
 * its groups' members (live until settled), with who was left off it alone.
 */
export async function rollCall(exec: Executor, meetingId: string): Promise<RollCallEntry[]> {
  const meeting = await getMeeting(exec, meetingId)
  const present = new Set(meeting.attendees.map((person) => person.id))
  const own = new Set(meeting.people.map((person) => person.id))
  const entries = new Map<string, RollCallEntry>()
  for (const person of meeting.attendees) {
    entries.set(person.id, { ...person, present: true, via: own.has(person.id) ? 'person' : 'group' })
  }

  const groupIds = meeting.groups.map((group) => group.id)
  const members =
    groupIds.length === 0 || meeting.attendanceAt
      ? []
      : await exec
          .select({ id: people.id, name: people.name, isSelf: people.isSelf })
          .from(groupMembers)
          .innerJoin(people, eq(people.id, groupMembers.personId))
          .where(and(inArray(groupMembers.groupId, groupIds), notDeleted(people)))
  const absent = await exec
    .select({ id: people.id, name: people.name, isSelf: people.isSelf })
    .from(meetingAbsences)
    .innerJoin(people, eq(people.id, meetingAbsences.personId))
    .where(and(eq(meetingAbsences.meetingId, meetingId), notDeleted(people)))
  for (const person of [...members, ...absent]) {
    if (person.isSelf || entries.has(person.id)) continue
    entries.set(person.id, { id: person.id, name: person.name, present: present.has(person.id), via: 'group' })
  }
  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Settle who was at a meeting: these people, and no one else. Whoever was
 * expected and is not among them is remembered as out. May be taken again to
 * correct it, until a proposal from its notes is accepted.
 */
export async function settleAttendance(
  exec: Executor,
  meetingId: string,
  presentIds: string[],
  now: Date = new Date(),
): Promise<MeetingView> {
  return inTransaction(exec, async (tx) => {
    if (await attendanceLocked(tx, meetingId)) {
      throw new ValidationError('What came of this meeting has been accepted, so who was there stays as it is.')
    }
    const expected = await rollCall(tx, meetingId)
    const rows = presentIds.length
      ? await tx
          .select({ id: people.id, isSelf: people.isSelf })
          .from(people)
          .where(and(inArray(people.id, [...new Set(presentIds)]), notDeleted(people)))
      : []
    const here = rows.filter((row) => !row.isSelf).map((row) => row.id)
    const out = expected.filter((entry) => !here.includes(entry.id)).map((entry) => entry.id)

    await tx.delete(meetingPeople).where(eq(meetingPeople.meetingId, meetingId))
    if (here.length > 0) await tx.insert(meetingPeople).values(here.map((personId) => ({ meetingId, personId })))
    await tx.delete(meetingAbsences).where(eq(meetingAbsences.meetingId, meetingId))
    if (out.length > 0) await tx.insert(meetingAbsences).values(out.map((personId) => ({ meetingId, personId })))
    await tx.update(meetings).set({ attendanceAt: now, updatedAt: now }).where(eq(meetings.id, meetingId))
    return getMeeting(tx, meetingId)
  })
}

/** The meeting's people, added to: for someone who turned up, or a note's attendee. */
export async function addAttendees(exec: Executor, meetingId: string, personIds: string[]): Promise<void> {
  const ids = [...new Set(personIds)]
  if (ids.length === 0) return
  const rows = await exec
    .select({ id: people.id, isSelf: people.isSelf })
    .from(people)
    .where(and(inArray(people.id, ids), notDeleted(people)))
  const adding = rows.filter((row) => !row.isSelf).map((row) => row.id)
  if (adding.length === 0) return
  await exec
    .insert(meetingPeople)
    .values(adding.map((personId) => ({ meetingId, personId })))
    .onConflictDoNothing()
  await exec
    .delete(meetingAbsences)
    .where(and(eq(meetingAbsences.meetingId, meetingId), inArray(meetingAbsences.personId, adding)))
}

/**
 * The first look after a meeting's end settles its attendance as it stands,
 * if no roll call did. Returns whether it settled it now.
 */
export async function settleIfOver(exec: Executor, meetingId: string, now: Date = new Date()): Promise<boolean> {
  const meeting = await getMeeting(exec, meetingId)
  if (meeting.attendanceAt || !isOver(meeting, now)) return false
  await settleAttendance(
    exec,
    meetingId,
    meeting.attendees.map((person) => person.id),
    now,
  )
  return true
}

/** Whether who was there can no longer change: a proposal from its notes was accepted. */
export async function attendanceLocked(exec: Executor, meetingId: string): Promise<boolean> {
  const [accepted] = await exec
    .select({ id: proposals.id })
    .from(proposals)
    .where(and(eq(proposals.meetingId, meetingId), eq(proposals.status, 'accepted')))
    .limit(1)
  return !!accepted
}
