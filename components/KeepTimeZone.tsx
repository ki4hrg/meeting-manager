'use client'

import { useEffect, useRef } from 'react'
import { setTimeZoneAction } from '@/app/(app)/settings/actions'

/**
 * Saves the browser's time zone when none is saved, so "today" and every date
 * sent to Todoist follow John's clock rather than the server's. Rendered only
 * while nothing is saved; the action revalidates the page.
 */
export function KeepTimeZone() {
  const sent = useRef(false)
  useEffect(() => {
    if (sent.current) return
    sent.current = true
    const data = new FormData()
    data.set('timeZone', Intl.DateTimeFormat().resolvedOptions().timeZone)
    // A zone this server does not know stays unsaved; Settings can still pick one.
    void setTimeZoneAction(data).catch(() => {})
  }, [])
  return null
}
