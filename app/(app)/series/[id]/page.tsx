import { ArchiveButton, ArchivedBar, Muted } from '@/components/archive/Archive'
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
import { formatMoment, formatTime } from '@/lib/core/dates'
import { isUuid } from '@/lib/core/match'
import { NotFoundError } from '@/lib/core/types'
import { db } from '@/lib/db'
import type { BlockSettings } from '@/lib/db/schema'
import { listGroups } from '@/lib/directory/groups'
import { listPeople } from '@/lib/directory/people'
import { listMeetings, nextOccurrence } from '@/lib/meetings/meetings'
import { calendarLinkOf, unlinkedRecurring } from '@/lib/meetings/prep'
import { outOfStep } from '@/lib/meetings/roster'
import { getSeries } from '@/lib/meetings/series'
import { listProjectChoices } from '@/lib/projects/projects'
import { allContexts, requireContext, viewer } from '@/lib/web/context'
import {
  addSeriesPeopleAction,
  addSeriesProjectsAction,
  moveSeriesAction,
  openSeriesAction,
  prepNextInSeriesAction,
  removeSeriesPersonAction,
  removeSeriesProjectAction,
  setSeriesBlockAction,
  updateSeriesAction,
  syncRosterAction,
  rosterFromCalendarAction,
  rosterInviteeAction,
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
  const otherProjects = (await listProjectChoices(db, context.id)).filter(
    (project) => !linked.has(project.id),
  )

  /* The next dated occurrence, or failing that a stub waiting for its date:
     the same meeting "Prep next" would hand back. */
  const [stub] = await listMeetings(db, { contextId: context.id, seriesId: id, when: 'stubs', limit: 1 })
  const next = (await nextOccurrence(db, id)) ?? stub ?? null
  const history = await listMeetings(db, { contextId: context.id, seriesId: id, when: 'past' })
  const behind = await outOfStep(db, id)
  const link = await calendarLinkOf(db, series)
  const linkable = link ? [] : await unlinkedRecurring(db, context.id)
  const allPeople = await listPeople(db)
  const self = allPeople.find((person) => person.isSelf)
  // Invited on the calendar and in nobody's directory entry: each can be added in one step.
  const strangers = (link?.next?.attendees ?? []).filter((attendee) => !attendee.personId && !attendee.declined && attendee.email)
  const invitedKnown = (link?.next?.attendees ?? []).some(
    (attendee) => attendee.personId && !attendee.declined && !onRoster.has(attendee.personId),
  )
  const weekdayTime = (at: Date) =>
    new Intl.DateTimeFormat('en-US', { timeZone: user.timeZone ?? undefined, weekday: 'short' }).format(at) +
    ' ' +
    formatTime(at, user.timeZone)

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

  const archived = !!series.archivedAt

  return (
    <>
      <PageHeader
        title={series.name}
        crumbs={[{ href: '/series', label: 'Series' }]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {series.group ? (
              <Chip icon="group" href={`/groups/${series.group.id}`}>
                {series.group.name}
              </Chip>
            ) : null}
            {link ? (
              // The recurring event it follows: when it comes round, opening the next one.
              <Chip
                icon="meeting"
                href={
                  link.nextMeetingId
                    ? `/meetings/${link.nextMeetingId}`
                    : (link.next?.htmlLink ?? `/series/${series.id}`)
                }
              >
                {[link.title, link.next ? weekdayTime(link.next.startsAt) : null, link.cadence]
                  .filter(Boolean)
                  .join(' · ')}
              </Chip>
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
              {link ? (
                <label className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                  <input
                    type="checkbox"
                    name="unlinkCalendar"
                    className="h-4 w-4 rounded border-gray-300 text-red-600 focus:ring-red-500 dark:border-gray-600 dark:bg-gray-700"
                  />
                  Unlink calendar
                </label>
              ) : linkable.length > 0 ? (
                <Field label="Calendar">
                  <Select name="calendarSeriesId" defaultValue="">
                    <option value="">—</option>
                    {linkable.map((one) => (
                      <option key={one.calendarSeriesId} value={one.calendarSeriesId}>
                        {[one.next.title, weekdayTime(one.next.startsAt), one.cadence].filter(Boolean).join(' · ')}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
            </FormModal>
            <MoveTo
              action={moveSeriesAction}
              id={series.id}
              contexts={contexts.filter((one) => one.id !== context.id)}
            />
            {archived ? null : <ArchiveButton kind="series" id={series.id} />}
          </div>
        }
      />
      {archived ? <ArchivedBar kind="series" id={series.id} /> : null}
      <Muted archived={archived}>

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
            {series.people.length === 0 && strangers.length === 0 ? (
              <EmptyState icon="person" />
            ) : (
              <Card>
                <div className="flex flex-wrap gap-2">
                  {/* John is at every meeting: shown first, never removed. */}
                  {self ? (
                    <Chip icon="person" href={`/people/${self.id}`}>
                      Me
                    </Chip>
                  ) : null}
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
            {strangers.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {strangers.map((stranger) => (
                  <FormModal
                    key={stranger.email}
                    action={rosterInviteeAction}
                    title={stranger.email}
                    label={stranger.name ?? stranger.email}
                    icon="plus"
                    variant="secondary"
                    size="sm"
                    submit="Add"
                  >
                    <input type="hidden" name="id" value={series.id} />
                    <input type="hidden" name="email" value={stranger.email} />
                    <Field label="This is">
                      <Select name="personId" defaultValue="">
                        <option value="">—</option>
                        {allPeople
                          .filter((person) => !person.isSelf)
                          .map((person) => (
                            <option key={person.id} value={person.id}>
                              {person.name}
                            </option>
                          ))}
                      </Select>
                    </Field>
                    <Field label="Name">
                      <Input name="name" defaultValue={stranger.name ?? ''} />
                    </Field>
                  </FormModal>
                ))}
              </div>
            ) : null}
            {invitedKnown ? (
              <div className="mt-3 flex justify-end">
                <ActionButton action={rosterFromCalendarAction} fields={{ id: series.id }} variant="secondary" size="sm">
                  <Icon name="meeting" className="h-4 w-4" />
                  From calendar
                </ActionButton>
              </div>
            ) : null}
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
      </Muted>
    </>
  )
}
