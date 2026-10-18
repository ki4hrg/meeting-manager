import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ActionSelect } from '@/components/ActionSelect'
import { ActionButton, ActionForm, FormModal } from '@/components/forms'
import { ItemCard } from '@/components/items/ItemCard'
import { ItemPicker, type ItemOption } from '@/components/items/ItemPicker'
import { PartyOptions } from '@/components/items/PartyOptions'
import { PartyRoles } from '@/components/items/PartyRoles'
import { PartyPicker, type PartyOption } from '@/components/processing/PartyPicker'
import { QuickAdd } from '@/components/QuickAdd'
import { Breadcrumbs, type Crumb } from '@/components/ui/Breadcrumbs'
import { Button } from '@/components/ui/Button'
import { Card, Section } from '@/components/ui/Card'
import { Chip } from '@/components/ui/Chip'
import { RemovableChip } from '@/components/ui/RemovableChip'
import { Field, Input, Select, Textarea } from '@/components/ui/Field'
import { Markdown } from '@/components/ui/Markdown'
import { Icon, type IconName } from '@/components/ui/icons'
import {
  Badge,
  DueBadge,
  KIND,
  KindIcon,
  StatusBadge,
  type ItemKind,
} from '@/components/ui/StatusBadge'
import { iconButtonClasses } from '@/components/ui/IconButton'
import { itemTodoist, openTasks, rankTasks } from '@/lib/connect/todoist/match'
import { formatDay, formatMoment } from '@/lib/core/dates'
import { isUuid } from '@/lib/core/match'
import { NotFoundError } from '@/lib/core/types'
import { db } from '@/lib/db'
import { listGroups } from '@/lib/directory/groups'
import { listPeople } from '@/lib/directory/people'
import {
  canDeleteItem,
  getItem,
  getThread,
  isOpen,
  listItems,
  type ItemEvent,
} from '@/lib/items/items'
import { COLLABORATOR, hasCollaborators, roleLabel } from '@/lib/items/roles'
import { getProject, listProjectChoices } from '@/lib/projects/projects'
import { getMeeting, listMeetings } from '@/lib/meetings/meetings'
import { listSeries } from '@/lib/meetings/series'
import { viewer } from '@/lib/web/context'
import {
  addNoteAction,
  addPartyAction,
  answerItemAction,
  convertItemAction,
  deleteItemAction,
  itemStatusAction,
  parkItemAction,
  recordDecisionAction,
  removePartyAction,
  setPartyRoleAction,
  supersedeDecisionAction,
  unparkItemAction,
  updateItemAction,
  setItemTargetAction,
} from '../../actions'
import { MatchActions } from '../../settings/Todoist'

const CONVERTIBLE: ItemKind[] = ['topic', 'question', 'action']

const EVENT: Record<ItemEvent['type'], { icon: IconName; label: string }> = {
  created: { icon: 'plus', label: 'Created' },
  edited: { icon: 'pencil', label: 'Edited' },
  parties: { icon: 'group', label: 'People' },
  role: { icon: 'refresh', label: 'Role' },
  note: { icon: 'topic', label: 'Note' },
  converted: { icon: 'refresh', label: 'Converted' },
  answered: { icon: 'check', label: 'Answered' },
  completed: { icon: 'check', label: 'Done' },
  dropped: { icon: 'close', label: 'Dropped' },
  reopened: { icon: 'refresh', label: 'Reopened' },
  spawned: { icon: 'arrowRight', label: 'Follow-up' },
  superseded: { icon: 'refresh', label: 'Superseded' },
  targeted: { icon: 'meeting', label: 'Agenda' },
  discussed: { icon: 'meeting', label: 'Discussed' },
  parked: { icon: 'later', label: 'Later' },
  unparked: { icon: 'undo', label: 'Back' },
  needs_answer: { icon: 'question', label: 'Needs answer' },
}

