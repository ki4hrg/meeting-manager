import { ActionSelect } from '@/components/ActionSelect'
import { CopyButton } from '@/components/CopyButton'
import { DocumentCard } from '@/components/documents/DocumentCard'
import { EventCard } from '@/components/meetings/EventCard'
import { MeetingCard } from '@/components/meetings/MeetingCard'
import { RollCall } from '@/components/meetings/RollCall'
import { Roster } from '@/components/meetings/Roster'
import { LivesIn, MoveTo } from '@/components/meetings/Move'
import { UnfiledCard } from '@/components/meetings/UnfiledCard'
import { WhenInputs } from '@/components/meetings/WhenInputs'
import { DeleteButton } from '@/components/archive/DeleteButton'
import { FormModal, IconAction } from '@/components/forms'
import { PartyLine } from '@/components/items/ItemCard'
import { PartyPicker } from '@/components/processing/PartyPicker'
import { PendingBadge } from '@/components/processing/PendingBadge'
import { ProposalCard } from '@/components/processing/ProposalCard'
import { RunState } from '@/components/processing/RunState'
import { Button } from '@/components/ui/Button'
import { Card, CardGrid, CardHeader, CollapsedSection, LinkCard, Section, Tile } from '@/components/ui/Card'
import { CheckList } from '@/components/ui/CheckList'
import { Chip } from '@/components/ui/Chip'
import { EmptyState } from '@/components/ui/EmptyState'
import { Field, Input, Select, Textarea } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import { PageHeader } from '@/components/ui/PageHeader'
import { RemovableChip } from '@/components/ui/RemovableChip'
import { PartyRoles } from '@/components/items/PartyRoles'
import { IconButton } from '@/components/ui/IconButton'
import { Spinner } from '@/components/ui/Spinner'
import {
  Badge,
  ContextBadge,
  DueBadge,
  KIND,
  KindIcon,
  PROJECT_STATUS,
  ProjectStatusBadge,
  StatusBadge,
  type ItemKind,
  type ItemStatus,
  type ProjectStatus,
} from '@/components/ui/StatusBadge'
import type { ItemParty } from '@/lib/items/items'
import type { MeetingView } from '@/lib/meetings/meetings'
import type { UpcomingEntry } from '@/lib/meetings/prep'
import type { ProposalView } from '@/lib/processing/proposals'
import type { Run } from '@/lib/processing/run'
import { sampleAction } from './actions'
import { Interactive } from './interactive'

const KINDS = Object.keys(KIND) as ItemKind[]
const STATUSES: ItemStatus[] = ['open', 'needs_answer', 'done', 'decided', 'dropped', 'superseded']
const PROJECT_STATUSES = Object.keys(PROJECT_STATUS) as ProjectStatus[]
const formatDate = (d: Date) => d.toISOString().split('T')[0]!
const TODAY = formatDate(new Date())
const TOMORROW = formatDate(new Date(Date.now() + 86400000))
const YESTERDAY = formatDate(new Date(Date.now() - 86400000))

const SAMPLE: Array<{ kind: ItemKind; text: string; status: ItemStatus; who: string; group?: boolean }> = [
  { kind: 'topic', text: 'Update on the building survey', status: 'open', who: 'Finance Committee', group: true },
  { kind: 'question', text: 'What is the lunch menu for the event?', status: 'needs_answer', who: 'Sarah, Tom, Ana' },
  { kind: 'action', text: 'Send the revised budget to the treasurer', status: 'open', who: 'Me' },
  { kind: 'decision', text: 'The retreat moves to the second week of May', status: 'decided', who: 'Staff', group: true },
]

/* The shared pieces in one place, for checking the look in light, dark and at
   phone width. Sample content only. */
/* A recurring calendar event nobody has prepped, with a stub waiting for it.
   The buttons are live actions and refuse: the event is not on any calendar. */
