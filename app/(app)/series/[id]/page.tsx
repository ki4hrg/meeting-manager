import { notFound } from 'next/navigation'
import { ActionButton, FormModal } from '@/components/forms'
import { LivesIn, MoveTo } from '@/components/meetings/Move'
import { SkeletonEditor } from '@/components/series/SkeletonEditor'
import { Card, CardGrid, CardHeader, LinkCard, Section } from '@/components/ui/Card'
import { PartyPicker } from '@/components/processing/PartyPicker'
import { CheckList } from '@/components/ui/CheckList'
import { Chip } from '@/components/ui/Chip'
import { EmptyState } from '@/components/ui/EmptyState'
import { Field, Input, Select } from '@/components/ui/Field'
import { Icon, type IconName } from '@/components/ui/icons'
import { PageHeader } from '@/components/ui/PageHeader'
import { RemovableChip } from '@/components/ui/RemovableChip'
import { Badge } from '@/components/ui/StatusBadge'
import { getAgenda } from '@/lib/agenda/lines'
import { formatMoment } from '@/lib/core/dates'
import { isUuid } from '@/lib/core/match'
import { NotFoundError } from '@/lib/core/types'
import { db } from '@/lib/db'
import type { BlockSettings } from '@/lib/db/schema'
import { listGroups } from '@/lib/directory/groups'
import { listPeople } from '@/lib/directory/people'
import { listMeetings, nextOccurrence } from '@/lib/meetings/meetings'
import { outOfStep } from '@/lib/meetings/roster'
import { getSeries } from '@/lib/meetings/series'
import { listProjects } from '@/lib/projects/projects'
import { allContexts, requireContext, viewer } from '@/lib/web/context'
import {
  addSeriesPeopleAction,
  addSeriesProjectsAction,
  deleteSeriesAction,
  moveSeriesAction,
  openSeriesAction,
  prepNextInSeriesAction,
  removeSeriesPersonAction,
  removeSeriesProjectAction,
  setSeriesBlockAction,
  unlinkSeriesCalendarAction,
  updateSeriesAction,
  syncRosterAction,
} from '../actions'

const BLOCKS: Array<{ block: keyof BlockSettings; icon: IconName; label: string }> = [
  { block: 'followUps', icon: 'action', label: 'Follow-ups due' },
  { block: 'sinceLast', icon: 'undo', label: 'Since last time' },
  { block: 'lookahead', icon: 'flag', label: 'Lookahead' },
]

/* How much of the next agenda the hub shows before it is a link's job. */
const PREVIEW = 6