function eventDetail(event: ItemEvent, kind: ItemKind): React.ReactNode {
  const data = event.data as Record<string, string | string[] | undefined>
  switch (event.type) {
    case 'note':
      return data.text
    case 'spawned':
      return data.text
    case 'parked':
      return typeof data.until === 'string' ? formatDay(data.until, data.until) : null
    case 'unparked':
      // Brought back by the item it waited on closing.
      return data.text
    case 'completed':
    case 'answered':
    case 'dropped': {
      const said = event.type === 'completed' ? data.resolution : event.type === 'answered' ? data.answer : null
      const released = (event.data.released as { text: string }[] | undefined)?.map((one) => one.text) ?? []
      if (released.length === 0) return said
      return (
        <>
          {said}
          <span className="mt-1 flex items-start gap-1">
            <Icon name="link" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" label="Released" />
            {released.join(', ')}
          </span>
        </>
      )
    }
    case 'converted':
      return (
        <span className="inline-flex items-center gap-1 align-middle">
          <KindIcon kind={data.from as ItemKind} className="h-4 w-4" />
          <Icon name="arrowRight" className="h-3 w-3" />
          <KindIcon kind={data.to as ItemKind} className="h-4 w-4" />
        </span>
      )
    case 'edited':
      return ((data.fields as string[]) ?? [])
        .map((name) => ({ projectId: 'project', dueOn: 'due' })[name] ?? name)
        .join(', ')
    case 'parties':
      return [...((data.owners as string[]) ?? []), ...((data.with as string[]) ?? [])].join(', ')
    case 'role': {
      const role = event.data as { name: string; role: 'owner' | 'with'; collaborator?: boolean }
      return (
        <span className="inline-flex items-center gap-1 align-middle">
          {role.name}
          <Icon name="arrowRight" className="h-3 w-3" />
          {role.collaborator && hasCollaborators(kind) ? COLLABORATOR : roleLabel(kind, role.role)}
        </span>
      )
    }
    default:
      return null
  }
}

