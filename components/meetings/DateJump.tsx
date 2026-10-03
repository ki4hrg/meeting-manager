'use client'

import { useRouter } from 'next/navigation'
import { Icon } from '@/components/ui/icons'

/**
 * Jump a meetings list to a day: picking a date opens `href` at it.
 *
 * The native input sits invisibly over a calendar button. An empty date input
 * has no placeholder on iOS, so shown as itself it is a blank grey box.
 */
export function DateJump({ href, param, value }: { href: string; param: string; value?: string }) {
  const router = useRouter()
  return (
    <span className="relative inline-flex items-center gap-1.5 rounded-md p-1.5 text-sm font-medium tabular-nums text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200">
      <Icon name="meeting" className="h-4 w-4" />
      {value ? (
        <span>
          {new Date(`${value}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}
        </span>
      ) : null}
      <input
        type="date"
        aria-label="Go to date"
        title="Go to date"
        defaultValue={value}
        onClick={(event) => {
          // Desktop browsers open the picker only from its own indicator otherwise.
          try {
            event.currentTarget.showPicker()
          } catch {}
        }}
        onChange={(event) => {
          const day = event.target.value
          if (day) router.push(`${href}?${param}=${day}`)
        }}
        className="absolute inset-0 h-full min-h-0 w-full cursor-pointer opacity-0"
      />
    </span>
  )
}
