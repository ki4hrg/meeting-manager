'use server'

import { redirect } from 'next/navigation'
import { ValidationError } from '@/lib/core/types'
import { db } from '@/lib/db'
import type { SkeletonSection } from '@/lib/db/schema'
import { prepNextInSeries } from '@/lib/meetings/prep'
import {
  createSeries,
  deleteSeries,
  getSeries,
  setSeriesPeople,
  setSeriesProjects,
  skeletonFromOutline,
  updateSeries,
} from '@/lib/meetings/series'
import { act, field, type ActionResult } from '@/lib/web/action'
import { currentContext } from '@/lib/web/context'

const ids = (formData: FormData, name: string): string[] =>
  formData.getAll(name).map(String).filter(Boolean)

export async function createSeriesAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    const context = await currentContext()
    if (!context) throw new ValidationError('Create a context first.')
    await createSeries(db, {
      contextId: context.id,
      name: field(formData, 'name'),
      groupId: field(formData, 'groupId') || undefined,
      personIds: ids(formData, 'personIds'),
      projectIds: ids(formData, 'projectIds'),
    })
  })
}

export async function updateSeriesAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    await updateSeries(db, field(formData, 'id'), {
      name: field(formData, 'name'),
      groupId: field(formData, 'groupId') || null,
    })
  })
}

export async function deleteSeriesAction(formData: FormData): Promise<ActionResult> {
  const result = await act(async () => {
    await deleteSeries(db, field(formData, 'id'))
  })
  // The page it was called from is gone.
  if (!result.error) redirect('/series')
  return result
}

/* The series stays; it just stops being the home of a calendar's recurring event. */
export async function unlinkSeriesCalendarAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    await updateSeries(db, field(formData, 'id'), { calendarSeriesId: null })
  })
}

// ─── roster and projects ─────────────────────────────────────────────────────

export async function addSeriesPeopleAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    const adding = ids(formData, 'personIds')
    if (adding.length === 0) throw new ValidationError('Pick a person.')
    const series = await getSeries(db, field(formData, 'id'))
    await setSeriesPeople(db, series.id, [...series.people.map((person) => person.id), ...adding])
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
