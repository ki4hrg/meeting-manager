import Link from 'next/link'
import { ActionButton } from '@/components/forms'
import type { ActionResult } from '@/lib/web/action'
import { Icon, type IconName } from './icons'

/**
 * A `Chip` with a cross: something attached to what the page is about, and
 * the one click that takes it off. The name is a link when it has somewhere
 * to go. With `edit`, a pencil before the cross changes it instead.
 */
export function RemovableChip({
  icon,
  iconLabel,
  href,
  children,
  edit,
  remove,
}: {
  icon: IconName
  /** Read out when the icon says something the name does not. */
  iconLabel?: string
  href?: string
  children: React.ReactNode
  edit?: { label: string; onClick: () => void }
  remove: {
    action: (formData: FormData) => Promise<ActionResult>
    fields: Record<string, string>
    label: string
  }
}) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-gray-100 py-0.5 pl-2.5 pr-0.5 text-xs font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-300">
      <Icon name={icon} className="h-3.5 w-3.5 shrink-0" label={iconLabel} />
      {href ? (
        <Link href={href} className="min-w-0 truncate hover:underline">
          {children}
        </Link>
      ) : (
        <span className="min-w-0 truncate">{children}</span>
      )}
      {edit ? (
        <button
          type="button"
          onClick={edit.onClick}
          aria-label={edit.label}
          title={edit.label}
          className="flex shrink-0 items-center justify-center rounded-full p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 dark:hover:bg-gray-600 dark:hover:text-gray-200"
        >
          <Icon name="pencil" className="h-3 w-3" />
        </button>
      ) : null}
      <ActionButton
        action={remove.action}
        fields={remove.fields}
        variant="ghost"
        size="sm"
        aria-label={remove.label}
        title={remove.label}
        className="!rounded-full !p-1 !text-gray-400 hover:!bg-gray-200 hover:!text-gray-700 dark:!text-gray-400 dark:hover:!bg-gray-600 dark:hover:!text-gray-200"
      >
        <Icon name="close" className="h-3 w-3" />
      </ActionButton>
    </span>
  )
}
