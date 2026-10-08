import { notFound } from 'next/navigation'
import { ArchiveButton, ArchivedBar, Muted } from '@/components/archive/Archive'
import { ActionButton, FormModal, IconAction } from '@/components/forms'
import { ItemGrid } from '@/components/items/ItemCard'
import { KindSection } from '@/components/items/KindSection'
import { MeetingGrid } from '@/components/meetings/MeetingCard'
import { QuickAdd } from '@/components/QuickAdd'
import { Card, Section, TwoColumn } from '@/components/ui/Card'
import { Chip } from '@/components/ui/Chip'
import { Field, Input, Select } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import { PageHeader } from '@/components/ui/PageHeader'
import { RemovableChip } from '@/components/ui/RemovableChip'
import { isUuid } from '@/lib/core/match'
import { NotFoundError } from '@/lib/core/types'
import { db } from '@/lib/db'
import { groupsOf } from '@/lib/directory/groups'
import { getPerson, listPeople } from '@/lib/directory/people'
import { listItems, type ItemView } from '@/lib/items/items'
import { listMeetings } from '@/lib/meetings/meetings'
import { pendingOnCards } from '@/lib/processing/proposals'
import { requireContext, viewer } from '@/lib/web/context'
import {
  addPersonEmailAction,
  mergePersonAction,
  primaryEmailAction,
  removePersonEmailAction,
  updatePersonAction,
} from '../../actions'
import { prepWithPersonAction } from '../../meetings/actions'

/* The person hub. People are global, but what is listed here is only what
   involves them in the selected context. */
export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) notFound()

  const context = await requireContext()
  const { user, today } = await viewer()
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

  // Anyone but John can be folded in here, archived ones too.
  const others = (await listPeople(db, 'all')).filter((one) => one.id !== id && !one.isSelf)

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
          {others.length > 0 ? (
            <FormModal action={mergePersonAction} title="Merge" icon="merge" compact iconSize="md" submit="Merge" danger>
              <input type="hidden" name="id" value={person.id} />
              <Field label="Duplicate" required>
                <Select name="from" required defaultValue="">
                  <option value="" disabled />
                  {others.map((one) => (
                    <option key={one.id} value={one.id}>
                      {one.email ? `${one.name} (${one.email})` : one.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </FormModal>
          ) : null}
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

  const byKind = (kind: ItemView['kind']) => open.filter((item) => item.kind === kind)
  // Added here, an action or a question is theirs to answer for, a topic to raise with them.
  const kinds = (
    <>
      <KindSection
        kind="action"
        items={byKind('action')}
        today={today}
        action={<QuickAdd presets={{ kind: 'action', parties: [{ personId: id, role: 'owner' }] }} />}
      />
      <KindSection
        kind="question"
        items={byKind('question')}
        today={today}
        action={<QuickAdd presets={{ kind: 'question', parties: [{ personId: id, role: 'owner' }] }} />}
      />
      <KindSection
        kind="topic"
        items={byKind('topic')}
        today={today}
        action={<QuickAdd presets={{ kind: 'topic', parties: [{ personId: id, role: person.isSelf ? 'owner' : 'with' }] }} />}
      />
    </>
  )

  if (person.isSelf) {
    return (
      <>
        {header}
        {emails}
        {kinds}
      </>
    )
  }

  const meetings = await listMeetings(db, { contextId: context.id, personId: id, topLevelOnly: true })
  const pending = await pendingOnCards(db, context.id)
  const groups = await groupsOf(db, context.id, id)
  const archived = !!person.archivedAt

  return (
    <>
      {header}
      {archived ? <ArchivedBar kind="person" id={person.id} /> : null}
      <Muted archived={archived}>
        {emails}

        <TwoColumn
          main={
            <>
              {kinds}

              {closed.length > 0 ? (
                <Section title="Closed" icon="check" tone="gray">
                  <ItemGrid items={closed} today={today} empty="check" />
                </Section>
              ) : null}
            </>
          }
          side={
            <>
              <Section title="Meetings" icon="meeting" tone="teal" empty={meetings.length === 0}>
                <MeetingGrid meetings={meetings} timeZone={user.timeZone} pending={pending} />
              </Section>

              {groups.length > 0 ? (
                <Section title="Groups" icon="group" tone="teal" count={groups.length}>
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
