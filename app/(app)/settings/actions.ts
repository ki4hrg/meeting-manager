'use server'

import { after } from 'next/server'
import { clearFeedCache } from '@/lib/calendar/feed'
import {
  bindCalendar,
  deleteConnection,
  listBindings,
  unbindCalendar,
} from '@/lib/connect/connections'
import {
  bindFolder,
  connectGranola,
  disconnectGranola,
  unbindFolder,
} from '@/lib/connect/granola/connection'
import {
  bindTodoistProject,
  disconnectTodoist,
  unbindTodoistProject,
} from '@/lib/connect/todoist/connection'
import { linkItem, sendItem, skipItem } from '@/lib/connect/todoist/match'
import { setTimeZone } from '@/lib/auth/users'
import { ValidationError } from '@/lib/core/types'
import { db } from '@/lib/db'
import { GRANOLA_RECONCILE, kick } from '@/lib/jobs'
import { act, field, type ActionResult } from '@/lib/web/action'
import { parsePlace } from './places'

/* Each of these changes what the calendar feed should say, and the feed keeps
   what it fetched for a couple of minutes: it is told to forget. */

export async function disconnectAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    await deleteConnection(db, field(formData, 'connectionId'))
    clearFeedCache()
  })
}

/**
 * Feed a calendar into the chosen context, or one project, series or group of
 * it (`<context>:<kind>:<id>`); with nothing chosen, into none.
 */
export async function setCalendarContextAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    const connectionId = field(formData, 'connectionId')
    const calendarId = field(formData, 'calendarId')
    const place = parsePlace(field(formData, 'contextId'))

    if (place) {
      await bindCalendar(db, { connectionId, calendarId, name: field(formData, 'name'), ...place })
    } else {
      const bound = (await listBindings(db)).find(
        (binding) => binding.connectionId === connectionId && binding.externalId === calendarId,
      )
      if (bound) await unbindCalendar(db, bound.id)
    }
    clearFeedCache()
  })
}

/* "Today", every date shown and every date sent out follow it; the feed
   caches times laid out on the old clock. */
export async function setTimeZoneAction(formData: FormData): Promise<ActionResult> {
  return act(async (_actor, user) => {
    await setTimeZone(db, user.id, field(formData, 'timeZone') || null)
    clearFeedCache()
  })
}

// ─── Granola ─────────────────────────────────────────────────────────────────

/* Once the response has gone: what is already waiting in a folder that was
   just bound should not take until the job's next tick to arrive. */
function reconcileSoon() {
  after(async () => {
    await kick(GRANOLA_RECONCILE)
  })
}

export async function connectGranolaAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    await connectGranola(db, field(formData, 'apiKey'))
  })
}

export async function disconnectGranolaAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    await disconnectGranola(db, field(formData, 'connectionId'))
  })
}

/**
 * Feed a folder into the chosen context, or one project, series or group of
 * it (`<context>:<kind>:<id>`); with nothing chosen, into none.
 */
export async function setFolderContextAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    const connectionId = field(formData, 'connectionId')
    const folderId = field(formData, 'folderId')
    const place = parsePlace(field(formData, 'contextId'))

    if (place) {
      await bindFolder(db, { connectionId, folderId, name: field(formData, 'name'), ...place })
      reconcileSoon()
    } else {
      await unbindFolder(db, { connectionId, folderId })
    }
  })
}

// ─── Todoist ─────────────────────────────────────────────────────────────────

export async function disconnectTodoistAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    await disconnectTodoist(db, field(formData, 'connectionId'))
  })
}

/**
 * Send a context's tasks, or one project's (`<context>:project:<id>`), to a
 * Todoist project; with nothing chosen, none.
 */
export async function setTodoistProjectAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    const connectionId = field(formData, 'connectionId')
    const todoistProjectId = field(formData, 'todoistProjectId')
    const place = parsePlace(field(formData, 'place'))

    if (!place) {
      await unbindTodoistProject(db, { connectionId, todoistProjectId })
      return
    }
    if (place.scope && place.scope.kind !== 'project') {
      throw new ValidationError('A Todoist project takes a context or one of its projects.')
    }
    await bindTodoistProject(db, {
      connectionId,
      todoistProjectId,
      name: field(formData, 'name'),
      contextId: place.contextId,
      projectId: place.scope?.id ?? null,
    })
  })
}

/** Link an item to a task John already has in Todoist. */
export async function linkTodoistAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    await linkItem(db, { itemId: field(formData, 'itemId'), task: field(formData, 'task') })
  })
}

/** Make a new task for the item on the next pass. */
export async function sendTodoistAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    await sendItem(db, field(formData, 'itemId'))
  })
}

/** Keep the item out of Todoist. */
export async function skipTodoistAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    await skipItem(db, field(formData, 'itemId'))
  })
}
