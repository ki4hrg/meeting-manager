import { forwardRef } from 'react'
import { Icon, type IconName } from './icons'

const TONES = {
  gray: 'text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-500 dark:hover:bg-gray-700 dark:hover:text-gray-200',
  /* Switched on: a toggle that is set, a mark that has been made. */
  on: 'text-green-600 hover:bg-gray-100 dark:text-green-400 dark:hover:bg-gray-700',
  blue: 'text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40',
} as const

export type IconButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  icon: IconName
  /** What the button does: its accessible name, and its tooltip. */
  label: string
  tone?: keyof typeof TONES
}

/** A small square button that is only an icon, for the actions on a row. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ icon, label, tone = 'gray', className = '', type, ...props }, ref) => (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-label={label}
      title={label}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-40 ${TONES[tone]} ${className}`}
      {...props}
    >
      <Icon name={icon} className="h-4 w-4" />
    </button>
  ),
)

IconButton.displayName = 'IconButton'
