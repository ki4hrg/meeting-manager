/*
 * Archive, then delete, on a row's own page (lib/archive). Live, the page
 * offers Archive. Archived, it opens with a muted bar holding Restore and
 * Delete, and Delete says what it takes or what still depends on it.
 */

import { ActionButton, IconAction } from '@/components/forms'
import { Card, CardGrid, CollapsedSection, LinkCard } from '@/components/ui/Card'
import { Icon, type IconName } from '@/components/ui/icons'
import { previewDelete, type ArchiveKind } from '@/lib/archive/archive'
import { db } from '@/lib/db'
import { archiveAction, deleteRecordAction, unarchiveAction } from '@/app/(app)/archive-actions'
import { DeleteButton } from './DeleteButton'

export function ArchiveButton({ kind, id }: { kind: ArchiveKind; id: string }) {
  return (
    <IconAction action={archiveAction} fields={{ kind, id }} icon="archive" label="Archive" size="md" />
  )
}

export async function ArchivedBar({ kind, id, children }: { kind: ArchiveKind; id: string; children?: React.ReactNode }) {
  const { blockers, takes } = await previewDelete(db, kind, id)
  return (
    <Card className="mb-6 flex flex-wrap items-center gap-3 !bg-gray-100 dark:!bg-gray-800/60">
      <Icon name="archive" className="h-5 w-5 text-gray-500 dark:text-gray-400" label="Archived" />
      <div className="min-w-0 flex-1">{children}</div>
      <ActionButton action={unarchiveAction} fields={{ kind, id }} variant="secondary" size="sm">
        <Icon name="undo" className="h-4 w-4" />
        Restore
      </ActionButton>
      <DeleteButton action={deleteRecordAction} fields={{ kind, id }} blockers={blockers} takes={takes} />
    </Card>
  )
}

/** A page's content while it is archived: still readable, visibly put away. */
export function Muted({ archived, children }: { archived: boolean; children: React.ReactNode }) {
  return archived ? <div className="opacity-60">{children}</div> : <>{children}</>
}

/** A list page's archived rows, out of the way: collapsed, and hidden while there are none. */
export function ArchivedSection({
  rows,
  icon,
}: {
  rows: Array<{ id: string; name: string; href: string; meta?: string }>
  icon: IconName
}) {
  if (rows.length === 0) return null
  return (
    <div className="mt-8">
      <CollapsedSection title="Archived" icon="archive" count={rows.length}>
        <CardGrid>
          {rows.map((row) => (
            <LinkCard key={row.id} href={row.href}>
              <div className="flex items-center gap-3 opacity-70">
                <Icon name={icon} className="h-5 w-5 shrink-0 text-gray-400 dark:text-gray-500" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">{row.name}</p>
                  {row.meta ? <p className="truncate text-xs text-gray-500 dark:text-gray-400">{row.meta}</p> : null}
                </div>
              </div>
            </LinkCard>
          ))}
        </CardGrid>
      </CollapsedSection>
    </div>
  )
}
