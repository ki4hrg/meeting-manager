import { forwardRef } from 'react'
import { Icon, type IconName } from './icons'

const TONES = {
  gray: 'text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-500 dark:hover:bg-gray-700 dark:hover:text-gray-200',
  /* Switched on: a toggle that is set, a mark that has been made. */
  on: 'text-green-600 hover:bg-gray-100 dark:text-green-400 dark:hover:bg-gray-700',
  blue: 'text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40',
} as const

const SIZES = {
  /* On a row or a card. */
  sm: { box: 'h-7 w-7', icon: 'h-4 w-4' },
  /* Housekeeping in a page header, beside buttons with words. */
  md: { box: 'h-9 w-9', icon: 'h-5 w-5' },
} as const

export type IconTone = keyof typeof TONES
export type IconSize = keyof typeof SIZES

/** The icon-only class string, for a link that should look like an `IconButton`. */
export function iconButtonClasses(tone: IconTone = 'gray', size: IconSize = 'sm', className = ''): string {
  return `flex ${SIZES[size].box} shrink-0 items-center justify-center rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-40 ${TONES[tone]} ${className}`
}

export type IconButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  icon: IconName
  /** What the button does: its accessible name, and its tooltip. */
  label: string
  /**
   * Gray by default; blue for the affirmative (Accept, Place); `on` for a
   * toggle that is set.
   */
  tone?: IconTone
  size?: IconSize
}

/**
 * A square button that is only an icon: every action on a row or a card, and
 * the housekeeping (Edit, Move, Archive, Delete) at the end of a page header.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ icon, label, tone = 'gray', size = 'sm', className = '', type, ...props }, ref) => (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-label={label}
      title={label}
      className={iconButtonClasses(tone, size, className)}
      {...props}
    >
      <Icon name={icon} className={SIZES[size].icon} />
    </button>
  ),
)

IconButton.displayName = 'IconButton'
