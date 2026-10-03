import Link from 'next/link'
import { Icon, type IconName } from './icons'
import type { Tone } from './StatusBadge'

const SURFACE = 'bg-white dark:bg-gray-800 shadow rounded-lg'

const PADDING = { sm: 'p-4', md: 'p-6' } as const

type CardProps = {
  children: React.ReactNode
  padding?: keyof typeof PADDING
  className?: string
}

export function Card({ children, padding = 'sm', className = '' }: CardProps) {
  return <div className={`${SURFACE} ${PADDING[padding]} ${className}`}>{children}</div>
}

/** A card that is one link. The whole surface is the target. */
export function LinkCard({
  href,
  children,
  padding = 'sm',
  className = '',
}: CardProps & { href: string }) {
  return (
    <Link
      href={href}
      className={`block ${SURFACE} ${PADDING[padding]} transition-shadow hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 ${className}`}
    >
      {children}
    </Link>
  )
}

/** Title on the left, status or actions on the right. */
export function CardHeader({
  title,
  meta,
  aside,
}: {
  title: React.ReactNode
  meta?: React.ReactNode
  aside?: React.ReactNode
}) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
        {meta ? <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{meta}</p> : null}
      </div>
      {aside ? <div className="flex shrink-0 items-center gap-2">{aside}</div> : null}
    </div>
  )
}

const TILE_TONES: Record<Tone, { square: string; hover: string }> = {
  blue: { square: 'bg-blue-600', hover: 'hover:border-blue-300 dark:hover:border-blue-700' },
  green: { square: 'bg-green-600', hover: 'hover:border-green-300 dark:hover:border-green-700' },
  amber: { square: 'bg-amber-500', hover: 'hover:border-amber-300 dark:hover:border-amber-700' },
  purple: {
    square: 'bg-purple-600',
    hover: 'hover:border-purple-300 dark:hover:border-purple-700',
  },
  teal: { square: 'bg-teal-600', hover: 'hover:border-teal-300 dark:hover:border-teal-700' },
  red: { square: 'bg-red-600', hover: 'hover:border-red-300 dark:hover:border-red-700' },
  gray: { square: 'bg-gray-500', hover: 'hover:border-gray-400 dark:hover:border-gray-500' },
}

/** A navigation tile: a coloured icon square, a title, and an optional count. */
export function Tile({
  href,
  icon,
  title,
  tone = 'blue',
  count,
}: {
  href: string
  icon: IconName
  title: string
  tone?: Tone
  count?: number
}) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-3 rounded-lg border border-gray-200 bg-white p-4 transition hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 ${TILE_TONES[tone].hover}`}
    >
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-white ${TILE_TONES[tone].square}`}
      >
        <Icon name={icon} className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900 dark:text-gray-100">
        {title}
      </span>
      {count !== undefined ? (
        <span className="text-sm font-semibold tabular-nums text-gray-500 dark:text-gray-400">
          {count}
        </span>
      ) : null}
    </Link>
  )
}

/** The responsive grid cards sit in: one, two, then three columns. */
export function CardGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">{children}</div>
}

/** A titled group of cards, with its action on the right. */
export function Section({
  title,
  count,
  action,
  children,
}: {
  title: string
  count?: number
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="mb-8">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="flex items-baseline gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
          {title}
          {count !== undefined ? (
            <span className="text-sm font-normal tabular-nums text-gray-500 dark:text-gray-400">
              {count}
            </span>
          ) : null}
        </h2>
        {action}
      </div>
      {children}
    </section>
  )
}

/** A section that starts closed: what is kept but not in the way ("Later", "Archived"). */
export function CollapsedSection({
  title,
  icon,
  count,
  children,
}: {
  title: string
  icon?: IconName
  count?: number
  children: React.ReactNode
}) {
  return (
    <details className="group mb-8">
      <summary className="mb-4 flex cursor-pointer list-none items-center gap-2 rounded-md text-lg font-semibold text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-100 [&::-webkit-details-marker]:hidden">
        {icon ? <Icon name={icon} className="h-5 w-5 text-gray-400 dark:text-gray-500" /> : null}
        {title}
        {count !== undefined ? (
          <span className="text-sm font-normal tabular-nums text-gray-500 dark:text-gray-400">{count}</span>
        ) : null}
        <Icon
          name="chevronDown"
          className="h-4 w-4 text-gray-400 transition-transform group-open:rotate-180 dark:text-gray-500"
        />
      </summary>
      {children}
    </details>
  )
}
