import { notFound } from 'next/navigation'
import { ArchiveButton, ArchivedBar, Muted } from '@/components/archive/Archive'
import { ActionButton, FormModal, IconAction } from '@/components/forms'
import { ItemGrid } from '@/components/items/ItemCard'
import { MeetingGrid } from '@/components/meetings/MeetingCard'
import { QuickAdd } from '@/components/QuickAdd'
import { Card, Section, TwoColumn } from '@/components/ui/Card'
import { Chip } from '@/components/ui/Chip'
import { Field, Input } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import { PageHeader } from '@/components/ui/PageHeader'
import { RemovableChip } from '@/components/ui/RemovableChip'
import { isUuid } from '@/lib/core/match'
import { NotFoundError } from '@/lib/core/types'
import { db } from '@/lib/db'
import { groupsOf } from '@/lib/directory/groups'
import { getPerson } from '@/lib/directory/people'
import { listItems, type ItemView } from '@/lib/items/items'
import { listMeetings } from '@/lib/meetings/meetings'
import { pendingOnCards } from '@/lib/processing/proposals'
import { requireContext, viewer } from '@/lib/web/context'
import {
  addPersonEmailAction,
  primaryEmailAction,
  removePersonEmailAction,
  updatePersonAction,
} from '../../actions'
import { prepWithPersonAction } from '../../meetings/actions'

const has = (item: ItemView, personId: string, role: 'owner' | 'with') =>
  item.parties.some((party) => party.id === personId && party.role === role)

/* The person hub. People are global, but what is listed here is only what
   involves them in the selected context. */
export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) notFound()

  const context = await requireContext()
  const { user, self, today } = await viewer()
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
      crumbs={[{ href: '/people', label: 'People' }]}
      actions={
        /* One click: a stub with everything saved up for them already on its agenda. */
        person.isSelf || person.archivedAt ? null : (
          <ActionButton action={prepWithPersonAction} fields={{ personId: person.id }}>
            <Icon name="meeting" className="h-4 w-4" />
            Prep
          </ActionButton>
        )
      }
      tools={
        <>
          <FormModal action={updatePersonAction} title="Edit" icon="pencil" compact iconSize="md">
            <input type="hidden" name="id" value={person.id} />
            <Field label="Name" required>
              <Input name="name" defaultValue={person.name} required />
            </Field>
          </FormModal>
          {person.isSelf || person.archivedAt ? null : <ArchiveButton kind="person" id={person.id} />}
        </>
      }
    />
  )

  // Every address they are known by; invitees match any of them.
  const emails = (
    <div className="-mt-4 mb-8 flex flex-wrap items-center gap-2">
      {person.emails.map((email, index) => (
        <span key={email} className="inline-flex items-center gap-0.5">
          {index === 0 ? (
            <Icon name="star" className="h-3.5 w-3.5 text-amber-500 dark:text-amber-400" label="Primary" />
          ) : (
            <IconAction
              action={primaryEmailAction}
              fields={{ personId: person.id, email }}
              icon="star"
              label={`Make ${email} primary`}
            />
          )}
          <RemovableChip
            icon="mail"
            remove={{
              action: removePersonEmailAction,
              fields: { personId: person.id, email },
              label: `Remove ${email}`,
            }}
          >
            {email}
          </RemovableChip>
        </span>
      ))}
      <FormModal action={addPersonEmailAction} title="Add email" label="Email" icon="plus" variant="secondary" size="sm" submit="Add">
        <input type="hidden" name="personId" value={person.id} />
        <Field label="Email" required>
          <Input name="email" type="email" required />
        </Field>
      </FormModal>
    </div>
  )

  if (person.isSelf) {
    // An ongoing question is pursued, not owed: it waits on its project.
    const owe = open.filter((item) => has(item, id, 'owner') && !item.ongoing)
    const owed = open.filter((item) => has(item, id, 'with'))
    return (
      <>
        {header}
        {emails}
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

  const meetings = await listMeetings(db, { contextId: context.id, personId: id, topLevelOnly: true })
  const pending = await pendingOnCards(db, context.id)
  const groups = await groupsOf(db, context.id, id)
  const archived = !!person.archivedAt
  const theyOwe = open.filter((item) => has(item, id, 'owner'))
  const iOwe = open.filter((item) => has(item, id, 'with') && has(item, self.id, 'owner'))
  const raise = open.filter((item) => has(item, id, 'with') && !has(item, self.id, 'owner'))

  return (
    <>
      {header}
      {archived ? <ArchivedBar kind="person" id={person.id} /> : null}
      <Muted archived={archived}>
        {emails}

        <TwoColumn
          main={
            <>
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
          }
          side={
            <>
              <Section title="Meetings" empty={meetings.length === 0}>
                <MeetingGrid meetings={meetings} timeZone={user.timeZone} pending={pending} />
              </Section>

              {groups.length > 0 ? (
                <Section title="Groups" count={groups.length}>
                  <Card>
                    <div className="flex flex-wrap gap-2">
                      {groups.map((group) => (
                        <Chip key={group.id} href={`/groups/${group.id}`} icon="group">
                          {group.name}
                        </Chip>
                      ))}
                    </div>
                  </Card>
                </Section>
              ) : null}
            </>
          }
        />
      </Muted>
    </>
  )
}
