import Link from 'next/link'
import { notFound } from 'next/navigation'
import { DocumentCard } from '@/components/documents/DocumentCard'
import { ActionButton, FormModal } from '@/components/forms'
import { ItemGrid } from '@/components/items/ItemCard'
import { MeetingGrid } from '@/components/meetings/MeetingCard'
import { QuickAdd } from '@/components/QuickAdd'
import { Card, CardGrid, CardHeader, LinkCard, Section } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Field, Input, Select, Textarea } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import { Markdown } from '@/components/ui/Markdown'
import { PageHeader } from '@/components/ui/PageHeader'
import { DueBadge, PROJECT_STATUS, ProjectStatusBadge } from '@/components/ui/StatusBadge'
import { formatDay, todayIn } from '@/lib/core/dates'
import { isUuid } from '@/lib/core/match'
import { NotFoundError } from '@/lib/core/types'
import { db } from '@/lib/db'
import { listDocuments } from '@/lib/documents/documents'
import { isOpen, listItems, type ItemView } from '@/lib/items/items'
import { listMeetings } from '@/lib/meetings/meetings'
import {
  PROJECT_STATUSES,
  ancestorIds,
  descendantIds,
  getProject,
  indented,
  listLinks,
  listMilestones,
  listProjects,
  nextMilestones,
  treeOrder,
} from '@/lib/projects/projects'
import { viewer } from '@/lib/web/context'
import {
  addLinkAction,
  addMilestoneAction,
  createProjectAction,
  deleteLinkAction,
  deleteMilestoneAction,
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

type Search = Promise<Record<string, string | string[] | undefined>>

export default async function ProjectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Search }) {
  const { id } = await params
  if (!isUuid(id)) notFound()

  const { user, today } = await viewer()
  const project = await getProject(db, id).catch((err) => {
    if (err instanceof NotFoundError) notFound()
    throw err
  })

  const milestones = await listMilestones(db, id)
  // Upcoming by date, then undated, then past ones, latest first.
  const ordered = [
    ...milestones.filter((m) => m.dueOn !== null && m.dueOn >= today),
    ...milestones.filter((m) => m.dueOn === null),
    ...milestones.filter((m) => m.dueOn !== null && m.dueOn < today).reverse(),
  ]
  const links = await listLinks(db, id)

  /* The tree around it: the projects above (a trail back up) and the ones
     directly within it. "Sub-projects" rolls theirs, at any depth, into this
     page's items and meetings, each item naming its own project. */
  const family = await listProjects(db, project.contextId)
  const byId = new Map(family.map((one) => [one.id, one]))
  const trail = [...ancestorIds(family, [id])].map((one) => byId.get(one)!).reverse()
  const children = family.filter((one) => one.parentId === id).sort((a, b) => a.name.localeCompare(b.name))
  const nextOf = await nextMilestones(db, project.contextId, today)
  const below = descendantIds(family, [id])
  const rolled = children.length > 0 && (await searchParams).all === '1'
  const scope = rolled ? [id, ...below] : [id]

  const all = (
    await Promise.all(scope.map((projectId) => listItems(db, { contextId: project.contextId, projectId })))
  )
    .flat()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  const seen = new Set<string>()
  const meetings = (
    await Promise.all(scope.map((projectId) => listMeetings(db, { contextId: project.contextId, projectId })))
  )
    .flat()
    .filter((meeting) => !seen.has(meeting.id) && Boolean(seen.add(meeting.id)))
  const documents = await listDocuments(db, { contextId: project.contextId, projectId: id })
  // Aimed at this project's next meeting, waiting for it, whatever project they are on.
  const forNext = (await listItems(db, { contextId: project.contextId, open: true })).filter(
    (item) => item.targetProjectId === id,
  )
  // A parent can be anything in the context but itself and what sits inside it.
  const parents = treeOrder(family).filter((one) => one.id !== id && !below.has(one.id))

  const open = all.filter(isOpen)
  const owed = open.filter((item) => item.kind === 'question' || item.kind === 'action')
  const topics = open.filter((item) => item.kind === 'topic')
  const decisions = all.filter((item) => item.kind === 'decision')
  const closed = all.filter((item) => item.kind !== 'decision' && !isOpen(item)).slice(0, 6)

  return (
    <>
      <PageHeader
        title={project.name}
        crumbs={[
          { href: '/projects', label: 'Projects' },
          ...trail.map((one) => ({ href: `/projects/${one.id}`, label: one.name })),
        ]}
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
              <Field label="Within">
                <Select name="parentId" defaultValue={project.parentId ?? ''}>
                  <option value="">—</option>
                  {parents.map((one) => (
                    <option key={one.id} value={one.id}>
                      {indented(one)}
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
          <Markdown source={project.description} className="text-sm text-gray-700 dark:text-gray-300" />
        </Card>
      ) : null}

      <Section
        title="Sub-projects"
        count={children.length}
        action={
          <div className="flex items-center gap-2">
            {children.length > 0 ? (
              <Link
                href={rolled ? `/projects/${id}` : `/projects/${id}?all=1`}
                aria-pressed={rolled}
                title="Include sub-projects"
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                  rolled
                    ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
                }`}
              >
                <Icon name="project" className="h-3.5 w-3.5" />
                {rolled ? <Icon name="check" className="h-3.5 w-3.5" label="Included" /> : <Icon name="plus" className="h-3.5 w-3.5" label="Include" />}
              </Link>
            ) : null}
            <FormModal action={createProjectAction} title="New sub-project" label="New" size="sm" submit="Create">
              <input type="hidden" name="parentId" value={project.id} />
              <Field label="Name" required>
                <Input name="name" required />
              </Field>
            </FormModal>
          </div>
        }
      >
        {children.length === 0 ? null : (
          <CardGrid>
            {children.map((child) => {
              const next = nextOf.get(child.id)
              return (
                <LinkCard key={child.id} href={`/projects/${child.id}`}>
                  <CardHeader title={child.name} aside={<ProjectStatusBadge status={child.status} />} />
                  {next?.dueOn ? (
                    <span className="flex min-w-0 items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                      <Icon name="flag" className="h-3.5 w-3.5 shrink-0" label="Next milestone" />
                      <span className="truncate">{next.title}</span>
                      <DueBadge label={formatDay(next.dueOn, today)} dueOn={next.dueOn} today={today} />
                    </span>
                  ) : null}
                </LinkCard>
              )
            })}
          </CardGrid>
        )}
      </Section>

      {forNext.length > 0 ? (
        <Section title="For the next meeting" count={forNext.length}>
          <ItemGrid items={forNext} today={today} empty="meeting" />
        </Section>
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
                {ordered.map((milestone) => {
                  const past = milestone.dueOn !== null && milestone.dueOn < today
                  return (
                    <li key={milestone.id} className="flex items-center gap-2 py-2 first:pt-0 last:pb-0">
                      <Icon
                        name="flag"
                        className={`h-4 w-4 shrink-0 ${
                          past ? 'text-gray-300 dark:text-gray-600' : 'text-gray-400 dark:text-gray-500'
                        }`}
                      />
                      <span
                        className={`min-w-0 flex-1 truncate text-sm font-medium ${
                          past ? 'text-gray-500 dark:text-gray-400' : 'text-gray-900 dark:text-gray-100'
                        }`}
                      >
                        {milestone.title}
                      </span>
                      {milestone.dueOn ? (
                        <DueBadge
                          label={formatDay(milestone.dueOn, today)}
                          dueOn={milestone.dueOn}
                          today={today}
                          open={!past}
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

      {/* Made by accepting a proposal, so with none there is nothing here to fill. */}
      {documents.length > 0 ? (
        <Section title="Documents" count={documents.length}>
          <CardGrid>
            {documents.map((document) => (
              <DocumentCard
                key={document.id}
                title={document.title}
                body={document.body}
                meta={formatDay(todayIn(user.timeZone, document.updatedAt), today)}
              />
            ))}
          </CardGrid>
        </Section>
      ) : null}

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
                <ItemGrid items={owner.items} today={today} empty="action" showProject={rolled} />
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
        <ItemGrid items={topics} today={today} empty="topic" showProject={rolled} />
      </Section>

      <Section
        title="Decisions"
        count={decisions.length}
        action={<QuickAdd presets={{ kind: 'decision', projectId: id }} />}
      >
        <ItemGrid items={decisions} today={today} empty="decision" showProject={rolled} />
      </Section>

      <Section title="Meetings">
        <MeetingGrid meetings={meetings} timeZone={user.timeZone} recent={9} />
      </Section>

      {closed.length > 0 ? (
        <Section title="Closed">
          <ItemGrid items={closed} today={today} empty="check" showProject={rolled} />
        </Section>
      ) : null}
    </>
  )
}
