'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { ValidationError, inTransaction } from '@/lib/core/types'
import { db } from '@/lib/db'
import type { SkeletonSection } from '@/lib/db/schema'
import { getContext } from '@/lib/directory/contexts'
import { addGroupEmail } from '@/lib/directory/groups'
import { addPersonEmail, createPerson } from '@/lib/directory/people'
import { moveSeries } from '@/lib/meetings/move'
import { calendarLinkOf, linkSeriesCalendar, prepNextInSeries } from '@/lib/meetings/prep'
import { syncRoster } from '@/lib/meetings/roster'
import {
  createSeries,
  getSeries,
  setSeriesPeople,
  setSeriesProjects,
  skeletonFromOutline,
  updateSeries,
} from '@/lib/meetings/series'
import { act, field, pickedParties, type ActionResult } from '@/lib/web/action'
import { CONTEXT_COOKIE, contextCookieOptions, currentContext } from '@/lib/web/context'

const ids = (formData: FormData, name: string): string[] =>
  formData.getAll(name).map(String).filter(Boolean)

export async function createSeriesAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    const context = await currentContext()
    if (!context) throw new ValidationError('Create a context first.')
    const { people, groups } = await pickedParties(db, formData, 'personIds', context.id)
    await createSeries(db, {
      contextId: context.id,
      name: field(formData, 'name'),
      groupIds: groups,
      personIds: people,
      projectIds: ids(formData, 'projectIds'),
    })
  })
}

export async function updateSeriesAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    const id = field(formData, 'id')
    await updateSeries(db, id, { name: field(formData, 'name') })
    // Unlinking is a box ticked in Edit; linking picks one of the context's recurring events.
    if (formData.has('unlinkCalendar')) await updateSeries(db, id, { calendarSeriesId: null })
    const calendar = field(formData, 'calendarSeriesId')
    if (calendar) await linkSeriesCalendar(db, actor, id, calendar)
  })
}

/* Select the context a series lives in, then open it there. */
async function openIn(contextId: string, seriesId: string): Promise<never> {
  ;(await cookies()).set(CONTEXT_COOKIE, contextId, contextCookieOptions)
  redirect(`/series/${seriesId}`)
}

/**
 * Move a series, and its meetings that can move, to another context and follow
 * it there. The page is the same one, so there is no redirect: the cookie
 * switches and it is drawn again in the new context. Occurrences that had to
 * stay are counted in `notice`, since nothing on the series says so afterwards.
 */
export async function moveSeriesAction(
  formData: FormData,
): Promise<ActionResult & { notice?: string }> {
  let contextId = ''
  let notice: string | undefined
  const result = await act(async (actor) => {
    const to = field(formData, 'contextId')
    if (to === '') throw new ValidationError('Pick a context.')
    const before = await getSeries(db, field(formData, 'id'))
    const move = await moveSeries(db, actor, before.id, to)
    contextId = move.series.contextId
    if (move.stayed.length > 0) {
      const from = await getContext(db, before.contextId)
      notice = `${move.stayed.length} stayed in ${from.name}`
    }
  })
  if (result.error) return result
  ;(await cookies()).set(CONTEXT_COOKIE, contextId, contextCookieOptions)
  return { notice }
}

/** A series opened while another context is selected: switch to its own. */
export async function openSeriesAction(formData: FormData): Promise<ActionResult> {
  const id = field(formData, 'id')
  let contextId = ''
  const result = await act(async () => {
    contextId = (await getSeries(db, id)).contextId
  })
  if (result.error) return result
  return openIn(contextId, id)
}

// ─── roster and projects ─────────────────────────────────────────────────────

/* The next occurrence's invitees, as the feed has them now. */
async function invitees(seriesId: string) {
  const series = await getSeries(db, seriesId)
  const link = await calendarLinkOf(db, series)
  return { series, attendees: link?.next?.attendees ?? [] }
}

/** Add to the roster whoever is invited on the calendar and in the directory. */
export async function rosterFromCalendarAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    const { series, attendees } = await invitees(field(formData, 'id'))
    const known = attendees.flatMap((attendee) => (attendee.personId && !attendee.declined ? [attendee.personId] : []))
    await setSeriesPeople(db, series.id, [...series.people.map((person) => person.id), ...known])
  })
}

