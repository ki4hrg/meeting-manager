import { ButtonLink } from './Button'
import { Icon, type IconName } from './icons'

/** An empty list: its icon and the one action that fills it. No explanation. */
export function EmptyState({
  icon,
  action,
}: {
  icon: IconName
  action?: { label: string; href: string }
}) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed border-gray-300 px-6 py-10 dark:border-gray-700">
      <Icon name={icon} className="h-8 w-8 text-gray-300 dark:text-gray-600" />
      {action ? (
        <ButtonLink href={action.href} variant="secondary" size="sm">
          <Icon name="plus" className="h-4 w-4" />
          {action.label}
        </ButtonLink>
      ) : null}
    </div>
  )
}
