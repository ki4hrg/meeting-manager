import Link from 'next/link'
import { Icon } from './icons'

export type Crumb = { href: string; label: string }

/**
 * The way back from a page: to the page it was opened from, when a card's
 * link said (`from`, `lib/web/from.ts`); otherwise up to its section, then
 * whatever it sits within. Installed as an app there is no browser back
 * button, so every page below a section shows one.
 */
export function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  if (crumbs.length === 0) return null
  return (
    <nav
      aria-label="Breadcrumb"
      className="mb-2 flex min-w-0 flex-wrap items-center gap-1 text-sm font-medium text-blue-600 dark:text-blue-400"
    >
      <Icon name="chevronDown" className="h-4 w-4 shrink-0 rotate-90" />
      {crumbs.map((crumb, index) => (
        <span key={crumb.href} className="inline-flex min-w-0 items-center gap-1">
          {index > 0 ? <span className="text-gray-400 dark:text-gray-500">/</span> : null}
          <Link href={crumb.href} className="truncate hover:underline">
            {crumb.label}
          </Link>
        </span>
      ))}
    </nav>
  )
}
