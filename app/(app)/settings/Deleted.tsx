import { FormModal, IconAction } from '@/components/forms'
import { Card, CollapsedSection } from '@/components/ui/Card'
import { Icon, type IconName } from '@/components/ui/icons'
import { listDeleted, purgeOn, type DeletedKind } from '@/lib/archive/archive'
import { formatDay, todayIn } from '@/lib/core/dates'
import { db } from '@/lib/db'
import { purgeAction, restoreDeletedAction } from '../archive-actions'

const ICON: Record<DeletedKind, IconName> = {
  context: 'context',
  person: 'person',
  group: 'group',
  project: 'project',
  series: 'refresh',
  meeting: 'meeting',
  item: 'topic',
  milestone: 'flag',
  link: 'link',
  document: 'document',
}

/* What was deleted in the last 30 days: Restore, or gone for good now. Each
   row says the day it goes on its own. Hidden while there is nothing. */
export async function Deleted({ timeZone }: { timeZone: string | null }) {
  const rows = await listDeleted(db)
  if (rows.length === 0) return null
  const today = todayIn(timeZone)

  return (
    <CollapsedSection title="Deleted" icon="trash" count={rows.length}>
      <Card>
        <ul className="divide-y divide-gray-100 dark:divide-gray-700">
          {rows.map((row) => {
            const fields = { kind: row.kind, id: row.id }
            return (
              <li key={`${row.kind}:${row.id}`} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
                <Icon name={ICON[row.kind]} className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm text-gray-900 dark:text-gray-100">{row.name}</span>
                  <span className="truncate text-xs text-gray-500 dark:text-gray-400">
                    {[row.context, formatDay(todayIn(timeZone, purgeOn(row.deletedAt)), today)]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <IconAction action={restoreDeletedAction} fields={fields} icon="undo" label={`Restore ${row.name}`} />
                <FormModal
                  action={purgeAction}
                  title={`Delete ${row.name} for good?`}
                  icon="trash"
                  compact
                  submit="Delete"
                  danger
                >
                  <input type="hidden" name="kind" value={row.kind} />
                  <input type="hidden" name="id" value={row.id} />
                </FormModal>
              </li>
            )
          })}
        </ul>
      </Card>
    </CollapsedSection>
  )
}
