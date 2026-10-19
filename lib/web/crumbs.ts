/*
 * The crumbs a page builds from its `from` (`from.ts`): the section, then the
 * name of the page it was opened from, looked up within the context of the
 * page showing them.
 */

import { NotFoundError, type Executor } from '../core/types'
import { getGroup } from '../directory/groups'
import { getPerson } from '../directory/people'
import { getItem } from '../items/items'
import { getMeeting } from '../meetings/meetings'
import { getSeries } from '../meetings/series'
import { getProject } from '../projects/projects'
import { parseFrom, type Crumb, type HubKind } from './from'

const SECTION_OF: Record<HubKind, Crumb> = {
  items: { href: '/items', label: 'Items' },
  meetings: { href: '/meetings', label: 'Meetings' },
  people: { href: '/people', label: 'People' },
  groups: { href: '/groups', label: 'Groups' },
  projects: { href: '/projects', label: 'Projects' },
  series: { href: '/series', label: 'Series' },
}

/* A meeting's crumbs: Meetings, its parent meeting if it is a session, then itself. */
async function meetingCrumbs(exec: Executor, id: string, contextId: string): Promise<Crumb[] | null> {
  const meeting = await getMeeting(exec, id)
  if (meeting.contextId !== contextId) return null
  const parent = meeting.parentMeetingId ? await getMeeting(exec, meeting.parentMeetingId) : null
  return [
    SECTION_OF.meetings,
    ...(parent ? [{ href: `/meetings/${parent.id}`, label: parent.title }] : []),
    { href: `/meetings/${meeting.id}`, label: meeting.title },
  ]
}

/* The name of a hub, if it is still there and in this context (people are in every context). */
async function hubName(exec: Executor, kind: HubKind, id: string, contextId: string): Promise<string | null> {
  switch (kind) {
    case 'people':
      return (await getPerson(exec, id)).name
    case 'groups': {
      const group = await getGroup(exec, id)
      return group.contextId === contextId ? group.name : null
    }
    case 'projects': {
      const project = await getProject(exec, id)
      return project.contextId === contextId ? project.name : null
    }
    case 'series': {
      const series = await getSeries(exec, id)
      return series.contextId === contextId ? series.name : null
    }
    case 'items': {
      const item = await getItem(exec, id)
      return item.contextId === contextId ? item.text : null
    }
    case 'meetings':
      return null
  }
}

/**
 * The crumbs back to the page named by `from`, looked up within `contextId`
 * (the context of the page showing them). Null when there is no `from`, or it
 * names a page that is gone or in another context: the page then shows where
 * it lives instead.
 */
export async function crumbsFrom(
  exec: Executor,
  raw: string | string[] | null | undefined,
  contextId: string,
): Promise<Crumb[] | null> {
  const from = parseFrom(raw)
  if (!from) return null
  if (from.type === 'section') return [{ href: from.path, label: from.label }]
  try {
    if (from.type === 'meetingPage') {
      const crumbs = await meetingCrumbs(exec, from.id, contextId)
      if (!crumbs) return null
      return [...crumbs, { href: from.path, label: from.page === 'recap' ? 'Recap' : 'Review' }]
    }
    if (from.kind === 'meetings') return await meetingCrumbs(exec, from.id, contextId)
    const name = await hubName(exec, from.kind, from.id, contextId)
    return name === null ? null : [SECTION_OF[from.kind], { href: from.path, label: name }]
  } catch (err) {
    // Gone since the link was made.
    if (err instanceof NotFoundError) return null
    throw err
  }
}
