'use server'

import { clearFeedCache } from '@/lib/calendar/feed'
import {
  bindCalendar,
  deleteConnection,
  listBindings,
  unbindCalendar,
} from '@/lib/connect/connections'
import { db } from '@/lib/db'
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
