'use client'

import { useState, useSyncExternalStore, useTransition } from 'react'
import { ActionSelect } from '@/components/ActionSelect'
import { useToast } from '@/components/Toast'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Select } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import { setTimeZoneAction } from './actions'

const never = () => () => {}

/* The browser's zone, read only once the page is in the browser. */
function useBrowserZone(): string | null {
  return useSyncExternalStore(
    never,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    () => null,
  )
}

/* Saved: choosing another saves it. Not yet saved: the browser's zone is
   offered, and Save keeps it. */
export function TimeZonePicker({
  saved,
  fallback,
  zones,
}: {
  saved: string | null
  /** The instance's own zone, used while nothing is saved. */
  fallback: string
  zones: string[]
}) {
  const browser = useBrowserZone()
  const toast = useToast()
  const [picked, setPicked] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const options = (extra: (string | null)[]) => {
    const all = new Set(zones)
    for (const zone of extra) if (zone) all.add(zone)
    return [...all].sort().map((zone) => (
      <option key={zone} value={zone}>
        {zone.replaceAll('_', ' ')}
      </option>
    ))
  }

  if (saved) {
    return (
      <Card>
        <div className="flex items-center gap-3">
          <Icon name="clock" className="h-5 w-5 shrink-0 text-gray-400 dark:text-gray-500" />
          <ActionSelect
            key={saved}
            action={setTimeZoneAction}
            fields={{}}
            name="timeZone"
            value={saved}
            label="Time zone"
            className="min-w-0 flex-1"
          >
            {options([saved])}
          </ActionSelect>
        </div>
      </Card>
    )
  }

  const value = picked ?? browser ?? fallback
  return (
    <Card>
      <div className="flex items-center gap-3">
        <Icon name="clock" className="h-5 w-5 shrink-0 text-gray-400 dark:text-gray-500" />
        <Select
          aria-label="Time zone"
          value={value}
          onChange={(event) => setPicked(event.target.value)}
          className="!mt-0 min-w-0 flex-1"
        >
          {options([browser, fallback])}
        </Select>
        <Button
          variant="secondary"
          size="sm"
          disabled={pending}
          onClick={() => {
            const data = new FormData()
            data.set('timeZone', value)
            startTransition(async () => {
              const result = await setTimeZoneAction(data)
              if (result?.error) toast.error(result.error)
            })
          }}
        >
          <Icon name="check" className="h-4 w-4" />
          Save
        </Button>
      </div>
    </Card>
  )
}
