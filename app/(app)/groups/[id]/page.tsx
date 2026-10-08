import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArchiveButton, ArchivedBar, Muted } from '@/components/archive/Archive'
import { ActionButton, FormModal, IconAction } from '@/components/forms'
import { Answered } from '@/components/items/Answered'
import { KindSection } from '@/components/items/KindSection'
import { HubMeetings } from '@/components/meetings/HubMeetings'
import { QuickAdd } from '@/components/QuickAdd'
import { Card, Section, TwoColumn } from '@/components/ui/Card'
import { Field, Input, Select } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import { PartyPicker } from '@/components/processing/PartyPicker'
import { PageHeader } from '@/components/ui/PageHeader'
import { RemovableChip } from '@/components/ui/RemovableChip'
import { isUuid } from '@/lib/core/match'
import { NotFoundError } from '@/lib/core/types'
import { db } from '@/lib/db'
import { getGroup, listGroupEmails, listGroups, listMembers } from '@/lib/directory/groups'
import { listPeople } from '@/lib/directory/people'
import { answered, listItems, type ItemView } from '@/lib/items/items'
import { viewer } from '@/lib/web/context'
import {
  addGroupEmailAction,
  addMemberAction,
  mergeGroupAction,
  removeGroupEmailAction,
  removeMemberAction,
  renameGroupAction,
} from '../../actions'
import { prepWithGroupAction } from '../../meetings/actions'

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
  // Another group of this context, archived ones too, can be folded in here.
  const siblings = (await listGroups(db, group.contextId, 'all')).filter((one) => one.id !== id)

  const all = await listItems(db, { contextId: group.contextId, party: { groupId: id } })
  const open = all.filter((item) => item.status === 'open' || item.status === 'needs_answer')
  const byKind = (kind: ItemView['kind']) => open.filter((item) => item.kind === kind)
  const decisions = all.filter((item) => item.kind === 'decision')
  const answers = answered(all)

  const archived = !!group.archivedAt
  const emails = await listGroupEmails(db, id)

  return (
    <>
      <PageHeader
        title={group.name}
        crumbs={[{ href: '/groups', label: 'Groups' }]}
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
            {siblings.length > 0 ? (
              <FormModal action={mergeGroupAction} title="Merge" icon="merge" compact iconSize="md" submit="Merge" danger>
                <input type="hidden" name="id" value={group.id} />
                <Field label="Duplicate" required>
                  <Select name="from" required defaultValue="">
                    <option value="" disabled />
                    {siblings.map((one) => (
                      <option key={one.id} value={one.id}>
                        {one.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </FormModal>
            ) : null}
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
              <KindSection
                kind="action"
                items={byKind('action')}
                today={today}
                action={<QuickAdd presets={{ kind: 'action', parties: [{ groupId: id, role: 'owner' }] }} />}
              />
              <KindSection
                kind="question"
                items={byKind('question')}
                today={today}
                action={<QuickAdd presets={{ kind: 'question', parties: [{ groupId: id, role: 'owner' }] }} />}
              />
              <KindSection
                kind="topic"
                items={byKind('topic')}
                today={today}
                action={<QuickAdd presets={{ kind: 'topic', parties: [{ groupId: id, role: 'with' }] }} />}
              />
              <KindSection
                kind="decision"
                items={decisions}
                today={today}
                action={<QuickAdd presets={{ kind: 'decision', parties: [{ groupId: id, role: 'with' }] }} />}
              />

              <Answered items={answers} today={today} on={{ groupId: id }} />
            </>
          }
          side={
            <>
              <Section
                title="Members" icon="group" tone="teal"
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
