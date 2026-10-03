/*
 * A series' roster on its meetings.
 *
 * The roster, groups and projects are copied onto a meeting when it is
 * prepped. A later change to them reaches the series' meetings that are not
 * over: at once for a meeting still as the old roster left it, and on request
 * (`syncRoster`) for one edited by hand, which only gains what it lacks. A
 * meeting remembers who was left off it alone (`meeting_absences`), so a
 * change to the roster never puts them back. Each meeting that changes has
 * its automatic placement run again, so what a new person is owed is placed
 * as it would have been at prep.
 */

import { and, eq, inArray } from 'drizzle-orm'
import { placeAutomatic } from '../agenda/candidates'
import type { ActorContext, Executor } from '../core/types'
import { meetingAbsences, meetingGroups, meetingPeople, meetingProjects } from '../db/schema'
import { getMeeting, isOver, listMeetings, type MeetingView } from './meetings'
import { getSeries, type SeriesView } from './series'

export type RosterState = { personIds: string[]; groupIds: string[]; projectIds: string[] }

export function rosterOf(view: SeriesView): RosterState {
  return {
    personIds: view.people.map((person) => person.id),
    groupIds: view.groups.map((group) => group.id),
    projectIds: view.projects.map((project) => project.id),
  }
}

const same = (a: Iterable<string>, b: Iterable<string>) => {
  const left = new Set(a)
  const right = new Set(b)
  return left.size === right.size && [...left].every((one) => right.has(one))
}

/** Who was left off this meeting alone. */
export async function absentFrom(exec: Executor, meetingId: string): Promise<Set<string>> {
  const rows = await exec
    .select({ personId: meetingAbsences.personId })
    .from(meetingAbsences)
    .where(eq(meetingAbsences.meetingId, meetingId))
  return new Set(rows.map((row) => row.personId))
}

/** A series' meetings that are not over, undated ones included. */
async function notOver(exec: Executor, seriesId: string, now: Date): Promise<MeetingView[]> {
  const series = await getSeries(exec, seriesId)
  const all = await listMeetings(exec, { contextId: series.contextId, seriesId, topLevelOnly: true, now })
  return all.filter((meeting) => !isOver(meeting, now))
}

async function setPeople(exec: Executor, meetingId: string, personIds: string[]) {
  await exec.delete(meetingPeople).where(eq(meetingPeople.meetingId, meetingId))
  if (personIds.length > 0) {
    await exec.insert(meetingPeople).values(personIds.map((personId) => ({ meetingId, personId })))
  }
}

async function addProjects(exec: Executor, meetingId: string, projectIds: string[]) {
  if (projectIds.length === 0) return
  await exec
    .insert(meetingProjects)
    .values(projectIds.map((projectId) => ({ meetingId, projectId })))
    .onConflictDoNothing()
}

async function setProjects(exec: Executor, meetingId: string, projectIds: string[]) {
  await exec.delete(meetingProjects).where(eq(meetingProjects.meetingId, meetingId))
  await addProjects(exec, meetingId, projectIds)
}

async function addGroups(exec: Executor, meetingId: string, groupIds: string[]) {
  if (groupIds.length === 0) return
  await exec
    .insert(meetingGroups)
    .values(groupIds.map((groupId) => ({ meetingId, groupId })))
    .onConflictDoNothing()
}

async function setGroups(exec: Executor, meetingId: string, groupIds: string[]) {
  await exec.delete(meetingGroups).where(eq(meetingGroups.meetingId, meetingId))
  await addGroups(exec, meetingId, groupIds)
}

/**
 * After a series' roster, group or projects changed from `before`: bring along
 * each meeting not yet over whose own list still matches what `before` gave it.
 * Returns the meetings changed.
 */
export async function carryRoster(
  exec: Executor,
  actor: ActorContext,
  seriesId: string,
  before: RosterState,
  now: Date = new Date(),
): Promise<string[]> {
  const after = rosterOf(await getSeries(exec, seriesId))
  const changed: string[] = []

  for (const meeting of await notOver(exec, seriesId, now)) {
    const absent = await absentFrom(exec, meeting.id)
    const present = (ids: string[]) => ids.filter((id) => !absent.has(id))
    let touched = false

    const people = meeting.people.map((person) => person.id)
    if (!same(people, present(after.personIds)) && same(people, present(before.personIds))) {
      await setPeople(exec, meeting.id, present(after.personIds))
      touched = true
    }
    const groups = meeting.groups.map((group) => group.id)
    if (!same(groups, after.groupIds) && same(groups, before.groupIds)) {
      await setGroups(exec, meeting.id, after.groupIds)
      touched = true
    }
    const projects = meeting.projects.map((project) => project.id)
    if (!same(projects, after.projectIds) && same(projects, before.projectIds)) {
      await setProjects(exec, meeting.id, after.projectIds)
      touched = true
    }

    if (touched) {
      await placeAutomatic(exec, actor, meeting.id, now)
      changed.push(meeting.id)
    }
  }
  return changed
}

