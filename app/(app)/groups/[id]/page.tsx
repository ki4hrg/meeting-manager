import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ActionButton, FormModal } from '@/components/forms'
import { ItemGrid } from '@/components/items/ItemCard'
import { MeetingGrid } from '@/components/meetings/MeetingCard'
import { QuickAdd } from '@/components/QuickAdd'
import { Card, Section } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Field, Input } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import { PartyPicker } from '@/components/processing/PartyPicker'
import { PageHeader } from '@/components/ui/PageHeader'
import { isUuid } from '@/lib/core/match'
import { NotFoundError } from '@/lib/core/types'
import { db } from '@/lib/db'
import { getGroup, listMembers } from '@/lib/directory/groups'
import { listPeople } from '@/lib/directory/people'
import { listItems, type ItemView } from '@/lib/items/items'
import { listMeetings } from '@/lib/meetings/meetings'
import { viewer } from '@/lib/web/context'
import { addMemberAction, removeMemberAction, renameGroupAction } from '../../actions'
import { prepWithGroupAction } from '../../meetings/actions'

const has = (item: ItemView, groupId: string, role: 'owner' | 'with') =>
  item.parties.some((party) => party.id === groupId && party.role === role)

export default async function GroupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) notFound()

  const { user, today } = await viewer()
  const group = await getGroup(db, id).catch((err) => {
    if (err instanceof NotFoundError) notFound()
    throw err
  })

  const members = await listMembers(db, id)
  const memberIds = new Set(members.map((member) => member.id))
  const others = (await listPeople(db)).filter((person) => !memberIds.has(person.id))

  const all = await listItems(db, { contextId: group.contextId, party: { groupId: id } })
  const open = all.filter((item) => item.status === 'open' || item.status === 'needs_answer')
  const owes = open.filter((item) => has(item, id, 'owner'))
  const waiting = open.filter((item) => has(item, id, 'with'))
  const decisions = all.filter((item) => item.kind === 'decision')
  const meetings = await listMeetings(db, {
    contextId: group.contextId,
    groupId: id,
    topLevelOnly: true,
  })

  return (
    <>
      <PageHeader
        title={group.name}
        crumbs={[{ href: '/groups', label: 'Groups' }]}
        actions={
          <div className="flex items-center gap-2">
            <ActionButton action={prepWithGroupAction} fields={{ groupId: group.id }}>
              Prep
            </ActionButton>
            <FormModal action={renameGroupAction} title="Rename" label="Rename" variant="secondary">
              <input type="hidden" name="id" value={group.id} />
              <Field label="Name" required>
                <Input name="name" defaultValue={group.name} required />
              </Field>
            </FormModal>
          </div>
        }
      />

      <Section
        title="Waiting"
        count={waiting.length}
        action={<QuickAdd presets={{ parties: [{ groupId: id, role: 'with' }] }} />}
      >
        <ItemGrid items={waiting} today={today} empty="topic" />
      </Section>

      <Section
        title="Owes"
        count={owes.length}
        action={
          <QuickAdd presets={{ kind: 'action', parties: [{ groupId: id, role: 'owner' }] }} />
        }
      >
        <ItemGrid items={owes} today={today} empty="action" />
      </Section>

      <Section
        title="Decisions"
        count={decisions.length}
        action={
          <QuickAdd presets={{ kind: 'decision', parties: [{ groupId: id, role: 'with' }] }} />
        }
      >
        <ItemGrid items={decisions} today={today} empty="decision" />
      </Section>

      <Section title="Meetings">
        <MeetingGrid meetings={meetings} timeZone={user.timeZone} />
      </Section>

      <Section
        title="Members"
        count={members.length}
        action={
          <FormModal action={addMemberAction} title="Add members" label="Add" size="sm" submit="Add">
            <input type="hidden" name="groupId" value={group.id} />
            <PartyPicker
              label="People"
              name="people"
              options={others.map((person) => ({ value: person.id, name: person.name, icon: 'person' }))}
              allowNew
            />
          </FormModal>
        }
      >
        {members.length === 0 ? (
          <EmptyState icon="person" />
        ) : (
          <Card>
            <ul className="divide-y divide-gray-100 dark:divide-gray-700">
              {members.map((member) => (
                <li key={member.id} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
                  <Icon name="person" className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" />
                  <Link
                    href={`/people/${member.id}`}
                    className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900 hover:underline dark:text-gray-100"
                  >
                    {member.name}
                  </Link>
                  <ActionButton
                    action={removeMemberAction}
                    fields={{ groupId: group.id, personId: member.id }}
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${member.name}`}
                  >
                    <Icon name="close" className="h-4 w-4" />
                  </ActionButton>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </Section>
    </>
  )
}
