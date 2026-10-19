import { ArchiveButton, ArchivedBar, Muted } from '@/components/archive/Archive'
import { notFound } from 'next/navigation'
import { ActionButton, FormModal, IconAction } from '@/components/forms'
import { HubMeetings } from '@/components/meetings/HubMeetings'
import { Answered } from '@/components/items/Answered'
import { ItemGrid } from '@/components/items/ItemCard'
import { QuickAdd } from '@/components/QuickAdd'
import { LivesIn, MoveTo } from '@/components/meetings/Move'
import { SkeletonEditor } from '@/components/series/SkeletonEditor'
import { Card, CardHeader, LinkCard, Section, TwoColumn } from '@/components/ui/Card'
import { PartyPicker } from '@/components/processing/PartyPicker'
import { CheckList } from '@/components/ui/CheckList'
import { Chip } from '@/components/ui/Chip'
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
import { allGroupEmails, listGroups, listMembers } from '@/lib/directory/groups'
import { GroupCluster, MeChip, MemberLink } from '@/components/meetings/Roster'
import { listPeople } from '@/lib/directory/people'
import { isOwed } from '@/lib/items/horizon'
import { answered, isOpen, listItems } from '@/lib/items/items'
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
  removeSeriesGroupAction,
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

export default async function SeriesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { id } = await params
  if (!isUuid(id)) notFound()

  const context = await requireContext()
  const { user, today } = await viewer()
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
  // Who each group on the roster brings, less Me and anyone on it by name.
  const brought = await Promise.all(
    series.groups.map(async (group) =>
      (await listMembers(db, group.id)).filter((member) => !member.isSelf && !onRoster.has(member.id)),
    ),
  )
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
  const behind = await outOfStep(db, id)
  const link = await calendarLinkOf(db, series)
  const linkable = link ? [] : await unlinkedRecurring(db, context.id)
  const allPeople = await listPeople(db)
  const self = allPeople.find((person) => person.isSelf)
  // Invited on the calendar and in nobody's directory entry: each can be added in one step.
  const lists = await allGroupEmails(db)
  const strangers = (link?.next?.attendees ?? []).filter(
    (attendee) => !attendee.personId && !attendee.declined && attendee.email && !lists.has(attendee.email.toLowerCase()),
  )
  const invitedKnown = (link?.next?.attendees ?? []).some(
    (attendee) => attendee.personId && !attendee.declined && !onRoster.has(attendee.personId),
  )
  // Nobody on the roster and nobody to add from the calendar.
  const unlisted = series.people.length + series.groups.length === 0 && strangers.length === 0
  const weekdayTime = (at: Date) =>
    new Intl.DateTimeFormat('en-US', { timeZone: user.timeZone ?? undefined, weekday: 'short' }).format(at) +
    ' ' +
    formatTime(at, user.timeZone)

  /* Raised at its meetings or aimed at its next one. What is added here is
     aimed at the next one. */
  const all = await listItems(db, { contextId: context.id, seriesId: id })
  const open = all.filter(isOpen)
  const topics = open.filter((item) => item.kind === 'topic')
  const owed = open.filter(isOwed)
  const decisions = all.filter((item) => item.kind === 'decision')
  const answers = answered(all)

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
          link ? (
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
          ) : null
        }
        tools={
          <>
            <FormModal action={updateSeriesAction} title="Edit" icon="pencil" compact iconSize="md">
              <input type="hidden" name="id" value={series.id} />
              <Field label="Name" required>
                <Input name="name" defaultValue={series.name} required />
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
          </>
        }
      />
      {archived ? <ArchivedBar kind="series" id={series.id} /> : null}
      <Muted archived={archived}>

        <TwoColumn
          main={
            <>
              <Section
                title="Next"
                empty={!next}
                action={
                  next ? null : (
                    <ActionButton action={prepNextInSeriesAction} fields={{ id: series.id }} size="sm">
                      <Icon name="meeting" className="h-4 w-4" />
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
                ) : null}
              </Section>

              <Section
                title="Topics"
                count={topics.length}
                action={<QuickAdd presets={{ kind: 'topic', targetSeriesId: series.id }} />}
              >
                <ItemGrid items={topics} today={today} empty="topic" />
              </Section>

              <Section
                title="Owed"
                count={owed.length}
                action={<QuickAdd presets={{ kind: 'action', targetSeriesId: series.id }} />}
              >
                <ItemGrid items={owed} today={today} empty="action" />
              </Section>

              {/* Made at its meetings: nothing to add from here. */}
              {decisions.length > 0 ? (
                <Section title="Decisions" count={decisions.length}>
                  <ItemGrid items={decisions} today={today} empty="decision" />
                </Section>
              ) : null}

              <Answered items={answers} today={today} on={{ seriesId: series.id }} />

              <HubMeetings
                hub={{ kind: 'series', id: series.id }}
                contextId={context.id}
                path={`/series/${series.id}`}
                query={await searchParams}
                timeZone={user.timeZone}
                today={today}
                skip={next?.id}
              />
            </>
          }
          side={
            <>
              <Section
                title="Roster"
                count={series.people.length + series.groups.length}
                empty={unlisted && !invitedKnown && behind.length === 0}
                action={
                  <FormModal action={addSeriesPeopleAction} title="Add to roster" label="Add" icon="plus" variant="secondary" size="sm" submit="Add">
                    <input type="hidden" name="id" value={series.id} />
                    <PartyPicker
                      label="People"
                      name="personIds"
                      options={[
                        ...otherPeople.map((person) => ({ value: person.id, name: person.name, icon: 'person' as const })),
                        ...groups
                          .filter((group) => !series.groups.some((one) => one.id === group.id))
                          .map((group) => ({ value: `group:${group.id}`, name: group.name, icon: 'group' as const })),
                      ]}
                      allowNew
                      allowNewGroup
                      me
                    />
                  </FormModal>
                }
              >
                {unlisted ? null : (
                  <Card>
                    <div className="flex flex-wrap gap-2">
                      {/* John is at every meeting: shown first, never removed. Then who is on it
                          by name, then each group with the people it brings. */}
                      <MeChip href={self ? `/people/${self.id}` : undefined} />
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
                      {series.groups.map((group, index) => (
                        <GroupCluster
                          key={group.id}
                          chip={
                            <RemovableChip
                              icon="group"
                              href={`/groups/${group.id}`}
                              remove={{
                                action: removeSeriesGroupAction,
                                fields: { id: series.id, groupId: group.id },
                                label: `Remove ${group.name}`,
                              }}
                            >
                              {group.name}
                            </RemovableChip>
                          }
                        >
                          {brought[index]!.map((member) => (
                            <MemberLink key={member.id} person={member} />
                          ))}
                        </GroupCluster>
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
                            <optgroup label="People">
                              {allPeople
                                .filter((person) => !person.isSelf)
                                .map((person) => (
                                  <option key={person.id} value={person.id}>
                                    {person.name}
                                  </option>
                                ))}
                            </optgroup>
                            {groups.length > 0 ? (
                              <optgroup label="Groups">
                                {groups.map((group) => (
                                  <option key={group.id} value={`group:${group.id}`}>
                                    {group.name}
                                  </option>
                                ))}
                              </optgroup>
                            ) : null}
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
                    <FormModal action={addSeriesProjectsAction} title="Add projects" label="Add" icon="plus" variant="secondary" size="sm" submit="Add">
                      <input type="hidden" name="id" value={series.id} />
                      <CheckList label="Projects" name="projectIds" options={otherProjects} />
                    </FormModal>
                  ) : null
                }
              >
                {series.projects.length === 0 ? null : (
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

              <Section
                title="Blocks"
                action={
                  <div className="flex items-center gap-1">
                    {BLOCKS.map(({ block, icon, label }) => (
                      <IconAction
                        key={block}
                        action={setSeriesBlockAction}
                        fields={{ id: series.id, block, on: String(!series.blocks[block]) }}
                        icon={icon}
                        label={label}
                        tone={series.blocks[block] ? 'on' : 'gray'}
                        aria-pressed={series.blocks[block]}
                      />
                    ))}
                  </div>
                }
              >
                {null}
              </Section>

              <SkeletonEditor seriesId={series.id} skeleton={series.skeleton} />
            </>
          }
        />
      </Muted>
    </>
  )
}