export default async function SeriesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) notFound()

  const context = await requireContext()
  const { user } = await viewer()
  const series = await getSeries(db, id).catch((err) => {
    if (err instanceof NotFoundError) notFound()
    throw err
  })
  /* As a meeting does: with another context selected, only its name and the
     way to where it lives. */
  const contexts = await allContexts()
  if (series.contextId !== context.id) {
    const home = contexts.find((one) => one.id === series.contextId)
    if (!home) notFound()
    return <LivesIn title={series.name} context={home} action={openSeriesAction} id={series.id} />
  }

  const groups = await listGroups(db, context.id)
  const onRoster = new Set(series.people.map((person) => person.id))
  const otherPeople = (await listPeople(db)).filter(
    (person) => !person.isSelf && !onRoster.has(person.id),
  )
  const linked = new Set(series.projects.map((project) => project.id))
  const otherProjects = (await listProjects(db, context.id)).filter(
    (project) => !linked.has(project.id),
  )

  /* The next dated occurrence, or failing that a stub waiting for its date:
     the same meeting "Prep next" would hand back. */
  const [stub] = await listMeetings(db, { contextId: context.id, seriesId: id, when: 'stubs', limit: 1 })
  const next = (await nextOccurrence(db, id)) ?? stub ?? null
  const history = await listMeetings(db, { contextId: context.id, seriesId: id, when: 'past' })
  const behind = await outOfStep(db, id)

  // Sections and their lines as one flat list, for the preview.
  const agenda = next ? await getAgenda(db, next.id, { timeZone: user.timeZone }) : null
  const rows = (agenda?.nodes ?? []).flatMap((node) =>
    node.type === 'section'
      ? [
          { id: node.id, text: node.title, section: true },
          ...node.lines.map((line) => ({ id: line.id, text: line.text, section: false })),
        ]
      : [{ id: node.id, text: node.text, section: false }],
  )

  return (
    <>
      <PageHeader
        title={series.name}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {series.group ? (
              <Chip icon="group" href={`/groups/${series.group.id}`}>
                {series.group.name}
              </Chip>
            ) : null}
            {series.calendarSeriesId ? (
              <RemovableChip
                icon="meeting"
                iconLabel="On the calendar"
                remove={{
                  action: unlinkSeriesCalendarAction,
                  fields: { id: series.id },
                  label: 'Unlink calendar',
                }}
              >
                <Icon name="link" className="h-3.5 w-3.5" />
              </RemovableChip>
            ) : null}
            <FormModal action={updateSeriesAction} title="Edit" label="Edit" variant="secondary">
              <input type="hidden" name="id" value={series.id} />
              <Field label="Name" required>
                <Input name="name" defaultValue={series.name} required />
              </Field>
              <Field label="Group">
                <Select name="groupId" defaultValue={series.group?.id ?? ''}>
                  <option value="">—</option>
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </FormModal>
            <MoveTo
              action={moveSeriesAction}
              id={series.id}
              contexts={contexts.filter((one) => one.id !== context.id)}
            />
            <FormModal
              action={deleteSeriesAction}
              title={`Delete ${series.name}?`}
              icon="trash"
              variant="ghost"
              submit="Delete"
              danger
            >
              <input type="hidden" name="id" value={series.id} />
            </FormModal>
          </div>
        }
      />

      <Section
        title="Next"
        action={
          next ? null : (
            <ActionButton action={prepNextInSeriesAction} fields={{ id: series.id }} size="sm">
              Prep next
            </ActionButton>
          )
        }
      >
        {next ? (
          <LinkCard href={`/meetings/${next.id}`}>
            <CardHeader
              title={next.title}
              aside={
                next.startsAt ? (
                  <Badge tone="teal">{formatMoment(next.startsAt, user.timeZone)}</Badge>
                ) : null
              }
            />
            {rows.length > 0 ? (
              <ul className="flex flex-col gap-1 text-sm">
                {rows.slice(0, PREVIEW).map((row) => (
                  <li
                    key={row.id}
                    className={
                      row.section
                        ? 'truncate font-semibold text-gray-900 dark:text-gray-100'
                        : 'truncate pl-3 text-gray-600 dark:text-gray-300'
                    }
                  >
                    {row.text}
                  </li>
                ))}
                {rows.length > PREVIEW ? (
                  <li className="pl-3 text-xs tabular-nums text-gray-500 dark:text-gray-400">
                    +{rows.length - PREVIEW}
                  </li>
                ) : null}
              </ul>
            ) : null}
          </LinkCard>
        ) : (
          <EmptyState icon="meeting" />
        )}
      </Section>

      <div className="grid grid-cols-1 gap-x-4 lg:grid-cols-2">
        <Section
          title="Roster"
          count={series.people.length}
          action={
            <FormModal action={addSeriesPeopleAction} title="Add to roster" label="Add" size="sm" submit="Add">
              <input type="hidden" name="id" value={series.id} />
              <PartyPicker
                label="People"
                name="personIds"
                options={otherPeople.map((person) => ({ value: person.id, name: person.name, icon: 'person' }))}
                allowNew
              />
            </FormModal>
          }
        >
          {series.people.length === 0 ? (
            <EmptyState icon="person" />
          ) : (
            <Card>
              <div className="flex flex-wrap gap-2">
                {series.people.map((person) => (
                  <RemovableChip
                    key={person.id}
                    icon="person"
                    href={`/people/${person.id}`}
                    remove={{
                      action: removeSeriesPersonAction,
                      fields: { id: series.id, personId: person.id },
                      label: `Remove ${person.name}`,
                    }}
                  >
                    {person.name}
                  </RemovableChip>
                ))}
              </div>
            </Card>
          )}
          {/* Meetings edited by hand do not follow the roster on their own. */}
          {behind.length > 0 ? (
            <div className="mt-3 flex justify-end">
              <ActionButton action={syncRosterAction} fields={{ id: series.id }} variant="secondary" size="sm">
                <Icon name="refresh" className="h-4 w-4" />
                {`Update ${behind.length} upcoming`}
              </ActionButton>
            </div>
          ) : null}
        </Section>

        <Section
          title="Projects"
          count={series.projects.length}
          action={
            otherProjects.length > 0 ? (
              <FormModal action={addSeriesProjectsAction} title="Add projects" label="Add" size="sm" submit="Add">
                <input type="hidden" name="id" value={series.id} />
                <CheckList label="Projects" name="projectIds" options={otherProjects} />
              </FormModal>
            ) : null
          }
        >
          {series.projects.length === 0 ? (
            <EmptyState icon="project" />
          ) : (
            <Card>
              <div className="flex flex-wrap gap-2">
                {series.projects.map((project) => (
                  <RemovableChip
                    key={project.id}
                    icon="project"
                    href={`/projects/${project.id}`}
                    remove={{
                      action: removeSeriesProjectAction,
                      fields: { id: series.id, projectId: project.id },
                      label: `Remove ${project.name}`,
                    }}
                  >
                    {project.name}
                  </RemovableChip>
                ))}
              </div>
            </Card>
          )}
        </Section>
      </div>

      <SkeletonEditor seriesId={series.id} skeleton={series.skeleton} />

      <Section title="Blocks">
        <Card>
          <div className="flex items-center gap-2">
            {BLOCKS.map(({ block, icon, label }) => {
              const on = series.blocks[block]
              return (
                <ActionButton
                  key={block}
                  action={setSeriesBlockAction}
                  fields={{ id: series.id, block, on: String(!on) }}
                  variant={on ? 'primary' : 'secondary'}
                  size="sm"
                  aria-label={label}
                  aria-pressed={on}
                  title={label}
                >
                  <Icon name={icon} className="h-4 w-4" />
                </ActionButton>
              )
            })}
          </div>
        </Card>
      </Section>

      <Section title="History" count={history.length}>
        {history.length === 0 ? (
          <EmptyState icon="clock" />
        ) : (
          <CardGrid>
            {history.map((meeting) => (
              <LinkCard key={meeting.id} href={`/meetings/${meeting.id}`}>
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {meeting.title}
                  </span>
                  {meeting.startsAt ? (
                    <Badge>{formatMoment(meeting.startsAt, user.timeZone)}</Badge>
                  ) : null}
                </div>
              </LinkCard>
            ))}
          </CardGrid>
        )}
      </Section>
    </>
  )
}