/* One item, the thread it belongs to, and everything that has happened to it. */
export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) notFound()

  const { user, today } = await viewer()
  const thread = await getThread(db, id).catch((err) => {
    if (err instanceof NotFoundError) return null
    throw err
  })
  const item = thread?.entries.find((entry) => entry.item.id === id)?.item
  if (!thread || !item) notFound()

  const people = await listPeople(db)
  const groups = await listGroups(db, item.contextId)
  const projects = await listProjectChoices(db, item.contextId)

  const open = isOpen(item)
  const decision = item.kind === 'decision'
  const deletable = await canDeleteItem(db, item)

  /* "Raise at": an open item can be aimed at one meeting, or at a series,
     whose next occurrence then takes it. What is on offer is what is still to
     come; a target already in the past stays listed so the select can show it. */
  const raisable = open && !decision
  const series = raisable || item.targetSeriesId ? await listSeries(db, item.contextId) : []
  const meetings = raisable
    ? [
        ...(await listMeetings(db, { contextId: item.contextId, when: 'upcoming' })),
        ...(await listMeetings(db, { contextId: item.contextId, when: 'stubs' })),
      ]
    : []
  const lookUp = (meetingId: string | null) =>
    meetingId
      ? getMeeting(db, meetingId).catch((err) => {
          if (err instanceof NotFoundError) return null
          throw err
        })
      : null
  const targetMeeting = await lookUp(item.targetMeetingId)
  if (targetMeeting && raisable && !meetings.some((meeting) => meeting.id === targetMeeting.id)) {
    meetings.unshift(targetMeeting)
  }
  const targetSeries = series.find((one) => one.id === item.targetSeriesId)
  const targetProject = item.targetProjectId ? await getProject(db, item.targetProjectId) : null
  const target = targetMeeting
    ? { name: targetMeeting.title, href: `/meetings/${targetMeeting.id}` }
    : targetSeries
      ? { name: targetSeries.name, href: `/series/${targetSeries.id}` }
      : targetProject
        ? { name: `Next for ${targetProject.name}`, href: `/projects/${targetProject.id}` }
        : null
  const targetValue = targetMeeting
    ? `meeting:${targetMeeting.id}`
    : targetSeries
      ? `series:${targetSeries.id}`
      : targetProject
        ? `project:${targetProject.id}`
        : ''
  // "Next for <project>": the item's own project first, then the rest of the tree.
  const projectAims = [
    ...projects.filter((project) => project.id === item.project?.id).map((project) => ({ ...project, name: project.name.trim() })),
    ...projects.filter((project) => project.id !== item.project?.id && project.status !== 'done'),
  ]
  const origin = await lookUp(item.originMeetingId)
  /* Later, until another item closes: what this one waits on, what waits on
     it, and the open items it could wait on. */
  const blocker = item.laterUntilItemId
    ? await getItem(db, item.laterUntilItemId).catch((err) => {
        if (err instanceof NotFoundError) return null
        throw err
      })
    : null
  const holdsUp = open ? await listItems(db, { contextId: item.contextId, open: true, waitingOn: item.id }) : []
  const waitable: ItemOption[] =
    open && !decision
      ? (await listItems(db, { contextId: item.contextId, open: true }))
          .filter((one) => one.id !== item.id)
          .map((one) => ({ id: one.id, text: one.text, kind: one.kind }))
      : []
  const events = thread.events.filter((event) => event.itemId === id)
  /* Its Todoist task, or a way to give it one. */
  const todoist = await itemTodoist(db, item.id)
  const unsent = todoist && (todoist.state === 'none' || todoist.state === 'unmatched' || todoist.state === 'skipped')
  const taskChoices = unsent ? rankTasks(item.text, await openTasks(db)).slice(0, 60) : []
  /* Back to where the item lives: its project, the meeting it came from, the
     person or group it is for, or the Inbox. */
  const party = item.parties.find((one) => !one.isSelf)
  const crumbs: Crumb[] = item.project
    ? [
        { href: '/projects', label: 'Projects' },
        { href: `/projects/${item.project.id}`, label: item.project.name },
      ]
    : origin
      ? [
          { href: '/meetings', label: 'Meetings' },
          { href: `/meetings/${origin.id}`, label: origin.title },
        ]
      : party
        ? party.type === 'person'
          ? [{ href: '/people', label: 'People' }, { href: `/people/${party.id}`, label: party.name }]
          : [{ href: '/groups', label: 'Groups' }, { href: `/groups/${party.id}`, label: party.name }]
        : [{ href: '/inbox', label: 'Inbox' }]

  const reportTo = (
    <Field label="Report to">
      <Select name="reportTo" defaultValue="">
        <PartyOptions people={people} groups={groups} />
      </Select>
    </Field>
  )

  return (
    <>
      <Breadcrumbs crumbs={crumbs} />
      <Card padding="md" className="mb-8">
        <div className="flex items-start gap-4">
          <KindIcon kind={item.kind} className="h-7 w-7" />
          <div className="min-w-0 flex-1">
            {/* Badges under the title on a phone, beside it from sm up. */}
            <div className="flex flex-col items-start gap-2 sm:flex-row sm:justify-between sm:gap-3">
              <h1 className="w-full min-w-0 text-xl font-bold text-gray-900 sm:flex-1 dark:text-gray-100">
                {item.text}
              </h1>
              <span className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5 sm:justify-end">
                {item.project ? (
                  <Link href={`/projects/${item.project.id}`} className="inline-flex min-w-0 max-w-full">
                    <Badge>{item.project.name}</Badge>
                  </Link>
                ) : null}
                {item.dueOn ? (
                  <DueBadge
                    label={formatDay(item.dueOn, today)}
                    dueOn={item.dueOn}
                    today={today}
                    open={open}
                  />
                ) : null}
                <StatusBadge status={item.status} />
              </span>
            </div>

            {item.detail ? (
              <Markdown source={item.detail} className="mt-2 text-sm text-gray-700 dark:text-gray-300" />
            ) : null}

            {item.resolution ? (
              <div className="mt-3 flex gap-2 rounded-md bg-green-50 p-3 text-sm text-green-900 dark:bg-green-900/30 dark:text-green-100">
                <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0" label="Resolution" />
                <Markdown source={item.resolution} />
              </div>
            ) : null}

            <div className="mt-4">
              <PartyRoles
                itemId={item.id}
                kind={item.kind}
                parties={item.parties}
                move={setPartyRoleAction}
                remove={removePartyAction}
              >
                <FormModal
                  action={addPartyAction}
                  title="People"
                  icon="plus"
                  compact
                  submit={roleLabel(item.kind, 'with')}
                  also={{ label: roleLabel(item.kind, 'owner'), name: 'role', value: 'owner' }}
                >
                  <input type="hidden" name="id" value={item.id} />
                  <PartyPicker
                    label="Person or group"
                    name="party"
                    options={[
                      ...people.map((person): PartyOption => ({
                        value: `person:${person.id}`,
                        name: person.name,
                        icon: 'person',
                      })),
                      ...groups.map((group): PartyOption => ({
                        value: `group:${group.id}`,
                        name: group.name,
                        icon: 'group',
                      })),
                    ]}
                    required
                    allowNew
                  />
                </FormModal>
              </PartyRoles>
            </div>

            {raisable || target || origin || (open && item.parkedAt) || holdsUp.length > 0 ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {open && item.parkedAt && blocker ? (
                  <RemovableChip
                    icon="link"
                    iconLabel="Waits on"
                    href={`/items/${blocker.id}`}
                    remove={{
                      action: unparkItemAction,
                      fields: { id: item.id },
                      label: 'Bring back now',
                    }}
                  >
                    {item.laterOn ? `${blocker.text} · ${formatDay(item.laterOn, today)}` : blocker.text}
                  </RemovableChip>
                ) : open && item.parkedAt ? (
                  <RemovableChip
                    icon="later"
                    iconLabel="Later"
                    remove={{
                      action: unparkItemAction,
                      fields: { id: item.id },
                      label: 'Bring back now',
                    }}
                  >
                    {item.laterOn ? formatDay(item.laterOn, today) : 'Later'}
                  </RemovableChip>
                ) : null}
                {holdsUp.length > 0 ? (
                  <span className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 dark:text-gray-400">
                      <Icon name="link" className="h-3.5 w-3.5" label="Holds up" />
                      {holdsUp.length}
                    </span>
                    {holdsUp.map((one) => (
                      <Chip key={one.id} icon={KIND[one.kind].icon} href={`/items/${one.id}`}>
                        {one.text}
                      </Chip>
                    ))}
                  </span>
                ) : null}
                {origin ? (
                  <Chip icon="undo" href={`/meetings/${origin.id}`}>
                    <span className="text-gray-500 dark:text-gray-400">From</span> {origin.title}
                  </Chip>
                ) : null}
                {target && raisable ? (
                  <RemovableChip
                    icon="meeting"
                    iconLabel="Raise at"
                    href={target.href}
                    remove={{
                      action: setItemTargetAction,
                      fields: { id: item.id, target: '' },
                      label: `Stop raising at ${target.name}`,
                    }}
                  >
                    {target.name}
                  </RemovableChip>
                ) : target ? (
                  <Chip icon="meeting" href={target.href}>
                    {target.name}
                  </Chip>
                ) : null}
                {raisable ? (
                  <span className="flex items-center gap-1.5">
                    {/* Decorative: the select carries the name. */}
                    {target ? null : <Icon name="meeting" className="h-4 w-4 text-gray-400" />}
                    <ActionSelect
                      key={targetValue}
                      action={setItemTargetAction}
                      fields={{ id: item.id }}
                      name="target"
                      value={targetValue}
                      label="Raise at"
                      className="!w-auto max-w-[14rem] !py-1 !text-sm"
                    >
                      <option value="">Raise at…</option>
                      {meetings.length > 0 ? (
                        <optgroup label="Meetings">
                          {meetings.map((meeting) => (
                            <option key={meeting.id} value={`meeting:${meeting.id}`}>
                              {meeting.startsAt
                                ? `${meeting.title} · ${formatMoment(meeting.startsAt, user.timeZone)}`
                                : meeting.title}
                            </option>
                          ))}
                        </optgroup>
                      ) : null}
                      {series.length > 0 ? (
                        <optgroup label="Series">
                          {series.map((one) => (
                            <option key={one.id} value={`series:${one.id}`}>
                              {one.name}
                            </option>
                          ))}
                        </optgroup>
                      ) : null}
                      {projectAims.length > 0 ? (
                        <optgroup label="Next meeting for">
                          {projectAims.map((one) => (
                            <option key={one.id} value={`project:${one.id}`}>
                              {one.name}
                            </option>
                          ))}
                        </optgroup>
                      ) : null}
                    </ActionSelect>
                  </span>
                ) : null}
              </div>
            ) : null}

            <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-4 dark:border-gray-700">
              {open && item.kind === 'question' ? (
                <FormModal action={answerItemAction} title="Answer" label="Answer" icon="check" size="sm">
                  <input type="hidden" name="id" value={item.id} />
                  <Field label="Answer" required>
                    <Textarea name="answer" rows={3} required />
                  </Field>
                  {reportTo}
                </FormModal>
              ) : null}
              {open && !decision && item.kind !== 'question' ? (
                <ActionButton action={itemStatusAction} fields={{ id: item.id, op: 'done' }} size="sm">
                  <Icon name="check" className="h-4 w-4" />
                  Done
                </ActionButton>
              ) : null}
              {!open && !decision ? (
                <ActionButton
                  action={itemStatusAction}
                  fields={{ id: item.id, op: 'reopen' }}
                  variant="secondary"
                  size="sm"
                >
                  <Icon name="undo" className="h-4 w-4" />
                  Reopen
                </ActionButton>
              ) : null}

              {decision ? (
                item.status === 'decided' ? (
                  <FormModal
                    action={supersedeDecisionAction}
                    title="Supersede"
                    label="Supersede"
                    icon="decision"
                    variant="secondary"
                    size="sm"
                  >
                    <input type="hidden" name="id" value={item.id} />
                    <Field label="Decision" required>
                      <Textarea name="text" rows={2} required defaultValue={item.text} />
                    </Field>
                    <Field label="Detail">
                      <Textarea name="detail" rows={3} />
                    </Field>
                  </FormModal>
                ) : null
              ) : (
                <FormModal
                  action={recordDecisionAction}
                  title="Decision"
                  label="Decision"
                  icon="decision"
                  variant="secondary"
                  size="sm"
                >
                  <input type="hidden" name="fromItemId" value={item.id} />
                  <Field label="Decision" required>
                    <Textarea name="text" rows={2} required defaultValue={item.resolution ?? ''} />
                  </Field>
                  <Field label="Detail">
                    <Textarea name="detail" rows={3} />
                  </Field>
                  {reportTo}
                </FormModal>
              )}

              <QuickAdd label="Follow-up" presets={{ parentItemId: item.id, kind: 'action' }} />


              {open && !decision ? (
                <FormModal
                  action={parkItemAction}
                  title="Later"
                  label="Later"
                  icon="later"
                  variant="secondary"
                  size="sm"
                  submit="Later"
                >
                  <input type="hidden" name="id" value={item.id} />
                  <Field label="Back on">
                    <Input name="until" type="date" defaultValue={item.laterOn ?? ''} />
                  </Field>
                  {waitable.length > 0 ? (
                    <ItemPicker
                      label="Until done"
                      name="untilItem"
                      options={waitable}
                      selected={blocker && isOpen(blocker) ? { id: blocker.id, text: blocker.text, kind: blocker.kind } : null}
                    />
                  ) : null}
                </FormModal>
              ) : null}

              {open ? (
                <ActionButton
                  action={itemStatusAction}
                  fields={{ id: item.id, op: 'drop' }}
                  variant="secondary"
                  size="sm"
                >
                  <Icon name="close" className="h-4 w-4" />
                  Drop
                </ActionButton>
              ) : null}

              {/* Housekeeping, icon only, last: Todoist, its kind, Edit, Delete. */}
              <span className="ml-auto flex items-center gap-1">
                {todoist?.state === 'linked' ? (
                  <a
                    href={todoist.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Open in Todoist"
                    title={todoist.error ?? 'Open in Todoist'}
                    className={iconButtonClasses(todoist.error ? 'gray' : 'on')}
                  >
                    <Icon name={todoist.error ? 'alert' : 'share'} className="h-4 w-4" />
                  </a>
                ) : unsent ? (
                  <MatchActions itemId={item.id} choices={taskChoices} skip={todoist.state !== 'skipped'} />
                ) : null}
                {open && !decision ? (
                  <span className="flex items-center gap-1">
                    {CONVERTIBLE.map((kind) => (
                      <ActionButton
                        key={kind}
                        action={convertItemAction}
                        fields={{ id: item.id, kind }}
                        variant="ghost"
                        size="sm"
                        aria-label={KIND[kind].label}
                        aria-pressed={kind === item.kind}
                        disabled={kind === item.kind}
                        className={
                          kind === item.kind ? '!bg-gray-100 !opacity-100 dark:!bg-gray-700' : ''
                        }
                      >
                        <KindIcon kind={kind} className="h-4 w-4" />
                      </ActionButton>
                    ))}
                  </span>
                ) : null}
                <FormModal action={updateItemAction} title="Edit" icon="pencil" compact>
                  <input type="hidden" name="id" value={item.id} />
                  <Field label="Text" required>
                    <Textarea name="text" rows={2} required defaultValue={item.text} />
                  </Field>
                  <Field label="Detail">
                    <Textarea name="detail" rows={4} defaultValue={item.detail ?? ''} />
                  </Field>
                  <Field label="Project">
                    <Select name="projectId" defaultValue={item.project?.id ?? ''}>
                      <option value="">—</option>
                      {projects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Due">
                    <Input name="dueOn" type="date" defaultValue={item.dueOn ?? ''} />
                  </Field>
                </FormModal>
                {/* Closed and standing alone: what came out of a meeting, a thread or an agenda stays closed. */}
                {deletable ? (
                  <FormModal
                    action={deleteItemAction}
                    title="Delete item"
                    icon="trash"
                    compact
                    submit="Delete"
                    danger
                  >
                    <input type="hidden" name="id" value={item.id} />
                  </FormModal>
                ) : null}
              </span>
            </div>
          </div>
        </div>
      </Card>

      {thread.entries.length > 1 ? (
        <Section title="Thread" count={thread.entries.length}>
          <div className="flex flex-col gap-3">
            {thread.entries.map(({ item: entry, depth }) => (
              <div
                key={entry.id}
                style={{ marginLeft: `${Math.min(depth, 4) * 1.5}rem` }}
                className={entry.id === id ? 'rounded-lg ring-2 ring-blue-500' : undefined}
              >
                <ItemCard item={entry} today={today} />
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      <Section title="History">
        <Card>
          <ul className="flex flex-col gap-3">
            {events.map((event) => {
              const detail = eventDetail(event, item.kind)
              return (
                <li key={event.id} className="flex items-start gap-3 text-sm">
                  <Icon
                    name={EVENT[event.type]?.icon ?? 'clock'}
                    className="mt-0.5 h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500"
                  />
                  <div className="min-w-0 flex-1">
                    <span className="font-medium text-gray-900 dark:text-gray-100">
                      {EVENT[event.type]?.label ?? event.type}
                    </span>
                    {event.source === 'todoist' ? (
                      <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">Todoist</span>
                    ) : null}
                    {detail ? (
                      <span className="ml-2 whitespace-pre-wrap text-gray-600 dark:text-gray-300">
                        {detail}
                      </span>
                    ) : null}
                  </div>
                  <time
                    dateTime={event.createdAt.toISOString()}
                    className="shrink-0 text-xs tabular-nums text-gray-500 dark:text-gray-400"
                  >
                    {formatMoment(event.createdAt, user.timeZone)}
                  </time>
                </li>
              )
            })}
          </ul>

          <div className="mt-4 border-t border-gray-100 pt-4 dark:border-gray-700">
            <ActionForm action={addNoteAction} className="flex flex-col gap-2">
              <input type="hidden" name="id" value={item.id} />
              <div className="flex items-start gap-2">
                <Input name="text" aria-label="Note" placeholder="Note" required className="!mt-0" />
                <Button type="submit" variant="secondary">
                  Add
                </Button>
              </div>
            </ActionForm>
          </div>
        </Card>
      </Section>
    </>
  )
}
