import { Icon } from '@/components/ui/icons'
import { iconButtonClasses } from '@/components/ui/IconButton'
import { granolaNoteUrl } from '@/lib/connect/granola/links'

/**
 * Opens a Granola note in Granola, in a new tab: a chip beside where the item
 * came from, or with `compact` an icon on a row.
 */
export function GranolaChip({ noteId, compact = false }: { noteId: string; compact?: boolean }) {
  const href = granolaNoteUrl(noteId)
  if (compact) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        aria-label="Open in Granola"
        title="Open in Granola"
        className={iconButtonClasses('gray')}
      >
        <Icon name="sparkles" className="h-4 w-4" />
      </a>
    )
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title="Open in Granola"
      className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
    >
      <Icon name="sparkles" className="h-3.5 w-3.5 shrink-0" />
      Granola
    </a>
  )
}
