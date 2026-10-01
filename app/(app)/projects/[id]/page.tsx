import { notFound } from 'next/navigation'
import { ActionButton, FormModal } from '@/components/forms'
import { ItemGrid } from '@/components/items/ItemCard'
import { QuickAdd } from '@/components/QuickAdd'
import { Card, Section } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Field, Input, Select, Textarea } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import { PageHeader } from '@/components/ui/PageHeader'
import { DueBadge, PROJECT_STATUS, ProjectStatusBadge } from '@/components/ui/StatusBadge'
import { formatDay } from '@/lib/core/dates'
import { isUuid } from '@/lib/core/match'
import { NotFoundError } from '@/lib/core/types'
import { db } from '@/lib/db'
import { isOpen, listItems, type ItemView } from '@/lib/items/items'
import {
  PROJECT_STATUSES,
  getProject,
  listLinks,
  listMilestones,
} from '@/lib/projects/projects'
import { viewer } from '@/lib/web/context'
import {
  addLinkAction,
  addMilestoneAction,
  deleteLinkAction,
  deleteMilestoneAction,
  toggleMilestoneAction,
  updateProjectAction,
} from '../../actions'

type OwnerGroup = { key: string; name: string; group: boolean; items: ItemView[] }

/* Owed items under each party that owes them. An item with several owners
   appears under each; one with none is gathered at the end. */