const EVENT: UpcomingEntry = {
  startsAt: new Date('2026-10-08T14:00:00Z'),
  event: {
    calendarId: 'sample',
    eventId: 'sample',
    seriesId: 'sample',
    title: 'Coffee with the bishop',
    startsAt: new Date('2026-10-08T14:00:00Z'),
    endsAt: new Date('2026-10-08T15:00:00Z'),
    allDay: false,
    attendees: [{ personId: 'sample', email: 'bishop@example.test', name: 'Bishop Wright', declined: false }],
    location: null,
    htmlLink: null,
  },
  meeting: null,
  series: null,
  stubs: [{ id: 'sample', title: 'Bishop Wright' } as MeetingView],
}

/* How each kind reads its parties: who leads, collaborators, and where the arrow points. */
const party = (role: ItemParty['role'], name: string, isSelf = false): ItemParty => ({
  type: 'person',
  id: name,
  name,
  role,
  isSelf,
})
const WHO: { kind: ItemKind; parties: ItemParty[] }[] = [
  { kind: 'action', parties: [party('owner', 'John', true), party('owner', 'Adlene Kufarimai'), party('with', 'Neil Carter')] },
  { kind: 'question', parties: [party('owner', 'Neil Carter')] },
  { kind: 'question', parties: [party('owner', 'John', true), party('with', 'Sarah Jones')] },
  { kind: 'decision', parties: [party('owner', 'Bishop Wright')] },
  { kind: 'topic', parties: [party('with', 'Sarah Jones')] },
]

/* Proposals as the review screen draws them. Their buttons are live actions
   and refuse: none of these is in the database. */
const PROPOSAL: ProposalView = {
  id: 'sample',
  meetingId: 'sample',
  noteId: null,
  runId: null,
  status: 'pending',
  payload: {
    type: 'item',
    kind: 'action',
    text: 'Send the revised budget to the treasurer',
    detail: 'Before the finance committee meets.',
    parties: [
      { role: 'owner', name: 'Sarah Jones', personId: 'sarah' },
      { role: 'with', name: 'the treasurer' },
    ],
    dueOn: TOMORROW,
  },
  verbatim: false,
  ownerGuessed: true,
  position: 0,
  parties: [
    { role: 'owner', name: 'Sarah Jones', type: 'person', id: 'sarah', unresolved: false },
    { role: 'with', name: 'the treasurer', type: null, id: null, unresolved: true },
  ],
  unresolved: ['the treasurer'],
  project: { id: 'sample', name: 'Budget' },
  series: null,
  agendaLine: null,
  item: null,
  parent: null,
  made: null,
  result: null,
  resolvedAt: null,
  createdAt: new Date('2026-10-01T15:00:00Z'),
}
const PROPOSALS: ProposalView[] = [
  PROPOSAL,
  {
    ...PROPOSAL,
    payload: { type: 'item', kind: 'decision', text: 'The retreat moves to the second week of May', parties: [] },
    verbatim: true,
    ownerGuessed: false,
    parties: [],
    unresolved: [],
    project: null,
    agendaLine: { id: 'sample', text: 'Retreat dates' },
  },
  {
    ...PROPOSAL,
    status: 'accepted',
    payload: {
      type: 'document',
      title: 'Retreat agenda, first draft',
      body: 'Friday\nArrive and supper\nCompline\n\nSaturday\nMorning session',
      projectId: 'sample',
    },
    ownerGuessed: false,
    parties: [],
    unresolved: [],
  },
]
const RUN = {
  id: 'sample',
  noteId: 'sample',
  contentHash: '',
  model: null,
  attempts: 1,
  output: null,
  startedAt: null,
  finishedAt: null,
  createdAt: new Date('2026-10-01T15:00:00Z'),
} satisfies Partial<Run>

