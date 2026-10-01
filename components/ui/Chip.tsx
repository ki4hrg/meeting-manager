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
