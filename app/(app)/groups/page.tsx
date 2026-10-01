import { FormModal } from '@/components/forms'
import { CardGrid, LinkCard } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Field, Input } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/StatusBadge'
import { db } from '@/lib/db'
import { listGroups } from '@/lib/directory/groups'
import { openCounts } from '@/lib/items/items'
import { requireContext } from '@/lib/web/context'
import { createGroupAction } from '../actions'

export default async function GroupsPage() {
  const context = await requireContext()
  const groups = await listGroups(db, context.id)
  const counts = await openCounts(db, context.id)

  return (
    <>
      <PageHeader
        title="Groups"
        count={groups.length}
        actions={
          <FormModal action={createGroupAction} title="New group" label="New group">
            <Field label="Name" required>
              <Input name="name" required />
            </Field>
          </FormModal>
        }
      />

      {groups.length === 0 ? (
        <EmptyState icon="group" />
      ) : (
        <CardGrid>
          {groups.map((group) => {
            const open = counts.byGroup.get(group.id) ?? 0
            return (
              <LinkCard key={group.id} href={`/groups/${group.id}`}>
                <div className="flex items-center gap-3">
                  <Icon name="group" className="h-5 w-5 shrink-0 text-amber-500 dark:text-amber-400" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
                      {group.name}
                    </p>
                    <p className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                      <Icon name="person" className="h-3.5 w-3.5" label="Members" />
                      {group.memberCount}
                    </p>
                  </div>
                  {open > 0 ? <Badge tone="blue">{open}</Badge> : null}
                </div>
              </LinkCard>
            )
          })}
        </CardGrid>
      )}
    </>
  )
}
