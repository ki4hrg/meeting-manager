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
import { db } from '@/lib/db'
import { GRANOLA_RECONCILE, kick } from '@/lib/jobs'
import { act, field, type ActionResult } from '@/lib/web/action'

/* Each of these changes what the calendar feed should say, and the feed keeps
   what it fetched for a couple of minutes: it is told to forget. */

export async function disconnectAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    await deleteConnection(db, field(formData, 'connectionId'))
    clearFeedCache()
  })
}

/** Feed a calendar into the chosen context; with no context chosen, into none. */
export async function setCalendarContextAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    const connectionId = field(formData, 'connectionId')
    const calendarId = field(formData, 'calendarId')
    const contextId = field(formData, 'contextId')

    if (contextId) {
      await bindCalendar(db, { connectionId, calendarId, name: field(formData, 'name'), contextId })
    } else {
      const bound = (await listBindings(db)).find(
        (binding) => binding.connectionId === connectionId && binding.externalId === calendarId,
      )
      if (bound) await unbindCalendar(db, bound.id)
    }
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

/** Feed a folder into the chosen context; with no context chosen, into none. */
export async function setFolderContextAction(formData: FormData): Promise<ActionResult> {
  return act(async () => {
    const connectionId = field(formData, 'connectionId')
    const folderId = field(formData, 'folderId')
    const contextId = field(formData, 'contextId')

    if (contextId) {
      await bindFolder(db, { connectionId, folderId, name: field(formData, 'name'), contextId })
      reconcileSoon()
    } else {
      await unbindFolder(db, { connectionId, folderId })
    }
  })
}
