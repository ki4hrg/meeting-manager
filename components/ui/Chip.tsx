import Link from 'next/link'
import { Icon, type IconName } from './icons'

/** A pill that is a link: a person, group, project or series named on a page. */
export function Chip({ href, icon, children }: { href: string; icon: IconName; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
    >
      <Icon name={icon} className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{children}</span>
    </Link>
  )
}

/**
 * One filter of a list, as a link that sets or clears it: filled while it is
 * on. Without words, `label` is its name and tooltip.
 */
export function FilterChip({
  href,
  on,
  icon,
  label,
  children,
}: {
  href: string
  on: boolean
  icon?: React.ReactNode
  label?: string
  children?: React.ReactNode
}) {
  return (
    <Link
      href={href}
      aria-current={on ? 'true' : undefined}
      aria-label={children ? undefined : label}
      title={label}
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
        on
          ? 'bg-blue-100 text-blue-800 ring-1 ring-inset ring-blue-300 dark:bg-blue-900/40 dark:text-blue-300 dark:ring-blue-700'
          : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
      }`}
    >
      {icon}
      {children ? <span className="truncate">{children}</span> : null}
    </Link>
  )
}
