import { DeleteButton } from '@/components/archive/DeleteButton'
import { ActionButton, FormModal, IconAction } from '@/components/forms'
import { Card, CardGrid, CollapsedSection } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Field, Input } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/StatusBadge'
import { previewDelete } from '@/lib/archive/archive'
import { db } from '@/lib/db'
import { listContexts } from '@/lib/directory/contexts'
import { allContexts, currentContext } from '@/lib/web/context'
import { archiveAction, deleteRecordAction, unarchiveAction } from '../archive-actions'
import { createContextAction, renameContextAction } from '../actions'

export default async function ContextsPage() {
  const contexts = await allContexts()
  const current = await currentContext()
  const archived = await Promise.all(
    (await listContexts(db, 'archived')).map(async (context) => ({
      context,
      preview: await previewDelete(db, 'context', context.id),
    })),
  )

  return (
    <>
      <PageHeader
        title="Contexts"
        crumbs={[{ href: '/', label: 'Home' }]}
        actions={
          <FormModal action={createContextAction} title="New context" label="New context" icon="plus">
            <Field label="Name" required>
              <Input name="name" required />
            </Field>
          </FormModal>
        }
      />

      {contexts.length === 0 ? (
        <EmptyState icon="context" />
      ) : (
        <CardGrid>
          {contexts.map((context) => (
            <Card key={context.id}>
              <div className="flex items-center gap-3">
                <Icon name="context" className="h-5 w-5 shrink-0 text-gray-400 dark:text-gray-500" />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {context.name}
                </span>
                {context.id === current?.id ? <Badge tone="blue">Current</Badge> : null}
                <FormModal
                  action={renameContextAction}
                  title="Edit"
                  icon="pencil"
                  compact
                >
                  <input type="hidden" name="id" value={context.id} />
                  <Field label="Name" required>
                    <Input name="name" defaultValue={context.name} required />
                  </Field>
                </FormModal>
                {/* The last one stays: there is always somewhere to work. */}
                {contexts.length > 1 ? (
                  <IconAction
                    action={archiveAction}
                    fields={{ kind: 'context', id: context.id }}
                    icon="archive"
                    label={`Archive ${context.name}`}
                  />
                ) : null}
              </div>
            </Card>
          ))}
        </CardGrid>
      )}

      {archived.length > 0 ? (
        <div className="mt-8">
          <CollapsedSection title="Archived" icon="archive" count={archived.length}>
            <CardGrid>
              {archived.map(({ context, preview }) => (
                <Card key={context.id}>
                  <div className="flex flex-wrap items-center gap-3">
                    <Icon name="context" className="h-5 w-5 shrink-0 text-gray-400 dark:text-gray-500" />
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-500 dark:text-gray-400">
                      {context.name}
                    </span>
                    <ActionButton
                      action={unarchiveAction}
                      fields={{ kind: 'context', id: context.id }}
                      variant="secondary"
                      size="sm"
                    >
                      <Icon name="undo" className="h-4 w-4" />
                      Restore
                    </ActionButton>
                    <DeleteButton
                      action={deleteRecordAction}
                      fields={{ kind: 'context', id: context.id }}
                      blockers={preview.blockers}
                      takes={preview.takes}
                    />
                  </div>
                </Card>
              ))}
            </CardGrid>
          </CollapsedSection>
        </div>
      ) : null}
    </>
  )
}