/** Whether a meeting lacks something its series' roster would give it. */
function lacks(meeting: MeetingView, roster: RosterState, absent: Set<string>): boolean {
  const people = new Set(meeting.people.map((person) => person.id))
  const projects = new Set(meeting.projects.map((project) => project.id))
  const groups = new Set(meeting.groups.map((group) => group.id))
  return (
    roster.personIds.some((id) => !absent.has(id) && !people.has(id)) ||
    roster.projectIds.some((id) => !projects.has(id)) ||
    roster.groupIds.some((id) => !groups.has(id))
  )
}

/** The series' meetings not yet over that lack someone or something on its roster. */
export async function outOfStep(exec: Executor, seriesId: string, now: Date = new Date()): Promise<MeetingView[]> {
  const roster = rosterOf(await getSeries(exec, seriesId))
  const found: MeetingView[] = []
  for (const meeting of await notOver(exec, seriesId, now)) {
    if (lacks(meeting, roster, await absentFrom(exec, meeting.id))) found.push(meeting)
  }
  return found
}

/**
 * Give one meeting what its series' roster has and it lacks: the people (but
 * not those left off it alone), the projects, and the group when it has none.
 * Nothing is taken off. Returns whether anything changed.
 */
export async function joinRoster(
  exec: Executor,
  actor: ActorContext,
  meetingId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const meeting = await getMeeting(exec, meetingId)
  if (!meeting.series) return false
  const roster = rosterOf(await getSeries(exec, meeting.series.id))
  const absent = await absentFrom(exec, meeting.id)
  if (!lacks(meeting, roster, absent)) return false

  const people = new Set(meeting.people.map((person) => person.id))
  const adding = roster.personIds.filter((id) => !absent.has(id) && !people.has(id))
  if (adding.length > 0) {
    await exec
      .insert(meetingPeople)
      .values(adding.map((personId) => ({ meetingId, personId })))
      .onConflictDoNothing()
  }
  await addProjects(exec, meetingId, roster.projectIds)
  await addGroups(exec, meetingId, roster.groupIds)
  if (!isOver(meeting, now)) await placeAutomatic(exec, actor, meetingId, now)
  return true
}

/** `joinRoster` for every meeting out of step. Returns how many changed. */
export async function syncRoster(
  exec: Executor,
  actor: ActorContext,
  seriesId: string,
  now: Date = new Date(),
): Promise<number> {
  let count = 0
  for (const meeting of await outOfStep(exec, seriesId, now)) {
    if (await joinRoster(exec, actor, meeting.id, now)) count++
  }
  return count
}

/**
 * After a meeting's people were set by hand: whoever on its series' roster is
 * not among them is remembered as left off this meeting, and whoever is, is
 * not. Who was marked out of one of its groups (the roll call) is left as it
 * is. A meeting with no series remembers nothing more.
 */
export async function recordAbsences(exec: Executor, meetingId: string): Promise<void> {
  const meeting = await getMeeting(exec, meetingId)
  if (!meeting.series) return
  const roster = rosterOf(await getSeries(exec, meeting.series.id)).personIds
  if (roster.length === 0) return
  const present = new Set(meeting.people.map((person) => person.id))
  await exec
    .delete(meetingAbsences)
    .where(and(eq(meetingAbsences.meetingId, meetingId), inArray(meetingAbsences.personId, roster)))
  const missing = roster.filter((id) => !present.has(id))
  if (missing.length > 0) {
    await exec
      .insert(meetingAbsences)
      .values(missing.map((personId) => ({ meetingId, personId })))
      .onConflictDoNothing()
  }
}

/** Forget every absence on these meetings (they left the series). */
export async function clearAbsences(exec: Executor, meetingIds: string[]): Promise<void> {
  if (meetingIds.length === 0) return
  await exec.delete(meetingAbsences).where(inArray(meetingAbsences.meetingId, meetingIds))
}
