/*
 * Who was at a meeting (docs/SPEC.md, "Groups among a meeting's attendees" and
 * "Attendance is John's to say").
 *
 * A meeting has a list: who is invited or expected, each either said to be
 * here, marked out, or not yet said. Nothing says someone was there but John:
 * an invite, a group or a list address only puts people on the list. The roll
 * call says who was there, at any time, as often as he likes.
 *
 * Until the list is copied, each of a meeting's groups stands for its members
 * as they are now: someone who joins the group is at the next meeting. The
 * first roll call, or the first look after the meeting ends (opening it, its
 * review or recap, or processing its notes), copies the members onto the
 * meeting (meeting_people) and stamps `attendance_at`; from then on a change
 * to a group does not rewrite who was on it. Copying confirms no one.
 */

import { and, eq, inArray } from 'drizzle-orm'
import { inTransaction, type Executor } from '../core/types'
import { meetingAbsences, meetingPeople, meetings, people } from '../db/schema'
import { notDeleted } from '../db/shelf'
import { linkAttendees } from '../processing/proposals'
import { copyMembers, getMeeting, isOver, type MeetingView } from './meetings'

/** Where someone stands at a meeting: here, out, or not yet said. */
export type Mark = 'here' | 'out' | null

export type RollCallEntry = {
  id: string
  name: string
  mark: Mark
  /** On it by name, or brought by one of its groups. */
  via: 'person' | 'group'
  /** The group that brought them; null for someone on it by name, or added. */
  groupId: string | null
}

/** Everyone on a meeting's list, each with their mark, in name order. */
export async function rollCall(exec: Executor, meetingId: string): Promise<RollCallEntry[]> {
  const meeting = await getMeeting(exec, meetingId)
  const entries: RollCallEntry[] = [
    ...meeting.attendees.map((person) => ({
      id: person.id,
      name: person.name,
      mark: person.here ? ('here' as const) : null,
      via: person.groupId ? ('group' as const) : ('person' as const),
      groupId: person.groupId,
    })),
    ...meeting.absent.map((person) => ({
      id: person.id,
      name: person.name,
      mark: 'out' as const,
      via: person.groupId ? ('group' as const) : ('person' as const),
      groupId: person.groupId,
    })),
  ]
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Take the roll: these were here, these were out, and anyone else on the list
 * is not yet said. Someone not on the list who is named here or as unsure
 * joins it by name. Those removed come off the list altogether: never
 * expected, rather than out. John is never a row.
 */
export async function takeRoll(
  exec: Executor,
  meetingId: string,
  marks: { here: string[]; out: string[]; unsure?: string[]; remove?: string[] },
  now: Date = new Date(),
): Promise<MeetingView> {
  return inTransaction(exec, async (tx) => {
    await copyList(tx, meetingId, now)
    const named = [...new Set([...marks.here, ...marks.out, ...(marks.unsure ?? [])])]
    const rows = named.length
      ? await tx
          .select({ id: people.id, isSelf: people.isSelf })
          .from(people)
          .where(and(inArray(people.id, named), notDeleted(people)))
      : []
    const removed = new Set(marks.remove ?? [])
    const real = new Set(rows.filter((row) => !row.isSelf && !removed.has(row.id)).map((row) => row.id))
    const here = new Set(marks.here.filter((id) => real.has(id)))
    const out = new Set(marks.out.filter((id) => real.has(id) && !here.has(id)))
    const unsure = (marks.unsure ?? []).filter((id) => real.has(id) && !here.has(id) && !out.has(id))

    const listed = await tx
      .select({ personId: meetingPeople.personId, groupId: meetingPeople.groupId })
      .from(meetingPeople)
      .where(eq(meetingPeople.meetingId, meetingId))
    // Someone marked out comes back under the group they would be shown in.
    const absent = (await getMeeting(tx, meetingId)).absent.map((one) => ({ personId: one.id, groupId: one.groupId }))
    const broughtBy = new Map([...absent, ...listed].map((row) => [row.personId, row.groupId]))
    // Whoever was on the list or marked out, and is now neither here nor out, is not yet said.
    const onList = [
      ...new Set([...listed.map((row) => row.personId), ...absent.map((row) => row.personId), ...here, ...unsure]),
    ].filter((id) => !out.has(id) && !removed.has(id))

    await tx.delete(meetingPeople).where(eq(meetingPeople.meetingId, meetingId))
    if (onList.length > 0) {
      await tx.insert(meetingPeople).values(
        onList.map((personId) => ({
          meetingId,
          personId,
          groupId: broughtBy.get(personId) ?? null,
          here: here.has(personId),
        })),
      )
    }
    await tx.delete(meetingAbsences).where(eq(meetingAbsences.meetingId, meetingId))
    if (out.size > 0) await tx.insert(meetingAbsences).values([...out].map((personId) => ({ meetingId, personId })))
    await linkAttendees(tx, meetingId)
    return getMeeting(tx, meetingId)
  })
}

/** Copy a meeting's groups' members onto it, once. Confirms no one. */
async function copyList(tx: Executor, meetingId: string, now: Date): Promise<void> {
  const meeting = await getMeeting(tx, meetingId)
  if (meeting.attendanceAt) return
  await copyMembers(
    tx,
    meetingId,
    meeting.groups.map((group) => group.id),
  )
  await tx.update(meetings).set({ attendanceAt: now, updatedAt: now }).where(eq(meetings.id, meetingId))
}

/** People who turned up, marked here: on the list by name if they were not on it. */
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
    .values(adding.map((personId) => ({ meetingId, personId, here: true })))
    .onConflictDoUpdate({ target: [meetingPeople.meetingId, meetingPeople.personId], set: { here: true } })
  await exec
    .delete(meetingAbsences)
    .where(and(eq(meetingAbsences.meetingId, meetingId), inArray(meetingAbsences.personId, adding)))
  await linkAttendees(exec, meetingId)
}

/**
 * The first look after a meeting's end copies its list, if no roll call did.
 * Returns whether it copied it now. No one is marked here or out by it.
 */
export async function copyListIfOver(exec: Executor, meetingId: string, now: Date = new Date()): Promise<boolean> {
  const meeting = await getMeeting(exec, meetingId)
  if (meeting.attendanceAt || !isOver(meeting, now)) return false
  await inTransaction(exec, async (tx) => {
    await copyList(tx, meetingId, now)
    await linkAttendees(tx, meetingId)
  })
  return true
}