function byOwner(items: ItemView[]): OwnerGroup[] {
  const groups = new Map<string, OwnerGroup>()
  const unowned: ItemView[] = []

  for (const item of items) {
    const owners = item.parties.filter((party) => party.role === 'owner')
    if (owners.length === 0) unowned.push(item)
    for (const owner of owners) {
      const entry = groups.get(owner.id) ?? {
        key: owner.id,
        name: owner.isSelf ? 'Me' : owner.name,
        group: owner.type === 'group',
        items: [],
      }
      entry.items.push(item)
      groups.set(owner.id, entry)
    }
  }

  const sorted = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))
  if (unowned.length > 0) sorted.push({ key: 'none', name: '—', group: false, items: unowned })
  return sorted
}

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) notFound()

  const { today } = await viewer()
  const project = await getProject(db, id).catch((err) => {
    if (err instanceof NotFoundError) notFound()
    throw err
  })

  const milestones = await listMilestones(db, id)
  const links = await listLinks(db, id)
  const all = await listItems(db, { contextId: project.contextId, projectId: id })

  const open = all.filter(isOpen)
  const owed = open.filter((item) => item.kind === 'question' || item.kind === 'action')
  const topics = open.filter((item) => item.kind === 'topic')
  const decisions = all.filter((item) => item.kind === 'decision')
  const closed = all.filter((item) => item.kind !== 'decision' && !isOpen(item)).slice(0, 6)

  return (
    <>
      <PageHeader
        title={project.name}
        actions={
          <div className="flex items-center gap-3">
            <ProjectStatusBadge status={project.status} />
            <FormModal action={updateProjectAction} title="Edit" label="Edit" variant="secondary">
              <input type="hidden" name="id" value={project.id} />
              <Field label="Name" required>
                <Input name="name" defaultValue={project.name} required />
              </Field>
              <Field label="Status">
                <Select name="status" defaultValue={project.status}>
                  {PROJECT_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {PROJECT_STATUS[status].label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Description">
                <Textarea name="description" rows={4} defaultValue={project.description ?? ''} />
              </Field>
            </FormModal>
          </div>
        }
      />

      {project.description ? (
        <Card className="mb-8">
          <p className="whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300">
            {project.description}
          </p>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-x-4 lg:grid-cols-2">
        <Section
          title="Milestones"
          count={milestones.length}
          action={
            <FormModal action={addMilestoneAction} title="New milestone" label="Add" size="sm" submit="Add">
              <input type="hidden" name="projectId" value={project.id} />
              <Field label="Title" required>
                <Input name="title" required />
              </Field>
              <Field label="Date">
                <Input name="dueOn" type="date" />
              </Field>
            </FormModal>
          }
        >
          {milestones.length === 0 ? (
            <EmptyState icon="flag" />
          ) : (
            <Card>
              <ul className="divide-y divide-gray-100 dark:divide-gray-700">
                {milestones.map((milestone) => {
                  const done = milestone.doneAt !== null
                  return (
                    <li key={milestone.id} className="flex items-center gap-2 py-2 first:pt-0 last:pb-0">
                      <ActionButton
                        action={toggleMilestoneAction}
                        fields={{ id: milestone.id, done: String(!done) }}
                        variant="ghost"
                        size="sm"
                        aria-label={done ? 'Mark not done' : 'Mark done'}
                        aria-pressed={done}
                        className={
                          done
                            ? '!text-green-600 dark:!text-green-400'
                            : '!text-gray-300 dark:!text-gray-600'
                        }
                      >
                        <Icon name="action" className="h-5 w-5" />
                      </ActionButton>
                      <span
                        className={`min-w-0 flex-1 truncate text-sm font-medium ${
                          done
                            ? 'text-gray-500 line-through dark:text-gray-400'
                            : 'text-gray-900 dark:text-gray-100'
                        }`}
                      >
                        {milestone.title}
                      </span>
                      {milestone.dueOn ? (
                        <DueBadge
                          label={formatDay(milestone.dueOn, today)}
                          dueOn={milestone.dueOn}
                          today={today}
                          open={!done}
                        />
                      ) : null}
                      <ActionButton
                        action={deleteMilestoneAction}
                        fields={{ id: milestone.id }}
                        variant="ghost"
                        size="sm"
                        aria-label={`Delete ${milestone.title}`}
                      >
                        <Icon name="trash" className="h-4 w-4" />
                      </ActionButton>
                    </li>
                  )
                })}
              </ul>
            </Card>
          )}
        </Section>

        <Section
          title="Links"
          count={links.length}
          action={
            <FormModal action={addLinkAction} title="New link" label="Add" size="sm" submit="Add">
              <input type="hidden" name="projectId" value={project.id} />
              <Field label="URL" required>
                <Input name="url" required inputMode="url" />
              </Field>
              <Field label="Label">
                <Input name="label" />
              </Field>
            </FormModal>
          }
        >
          {links.length === 0 ? (
            <EmptyState icon="link" />
          ) : (
            <Card>
              <ul className="divide-y divide-gray-100 dark:divide-gray-700">
                {links.map((link) => (
                  <li key={link.id} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
                    <Icon name="link" className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" />
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noreferrer"
                      className="min-w-0 flex-1 truncate text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
                    >
                      {link.label}
                    </a>
                    <ActionButton
                      action={deleteLinkAction}
                      fields={{ id: link.id }}
                      variant="ghost"
                      size="sm"
                      aria-label={`Delete ${link.label}`}
                    >
                      <Icon name="trash" className="h-4 w-4" />
                    </ActionButton>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </Section>
      </div>

      <Section
        title="Owed"
        count={owed.length}
        action={<QuickAdd presets={{ kind: 'action', projectId: id }} />}
      >
        {owed.length === 0 ? (
          <EmptyState icon="action" />
        ) : (
          <div className="flex flex-col gap-5">
            {byOwner(owed).map((owner) => (
              <div key={owner.key}>
                <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-gray-600 dark:text-gray-300">
                  <Icon name={owner.group ? 'group' : 'person'} className="h-4 w-4" />
                  {owner.name}
                </h3>
                <ItemGrid items={owner.items} today={today} empty="action" showProject={false} />
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Topics"
        count={topics.length}
        action={<QuickAdd presets={{ kind: 'topic', projectId: id }} />}
      >
        <ItemGrid items={topics} today={today} empty="topic" showProject={false} />
      </Section>

      <Section
        title="Decisions"
        count={decisions.length}
        action={<QuickAdd presets={{ kind: 'decision', projectId: id }} />}
      >
        <ItemGrid items={decisions} today={today} empty="decision" showProject={false} />
      </Section>

      {closed.length > 0 ? (
        <Section title="Closed">
          <ItemGrid items={closed} today={today} empty="check" showProject={false} />
        </Section>
      ) : null}
    </>
  )
}
