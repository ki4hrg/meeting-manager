'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { eventsOnDayAction, prepEventAction, type DayEvent } from '@/app/(app)/meetings/actions'
import { useToast } from '@/components/Toast'
import { Icon } from '@/components/ui/icons'

/**
 * In the New meeting form: once a start is chosen, that day's calendar events
 * with no meeting yet. Picking one preps it from the event (its people and
 * series) instead of making a bare meeting by hand.
 */
export function DayEvents() {
  const ref = useRef<HTMLDivElement>(null)
  const toast = useToast()
  const [day, setDay] = useState('')
  const [found, setFound] = useState<{ day: string; events: DayEvent[] }>({ day: '', events: [] })
  const [pending, startTransition] = useTransition()

  /* The start field is the form's own; its day is read as it changes. */
  useEffect(() => {
    const form = ref.current?.closest('form')
    const start = form?.querySelector<HTMLInputElement>('input[name="startsAt"]')
    if (!start) return
    const read = () => setDay(start.value.slice(0, 10))
    start.addEventListener('change', read)
    start.addEventListener('input', read)
    return () => {
      start.removeEventListener('change', read)
      start.removeEventListener('input', read)
    }
  }, [])

  useEffect(() => {
    if (!day || day === found.day) return
    let stale = false
    eventsOnDayAction(day).then((events) => {
      if (!stale) setFound({ day, events })
    })
    return () => {
      stale = true
    }
  }, [day, found.day])

  const events = found.day === day ? found.events : []
  return (
    <div ref={ref}>
      {events.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {events.map((event) => (
            <li key={event.eventId}>
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  const data = new FormData()
                  data.set('eventId', event.eventId)
                  data.set('at', event.at)
                  startTransition(async () => {
                    const result = await prepEventAction(data)
                    if (result?.error) toast.error(result.error)
                  })
                }}
                className="flex w-full items-center gap-3 rounded-md border border-gray-200 bg-white px-3 py-2 text-left text-sm shadow-sm transition-colors hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700/40 dark:hover:bg-gray-700"
              >
                <Icon name="meeting" className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" />
                <span className="shrink-0 text-xs font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                  {event.time}
                </span>
                <span className="min-w-0 flex-1 truncate text-gray-900 dark:text-gray-100">{event.title}</span>
                <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-400">
                  Prep
                  <Icon name="arrowRight" className="h-3.5 w-3.5" />
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
