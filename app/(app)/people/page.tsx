import { ArchivedSection } from '@/components/archive/Archive'
import { FormModal } from '@/components/forms'
import { CardGrid, LinkCard } from '@/components/ui/Card'
import { Field, Input } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/StatusBadge'
import { db } from '@/lib/db'
import { listPeople } from '@/lib/directory/people'
import { openCounts } from '@/lib/items/items'
import { requireContext } from '@/lib/web/context'
import { createPersonAction } from '../actions'

export default async function PeoplePage() {
  const context = await requireContext()
  const people = await listPeople(db)
  const archived = await listPeople(db, 'archived')
  const counts = await openCounts(db, context.id)

  return (
    <>
      <PageHeader
        title="People"
        count={people.length}
        actions={
          <FormModal action={createPersonAction} title="New person" label="New person">
            <Field label="Name" required>
              <Input name="name" required />
            </Field>
            <Field label="Email">
              <Input name="email" type="email" />
            </Field>
          </FormModal>
        }
      />

      <CardGrid>
        {people.map((person) => {
          const open = counts.byPerson.get(person.id) ?? 0
          return (
            <LinkCard key={person.id} href={`/people/${person.id}`}>
              <div className="flex items-center gap-3">
                <Icon
                  name="person"
                  className={`h-5 w-5 shrink-0 ${
                    person.isSelf
                      ? 'text-blue-600 dark:text-blue-400'
                      : 'text-gray-400 dark:text-gray-500'
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {person.name}
                  </p>
                  {person.email ? (
                    <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                      {person.email}
                    </p>
                  ) : null}
                </div>
                {open > 0 ? <Badge tone="blue">{open}</Badge> : null}
              </div>
            </LinkCard>
          )
        })}
      </CardGrid>
      <ArchivedSection
        icon="person"
        rows={archived.map((person) => ({ id: person.id, name: person.name, href: `/people/${person.id}`, meta: person.email ?? undefined }))}
      />
    </>
  )
}
