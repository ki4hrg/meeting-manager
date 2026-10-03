'use client'

import { useRouter } from 'next/navigation'

/** Jump a meetings list to a day: picking a date opens `href` at it. */
export function DateJump({ href, param, value }: { href: string; param: string; value?: string }) {
  const router = useRouter()
  return (
    <input
      type="date"
      aria-label="Go to date"
      defaultValue={value}
      onChange={(event) => {
        const day = event.target.value
        if (day) router.push(`${href}?${param}=${day}`)
      }}
      className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-700 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
    />
  )
}