/** An invitee nobody in the directory has: a new person with that address, or someone known by another one. Either joins the roster. */
export async function rosterInviteeAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    const series = await getSeries(db, field(formData, 'id'))
    const email = field(formData, 'email')
    const existing = field(formData, 'personId')
    // A list address: the group takes it and joins the roster.
    if (existing.startsWith('group:')) {
      const groupId = existing.slice(6)
      await addGroupEmail(db, groupId, email)
      await updateSeries(db, series.id, { groupIds: [...series.groups.map((group) => group.id), groupId] })
      return
    }
    let personId: string
    if (existing) {
      await addPersonEmail(db, existing, email)
      personId = existing
    } else {
      personId = (await createPerson(db, { name: field(formData, 'name') || email, email })).id
    }
    await setSeriesPeople(db, series.id, [...series.people.map((person) => person.id), personId])
  })
}

export async function addSeriesPeopleAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    const series = await getSeries(db, field(formData, 'id'))
    const { people: adding, groups } = await pickedParties(db, formData, 'personIds', series.contextId)
    if (adding.length + groups.length === 0) throw new ValidationError('Pick a person or a group.')
    if (adding.length > 0) {
      await setSeriesPeople(db, series.id, [...series.people.map((person) => person.id), ...adding])
    }
    if (groups.length > 0) {
      await updateSeries(db, series.id, { groupIds: [...series.groups.map((group) => group.id), ...groups] })
    }
  })
}

export async function removeSeriesGroupAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    const series = await getSeries(db, field(formData, 'id'))
    const groupId = field(formData, 'groupId')
    await updateSeries(db, series.id, {
      groupIds: series.groups.map((group) => group.id).filter((id) => id !== groupId),
    })
  })
}

export async function removeSeriesPersonAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    const series = await getSeries(db, field(formData, 'id'))
    const personId = field(formData, 'personId')
    await setSeriesPeople(
      db,
      series.id,
      series.people.map((person) => person.id).filter((id) => id !== personId),
    )
  })
}

export async function addSeriesProjectsAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    const adding = ids(formData, 'projectIds')
    if (adding.length === 0) throw new ValidationError('Pick a project.')
    const series = await getSeries(db, field(formData, 'id'))
    await setSeriesProjects(db, series.id, [
      ...series.projects.map((project) => project.id),
      ...adding,
    ])
  })
}

export async function removeSeriesProjectAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    const series = await getSeries(db, field(formData, 'id'))
    const projectId = field(formData, 'projectId')
    await setSeriesProjects(
      db,
      series.id,
      series.projects.map((project) => project.id).filter((id) => id !== projectId),
    )
  })
}

// ─── skeleton and blocks ─────────────────────────────────────────────────────

/* The whole skeleton each time: it is small, and the editor is the only writer. */
export async function saveSkeletonAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    let skeleton: SkeletonSection[]
    try {
      skeleton = JSON.parse(field(formData, 'skeleton')) as SkeletonSection[]
    } catch {
      throw new ValidationError('That could not be saved. Reload the page and try again.')
    }
    // updateSeries checks its shape; nothing here is trusted for having parsed.
    await updateSeries(db, field(formData, 'id'), { skeleton })
  })
}

/**
 * Replace the skeleton with a pasted outline. The new skeleton goes back to
 * the editor, which is holding the old one.
 */
export async function pasteSkeletonAction(
  formData: FormData,
): Promise<ActionResult & { skeleton?: SkeletonSection[] }> {
  let skeleton: SkeletonSection[] | undefined
  const result = await act(async () => {
    const sections = skeletonFromOutline(field(formData, 'outline'))
    if (sections.length === 0) throw new ValidationError('Paste an outline.')
    skeleton = (await updateSeries(db, field(formData, 'id'), { skeleton: sections })).skeleton
  })
  return { ...result, skeleton }
}

const BLOCKS = ['followUps', 'sinceLast', 'lookahead'] as const

export async function setSeriesBlockAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    const block = field(formData, 'block') as (typeof BLOCKS)[number]
    if (!BLOCKS.includes(block)) throw new ValidationError('Unknown block.')
    const series = await getSeries(db, field(formData, 'id'))
    await updateSeries(db, series.id, {
      blocks: { ...series.blocks, [block]: field(formData, 'on') === 'true' },
    })
  })
}

// ─── meetings ────────────────────────────────────────────────────────────────

export async function prepNextInSeriesAction(formData: FormData): Promise<ActionResult> {
  let meetingId = ''
  const result = await act(async (actor) => {
    meetingId = (await prepNextInSeries(db, actor, field(formData, 'id'))).id
  })
  // On to the agenda that was just started.
  if (!result.error) redirect(`/meetings/${meetingId}`)
  return result
}

/** Give the series' upcoming meetings edited by hand what its roster has and they lack. */
export async function syncRosterAction(formData: FormData): Promise<ActionResult> {
  return act(async (actor) => {
    await inTransaction(db, (tx) => syncRoster(tx, actor, field(formData, 'id')))
  })
}
