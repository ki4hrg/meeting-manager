import { notFound } from 'next/navigation'
import { FormModal } from '@/components/forms'
import { ItemGrid } from '@/components/items/ItemCard'
import { QuickAdd } from '@/components/QuickAdd'
import { Section } from '@/components/ui/Card'
import { Field, Input } from '@/components/ui/Field'
import { PageHeader } from '@/components/ui/PageHeader'
import { isUuid } from '@/lib/core/match'
import { NotFoundError } from '@/lib/core/types'
import { db } from '@/lib/db'
import { getPerson } from '@/lib/directory/people'
import { listItems, type ItemView } from '@/lib/items/items'
import { requireContext, viewer } from '@/lib/web/context'
import { updatePersonAction } from '../../actions'

const has = (item: ItemView, personId: string, role: 'owner' | 'with') =>
  item.parties.some((party) => party.id === personId && party.role === role)

/* The person hub. People are global, but what is listed here is only what
   involves them in the selected context. */
export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) notFound()

  const context = await requireContext()
  const { self, today } = await viewer()
  const person = await getPerson(db, id).catch((err) => {
    if (err instanceof NotFoundError) notFound()
    throw err
  })

  const open = await listItems(db, { contextId: context.id, open: true, party: { personId: id } })
  const closed = await listItems(db, {
    contextId: context.id,
    open: false,
    party: { personId: id },
    limit: 6,
  })

  const header = (
    <PageHeader
      title={person.name}
      actions={
        <FormModal action={updatePersonAction} title="Edit" label="Edit" variant="secondary">
          <input type="hidden" name="id" value={person.id} />
          <Field label="Name" required>
            <Input name="name" defaultValue={person.name} required />
          </Field>
          <Field label="Email">
            <Input name="email" type="email" defaultValue={person.email ?? ''} />
          </Field>
        </FormModal>
      }
    />
  )

  if (person.isSelf) {
    const owe = open.filter((item) => has(item, id, 'owner'))
    const owed = open.filter((item) => has(item, id, 'with'))
    return (
      <>
        {header}
        <Section
          title="I owe"
          count={owe.length}
          action={
            <QuickAdd presets={{ kind: 'action', parties: [{ personId: id, role: 'owner' }] }} />
          }
        >
          <ItemGrid items={owe} today={today} empty="action" />
        </Section>
        <Section title="Owed to me" count={owed.length}>
          <ItemGrid items={owed} today={today} empty="clock" />
        </Section>
      </>
    )
  }

  const theyOwe = open.filter((item) => has(item, id, 'owner'))
  const iOwe = open.filter((item) => has(item, id, 'with') && has(item, self.id, 'owner'))
  const raise = open.filter((item) => has(item, id, 'with') && !has(item, self.id, 'owner'))

  return (
    <>
      {header}

      <Section
        title="Raise"
        count={raise.length}
        action={<QuickAdd presets={{ parties: [{ personId: id, role: 'with' }] }} />}
      >
        <ItemGrid items={raise} today={today} empty="topic" />
      </Section>

      <Section
        title="They owe"
        count={theyOwe.length}
        action={
          <QuickAdd presets={{ kind: 'action', parties: [{ personId: id, role: 'owner' }] }} />
        }
      >
        <ItemGrid items={theyOwe} today={today} empty="action" />
      </Section>

      <Section
        title="I owe"
        count={iOwe.length}
        action={
          <QuickAdd
            presets={{
              kind: 'action',
              parties: [
                { personId: self.id, role: 'owner' },
                { personId: id, role: 'with' },
              ],
            }}
          />
        }
      >
        <ItemGrid items={iOwe} today={today} empty="action" />
      </Section>

      {closed.length > 0 ? (
        <Section title="Closed">
          <ItemGrid items={closed} today={today} empty="check" />
        </Section>
      ) : null}
    </>
  )
}