export default function DesignPage() {
  return (
    <>
      <PageHeader title="Design" crumbs={[{ href: '/', label: 'Home' }]} actions={
          <Button>
            <Icon name="plus" className="h-4 w-4" />
            New
          </Button>
        }
      />

      <Section title="Tiles">
        <CardGrid>
          <Tile href="/design" icon="inbox" title="Inbox" tone="blue" count={4} />
          <Tile href="/design" icon="meeting" title="Meetings" tone="teal" />
          <Tile href="/design" icon="project" title="Projects" tone="purple" count={7} />
          <Tile href="/design" icon="person" title="People" tone="green" />
          <Tile href="/design" icon="group" title="Groups" tone="amber" />
        </CardGrid>
      </Section>

      <Section
        title="Items"
        count={SAMPLE.length}
        action={
          <Button variant="secondary" size="sm">
            <Icon name="plus" className="h-4 w-4" />
            Add
          </Button>
        }
      >
        <CardGrid>
          {SAMPLE.map((item) => (
            <Card key={item.text}>
              <div className="flex items-start gap-3">
                <KindIcon kind={item.kind} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{item.text}</p>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                      <Icon name={item.group ? 'group' : 'person'} className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{item.who}</span>
                    </span>
                    <StatusBadge status={item.status} />
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </CardGrid>
      </Section>

      <Section title="Cards">
        <CardGrid>
          <Card>
            <CardHeader title="Staff meeting" meta="Tue 9:00" aside={<Badge tone="teal">Weekly</Badge>} />
            <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
              <span className="flex items-center gap-1">
                <Icon name="clock" className="h-3.5 w-3.5" /> 60
              </span>
              <span className="flex items-center gap-1">
                <Icon name="group" className="h-3.5 w-3.5" /> 8
              </span>
            </div>
          </Card>
          <LinkCard href="/design">
            <CardHeader title="Capital campaign" meta="3 milestones" aside={<Badge tone="green">Active</Badge>} />
            <div className="flex gap-2">
              {KINDS.map((kind) => (
                <KindIcon key={kind} kind={kind} className="h-4 w-4" />
              ))}
            </div>
          </LinkCard>
          <EmptyState icon="project" action={{ label: 'New project', href: '/design' }} />
        </CardGrid>
      </Section>

      <Section title="Attendance">
        <Card>
          <RollCall
            action={sampleAction}
            meetingId="sample"
            entries={[
              { id: 'a', name: 'Sarah Jones', present: true },
              { id: 'b', name: 'Tom Baker', present: false, groupId: 'g' },
              { id: 'd', name: 'Ann Lee', present: true, groupId: 'g' },
            ]}
            groups={[{ id: 'g', name: 'Finance' }]}
            people={[{ value: 'c', name: 'Bishop Wright', icon: 'person' }]}
          />
        </Card>
        <Card className="mt-3">
          <div className="flex flex-wrap items-center gap-2">
            <Roster
              groups={[{ id: 'g', name: 'Finance' }]}
              attendees={[
                { id: 'a', name: 'Sarah Jones', groupId: null },
                { id: 'd', name: 'Ann Lee', groupId: 'g' },
                { id: 'e', name: 'Raj Patel', groupId: 'g' },
              ]}
            />
          </div>
        </Card>
      </Section>

      <Section title="Archive">
        <Card className="mb-3 flex flex-wrap items-center gap-3 !bg-gray-100 dark:!bg-gray-800/60">
          <Icon name="archive" className="h-5 w-5 text-gray-500 dark:text-gray-400" label="Archived" />
          <div className="min-w-0 flex-1" />
          <Button variant="secondary" size="sm">
            <Icon name="undo" className="h-4 w-4" />
            Restore
          </Button>
          <DeleteButton action={sampleAction} fields={{}} blockers={[]} takes={['Their name on 2 closed items']} />
          <DeleteButton action={sampleAction} fields={{}} blockers={['On 1 open item', 'On the Staff weekly roster']} takes={[]} />
        </Card>
      </Section>

      <CollapsedSection title="Later" icon="later" count={2}>
        <CardGrid>
          <Card>
            <CardHeader title="Reimagine the journal" meta="Jan 4" />
          </Card>
          <Card>
            <CardHeader title="Staff Christmas lunch" />
          </Card>
        </CardGrid>
      </CollapsedSection>

      <Section title="Kinds and status">
        <Card>
          <div className="flex flex-col gap-6">
            <div>
              <p className="mb-2 text-xs font-semibold text-gray-600 dark:text-gray-400">Kinds</p>
              <div className="flex flex-wrap items-center gap-3">
                {KINDS.map((kind) => (
                  <KindIcon key={kind} kind={kind} />
                ))}
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold text-gray-600 dark:text-gray-400">Item status</p>
              <div className="flex flex-wrap items-center gap-2">
                {STATUSES.map((status) => (
                  <StatusBadge key={status} status={status} />
                ))}
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold text-gray-600 dark:text-gray-400">Who</p>
              <div className="flex flex-col gap-2">
                {WHO.map(({ kind, parties }) => (
                  <div key={kind} className="flex items-center gap-2">
                    <KindIcon kind={kind} />
                    <PartyLine parties={parties} kind={kind} />
                  </div>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold text-gray-600 dark:text-gray-400">Project status</p>
              <div className="flex flex-wrap items-center gap-2">
                {PROJECT_STATUSES.map((status) => (
                  <ProjectStatusBadge key={status} status={status} />
                ))}
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold text-gray-600 dark:text-gray-400">Due date</p>
              <div className="flex flex-wrap items-center gap-2">
                <DueBadge label="Today" dueOn={TODAY} today={TODAY} open />
                <DueBadge label="Tomorrow" dueOn={TOMORROW} today={TODAY} open />
                <DueBadge label="Overdue" dueOn={YESTERDAY} today={TODAY} open />
                <DueBadge label="Done" dueOn={TODAY} today={TODAY} open={false} />
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold text-gray-600 dark:text-gray-400">Context (rows from several, on home)</p>
              <div className="flex flex-wrap items-center gap-2">
                <ContextBadge name="Conference" />
                <ContextBadge name="Church" />
              </div>
            </div>
          </div>
        </Card>
      </Section>

      <Section title="Icons">
        <Card>
          <div className="grid grid-cols-6 gap-4 sm:grid-cols-8 md:grid-cols-12">
            {(['topic', 'question', 'action', 'decision', 'person', 'group', 'project', 'meeting', 'inbox', 'clock', 'plus', 'close', 'menu', 'chevronDown', 'signOut', 'arrowRight', 'mutual', 'check', 'link', 'flag', 'pencil', 'trash', 'refresh', 'context', 'swatch', 'chevronUp', 'lock', 'copy', 'document', 'undo', 'section', 'sparkles', 'clipboard', 'alert', 'cog', 'later', 'archive'] as const).map((name) => (
              <div key={name} className="flex flex-col items-center gap-2">
                <Icon name={name} className="h-6 w-6 text-gray-600 dark:text-gray-400" />
                <span className="text-xs text-gray-500 dark:text-gray-500">{name}</span>
              </div>
            ))}
          </div>
        </Card>
      </Section>

      {/* The rule: one blue per screen; words always with an icon; housekeeping and rows icon only. */}
      <Section title="Buttons">
        <Card>
          <PageHeader
            title="Staff meeting"
            actions={
              <>
                <CopyButton label="Copy brief" variant="primary" text="# Staff meeting" html="<h1>Staff meeting</h1>" />
                <CopyButton label="Copy agenda" text="# Staff meeting" />
                <Button variant="secondary">
                  <Icon name="check" className="h-4 w-4" />
                  Review
                </Button>
              </>
            }
            tools={
              <>
                <FormModal action={sampleAction} title="Edit" icon="pencil" compact iconSize="md">
                  <Field label="Title">
                    <Input name="title" defaultValue="Staff meeting" />
                  </Field>
                </FormModal>
                <IconAction action={sampleAction} fields={{}} icon="arrowRight" label="Move" size="md" />
                <IconAction action={sampleAction} fields={{}} icon="archive" label="Archive" size="md" />
              </>
            }
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" size="sm">
              <Icon name="plus" className="h-4 w-4" />
              Add
            </Button>
            <Button variant="secondary" size="sm">
              <Icon name="undo" className="h-4 w-4" />
              Restore
            </Button>
            <Button variant="ghost">
              <Icon name="chevronDown" className="h-4 w-4" />
              More
            </Button>
            <Button disabled>
              <Icon name="check" className="h-4 w-4" />
              Save
            </Button>
            <Spinner />
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <IconAction action={sampleAction} fields={{}} icon="chevronUp" label="Move up" />
            <IconAction action={sampleAction} fields={{}} icon="chevronDown" label="Move down" />
            <FormModal action={sampleAction} title="Edit line" icon="pencil" compact>
              <Field label="Text">
                <Input name="text" defaultValue="Budget review" />
              </Field>
            </FormModal>
            <IconAction action={sampleAction} fields={{}} icon="close" label="Remove" />
            <FormModal action={sampleAction} title="Delete" icon="trash" compact submit="Delete" danger>
              {null}
            </FormModal>
            <IconAction action={sampleAction} fields={{}} icon="check" label="Discussed" tone="on" aria-pressed />
            <IconAction action={sampleAction} fields={{}} icon="check" label="Accept" tone="blue" />
            <Chip href="/design" icon="person">
              Sarah Jones
            </Chip>
            <Chip href="/design" icon="refresh">
              Staff meeting
            </Chip>
          </div>
        </Card>
      </Section>

      <Section title="Calendar events">
        <CardGrid>
          <EventCard entry={EVENT} time="9:00 AM" />
          <EventCard entry={{ ...EVENT, stubs: [], series: { id: 's', name: 'Staff weekly' } }} time="2:30 PM" />
        </CardGrid>
      </Section>

      <Section title="Unfiled">
        <CardGrid>
          <UnfiledCard
            note={{
              id: '00000000-0000-4000-8000-000000000000',
              title: 'Corridor chat',
              startsAt: new Date('2026-10-01T15:00:00Z'),
              endsAt: null,
              attendees: [{ email: 'sarah@example.test', name: 'Sarah Jones' }],
              receivedAt: new Date('2026-10-01T15:40:00Z'),
            }}
            contexts={[
              { id: 'a', name: 'Parish' },
              { id: 'b', name: 'Diocese' },
            ]}
            current="a"
            timeZone={null}
            match={{ id: 'm', title: 'Staff meeting', startsAt: new Date('2026-10-01T15:00:00Z'), sessions: [] }}
            choices={[
              { id: 'm', title: 'Staff meeting', startsAt: new Date('2026-10-01T15:00:00Z'), sessions: [] },
              {
                id: 'r',
                title: 'Retreat',
                startsAt: new Date('2026-10-02T14:00:00Z'),
                sessions: [{ id: 'r1', title: 'Day one', startsAt: new Date('2026-10-02T14:00:00Z'), endsAt: null }],
              },
            ]}
          />
          <UnfiledCard
            note={{
              id: '00000000-0000-4000-8000-000000000001',
              title: null,
              startsAt: null,
              endsAt: null,
              attendees: [],
              receivedAt: new Date('2026-10-01T15:40:00Z'),
            }}
            contexts={[{ id: 'a', name: 'Parish' }]}
            current="a"
            timeZone={null}
            match={null}
            choices={[]}
          />
        </CardGrid>
      </Section>

      <Section title="Form">
        <Card padding="md" className="max-w-xl">
          <div className="flex flex-col gap-4">
            <Field label="Title" required>
              <Input name="title" defaultValue="Ask about the audit timeline" />
            </Field>
            <Field label="Kind">
              <Select name="kind" defaultValue="question">
                {KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {KIND[kind].label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Detail">
              <Textarea name="detail" rows={3} />
            </Field>
            <WhenInputs starts="2026-10-07T09:00" ends="2026-10-09T17:00" />
          </div>
        </Card>
      </Section>

      <Section title="Picking and removing">
        <Card padding="md" className="max-w-xl">
          <div className="flex flex-col gap-4">
            <PartyRoles itemId="sample" kind="action" parties={WHO[0]!.parties} move={sampleAction} remove={sampleAction}>
              <IconButton icon="plus" label="People" />
            </PartyRoles>
            <div className="flex flex-wrap items-center gap-2">
              <RemovableChip
                icon="person"
                href="/design"
                remove={{ action: sampleAction, fields: {}, label: 'Remove Sarah Jones' }}
              >
                Sarah Jones
              </RemovableChip>
              <RemovableChip
                icon="project"
                href="/design"
                remove={{ action: sampleAction, fields: {}, label: 'Remove Retreat' }}
              >
                Retreat
              </RemovableChip>
              <FormModal
                action={sampleAction}
                title="Delete Staff meeting?"
                icon="trash"
                variant="ghost"
                size="sm"
                submit="Delete"
                danger
              />
            </div>
            <CheckList
              label="People"
              name="personIds"
              selected={['2']}
              options={[
                { id: '1', name: 'Sarah Jones' },
                { id: '2', name: 'Tom Baker' },
                { id: '3', name: 'Bishop Wright' },
              ]}
            />
            <ActionSelect
              action={sampleAction}
              fields={{}}
              name="contextId"
              value=""
              label="Context"
              className="!w-44"
            >
              <option value="">—</option>
              <option value="1">Parish</option>
              <option value="2">Diocese</option>
            </ActionSelect>
          </div>
        </Card>
      </Section>

      <Section title="Moving">
        <Card>
          <div className="flex flex-col gap-4">
            <MoveTo
              action={sampleAction}
              id="sample"
              contexts={[
                { id: 'a', name: 'Parish' },
                { id: 'b', name: 'Diocese' },
              ]}
            />
            <LivesIn title="Coffee with the bishop" context={{ id: 'b', name: 'Diocese' }} action={sampleAction} id="sample" />
          </div>
        </Card>
      </Section>

      <Section title="Review">
        <div className="flex flex-col gap-4">
          <Card>
            <div className="flex flex-wrap items-center gap-2">
              <RunState run={{ ...RUN, status: 'done', error: null }} meetingId="sample" />
              <RunState
                run={{ ...RUN, status: 'failed', error: 'The model did not answer.' }}
                meetingId="sample"
              />
            </div>
          </Card>
          <CardGrid>
            {PROPOSALS.map((proposal, index) => (
              <ProposalCard
                key={index}
                proposal={proposal}
                choices={{ people: [{ id: 'sarah', name: 'Sarah Jones' }], groups: [], projects: [] }}
                today={TODAY}
                selfId="me"
              />
            ))}
          </CardGrid>
          <CardGrid>
            <MeetingCard
              meeting={{
                id: 'sample',
                title: 'Coffee with the bishop',
                startsAt: null,
                people: [{ name: 'Bishop Wright' }],
              }}
              when="Oct 1, 9:00 AM"
              pending={3}
            />
            <DocumentCard
              title="Retreat agenda, first draft"
              body={'Friday\nArrive and supper\nCompline\n\nSaturday\nMorning session'}
              meta="Oct 1"
            />
            <Card>
              <div className="flex flex-col gap-3">
                <PartyPicker
                  label="People"
                  name="people"
                  options={[
                    { value: 'person:sarah', name: 'Sarah Jones', icon: 'person' },
                    { value: 'person:tom', name: 'Tom Baker', icon: 'person' },
                    { value: 'group:staff', name: 'Staff', icon: 'group' },
                  ]}
                  selected={[{ value: 'person:sarah', name: 'Sarah Jones', icon: 'person' }]}
                />
                <PartyPicker
                  label="Members"
                  name="members"
                  options={[
                    { value: 'sarah', name: 'Sarah Jones', icon: 'person' },
                    { value: 'tom', name: 'Tom Baker', icon: 'person' },
                  ]}
                  allowNew
                />
                <div>
                  <PendingBadge count={3} />
                </div>
              </div>
            </Card>
          </CardGrid>
        </div>
      </Section>

      <Section title="Overlays">
        <Interactive />
      </Section>
    </>
  )
}
