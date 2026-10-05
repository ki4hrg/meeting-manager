'use client'

import { useTransition } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { switchContextAction } from '@/app/(app)/actions'

const MANAGE = '__manage'
const SETTINGS = '__settings'

export function ContextSwitcher({
  contexts,
  current,
}: {
  contexts: Array<{ id: string; name: string }>
  current: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const [pending, startTransition] = useTransition()

  return (
    <select
      aria-label="Context"
      value={current}
      disabled={pending}
      onChange={(event) => {
        const value = event.target.value
        if (value === MANAGE) router.push('/contexts')
        else if (value === SETTINGS) router.push('/settings')
        else startTransition(() => switchContextAction(value, pathname))
      }}
      className="min-w-0 max-w-[9rem] truncate rounded-md border border-gray-300 bg-white py-1.5 pl-2 pr-7 text-sm font-medium text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 sm:max-w-[12rem] dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
    >
      {contexts.map((context) => (
        <option key={context.id} value={context.id}>
          {context.name}
        </option>
      ))}
      <option value={MANAGE}>Contexts…</option>
      <option value={SETTINGS}>Settings…</option>
    </select>
  )
}
