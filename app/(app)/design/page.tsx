import { Button } from '@/components/ui/Button'
import { Card, CardGrid, CardHeader, LinkCard, Section, Tile } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Field, Input, Select, Textarea } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import { PageHeader } from '@/components/ui/PageHeader'
import { Spinner } from '@/components/ui/Spinner'
import {
  Badge,
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
export default function DesignPage() {
  return (
    <>
      <PageHeader title="Design" actions={<Button>New</Button>} />

      <Section title="Tiles">
        <CardGrid>
          <Tile href="/design" icon="inbox" title="Inbox" tone="blue" count={4} />
          <Tile href="/design" icon="meeting" title="Meetings" tone="teal" />
          <Tile href="/design" icon="project" title="Projects" tone="purple" count={7} />
          <Tile href="/design" icon="person" title="People" tone="green" />
          <Tile href="/design" icon="group" title="Groups" tone="amber" />
        </CardGrid>
      </Section>

      <Section title="Items" count={SAMPLE.length} action={<Button size="sm">Add</Button>}>
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
          </div>
        </Card>
      </Section>

      <Section title="Icons">
        <Card>
          <div className="grid grid-cols-6 gap-4 sm:grid-cols-8 md:grid-cols-12">
            {(['topic', 'question', 'action', 'decision', 'person', 'group', 'project', 'meeting', 'inbox', 'clock', 'plus', 'close', 'menu', 'chevronDown', 'signOut', 'arrowRight', 'check', 'link', 'flag', 'pencil', 'trash', 'refresh', 'context', 'swatch'] as const).map((name) => (
              <div key={name} className="flex flex-col items-center gap-2">
                <Icon name={name} className="h-6 w-6 text-gray-600 dark:text-gray-400" />
                <span className="text-xs text-gray-500 dark:text-gray-500">{name}</span>
              </div>
            ))}
          </div>
        </Card>
      </Section>

      <Section title="Buttons">
        <Card>
          <div className="flex flex-wrap items-center gap-3">
            <Button>Save</Button>
            <Button variant="secondary">Cancel</Button>
            <Button variant="accent">Copy</Button>
            <Button variant="ghost">Edit</Button>
            <Button variant="destructive">Delete</Button>
            <Button size="sm">Add</Button>
            <Button disabled>Save</Button>
            <Spinner />
          </div>
        </Card>
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
          </div>
        </Card>
      </Section>

      <Section title="Overlays">
        <Interactive />
      </Section>
    </>
  )
}
