import { FormModal } from '@/components/forms'
import { Card, CardGrid } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Field, Input } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/StatusBadge'
import { allContexts, currentContext } from '@/lib/web/context'
import { createContextAction, renameContextAction } from '../actions'

export default async function ContextsPage() {
  const contexts = await allContexts()
  const current = await currentContext()

  return (
    <>
      <PageHeader
        title="Contexts"
        actions={
          <FormModal action={createContextAction} title="New context" label="New context">
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
                  title="Rename"
                  icon="pencil"
                  variant="ghost"
                  size="sm"
                >
                  <input type="hidden" name="id" value={context.id} />
                  <Field label="Name" required>
                    <Input name="name" defaultValue={context.name} required />
                  </Field>
                </FormModal>
              </div>
            </Card>
          ))}
        </CardGrid>
      )}
    </>
  )
}
