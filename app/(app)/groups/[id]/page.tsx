import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArchiveButton, ArchivedBar, Muted } from '@/components/archive/Archive'
import { ActionButton, FormModal, IconAction } from '@/components/forms'
import { Answered } from '@/components/items/Answered'
import { ItemGrid } from '@/components/items/ItemCard'
import { HubMeetings } from '@/components/meetings/HubMeetings'
import { QuickAdd } from '@/components/QuickAdd'
import { Card, Section, TwoColumn } from '@/components/ui/Card'
import { Field, Input } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import { PartyPicker } from '@/components/processing/PartyPicker'
import { PageHeader } from '@/components/ui/PageHeader'
import { RemovableChip } from '@/components/ui/RemovableChip'
import { isUuid } from '@/lib/core/match'
import { NotFoundError } from '@/lib/core/types'
import { db } from '@/lib/db'
import { getGroup, listGroupEmails, listMembers } from '@/lib/directory/groups'
import { listPeople } from '@/lib/directory/people'
import { answered, listItems, type ItemView } from '@/lib/items/items'
import { viewer } from '@/lib/web/context'
import { crumbsFrom } from '@/lib/web/crumbs'
import {
  addGroupEmailAction,
  addMemberAction,
  removeGroupEmailAction,
  removeMemberAction,
  renameGroupAction,
} from '../../actions'
import { prepWithGroupAction } from '../../meetings/actions'

const has = (item: ItemView, groupId: string, role: 'owner' | 'with') =>
  item.parties.some((party) => party.id === groupId && party.role === role)

export default async function GroupPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
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
  const answers = answered(all)

  const archived = !!group.archivedAt
  const emails = await listGroupEmails(db, id)

  return (
    <>
      <PageHeader
        title={group.name}
        crumbs={
          (await crumbsFrom(db, (await searchParams).from, group.contextId)) ?? [{ href: '/groups', label: 'Groups' }]
        }
        actions={
          archived ? null : (
            <ActionButton action={prepWithGroupAction} fields={{ groupId: group.id }}>
              <Icon name="meeting" className="h-4 w-4" />
              Prep
            </ActionButton>
          )
        }
        tools={
          <>
            <FormModal action={renameGroupAction} title="Edit" icon="pencil" compact iconSize="md">
              <input type="hidden" name="id" value={group.id} />
              <Field label="Name" required>
                <Input name="name" defaultValue={group.name} required />
              </Field>
            </FormModal>
            {archived ? null : <ArchiveButton kind="group" id={group.id} />}
          </>
        }
      />
      {archived ? <ArchivedBar kind="group" id={group.id} /> : null}
      <Muted archived={archived}>
        {/* A list address: an invitee at it brings the group to the meeting. */}
        <div className="-mt-4 mb-8 flex flex-wrap items-center gap-2">
          {emails.map((email) => (
            <RemovableChip
              key={email}
              icon="mail"
              remove={{ action: removeGroupEmailAction, fields: { groupId: group.id, email }, label: `Remove ${email}` }}
            >
              {email}
            </RemovableChip>
          ))}
          <FormModal action={addGroupEmailAction} title="Add email" label="Email" icon="plus" variant="secondary" size="sm" submit="Add">
            <input type="hidden" name="groupId" value={group.id} />
            <Field label="Email" required>
              <Input name="email" type="email" required />
            </Field>
          </FormModal>
        </div>

        <TwoColumn
          main={
            <>
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

              <Answered items={answers} today={today} on={{ groupId: id }} />
            </>
          }
          side={
            <>
              <Section
                title="Members"
                count={members.length}
                action={
                  <FormModal action={addMemberAction} title="Add members" label="Add" icon="plus" variant="secondary" size="sm" submit="Add">
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
                        <IconAction
                          action={removeMemberAction}
                          fields={{ groupId: group.id, personId: member.id }}
                          icon="close"
                          label={`Remove ${member.name}`}
                        />
                      </li>
                    ))}
                  </ul>
                </Card>
              </Section>

              <HubMeetings
                hub={{ kind: 'group', id }}
                contextId={group.contextId}
                path={`/groups/${id}`}
                query={await searchParams}
                timeZone={user.timeZone}
                today={today}
              />
            </>
          }
        />
      </Muted>
    </>
  )
}
