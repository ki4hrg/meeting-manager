import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ActionButton, FormModal } from '@/components/forms'
import { History } from '@/components/items/History'
import { ItemCard } from '@/components/items/ItemCard'
import { ItemPicker, type ItemOption } from '@/components/items/ItemPicker'
import { PartyOptions } from '@/components/items/PartyOptions'
import { PartyRoles } from '@/components/items/PartyRoles'
import { MakeProjectFields } from '@/components/projects/MakeProjectFields'
import { RaiseAt } from '@/components/items/RaiseAt'
import { RecordDecision } from '@/components/items/RecordDecision'
import { BackWhen, WaitingOnThis } from '@/components/items/WaitsOn'
import { PartyPicker, type PartyOption } from '@/components/processing/PartyPicker'
import { GranolaChip } from '@/components/GranolaChip'
import { QuickAdd } from '@/components/QuickAdd'
import { Breadcrumbs, type Crumb } from '@/components/ui/Breadcrumbs'
import { Card, Section } from '@/components/ui/Card'
import { Chip } from '@/components/ui/Chip'
import { RemovableChip } from '@/components/ui/RemovableChip'
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/Field'
import { Markdown } from '@/components/ui/Markdown'
import { Icon } from '@/components/ui/icons'
import {
  Badge,
  DueBadge,
  KIND,
  KindIcon,
  StatusBadge,
  type ItemKind,
} from '@/components/ui/StatusBadge'
import { iconButtonClasses } from '@/components/ui/IconButton'
import { splitGranolaLinks } from '@/lib/connect/granola/links'
import { itemComments } from '@/lib/connect/todoist/comments'
import { itemTodoist, openTasks, rankTasks } from '@/lib/connect/todoist/match'
import { formatDay, formatMoment, todayIn } from '@/lib/core/dates'
import { isUuid } from '@/lib/core/match'
import { NotFoundError } from '@/lib/core/types'
import { db } from '@/lib/db'
import { listGroups } from '@/lib/directory/groups'
import { listPeople } from '@/lib/directory/people'
import {
  askOf,
  canDeleteItem,
  getItem,
  getThread,
  isOpen,
  listItems,
} from '@/lib/items/items'
import { getProject, listProjectChoices } from '@/lib/projects/projects'
import { getMeeting, listMeetings, type MeetingView } from '@/lib/meetings/meetings'
import { findNoteByExternalId, listNotes } from '@/lib/notes/notes'
import { listSeries } from '@/lib/meetings/series'
import { acceptedSteps } from '@/lib/processing/proposals'
import { viewer } from '@/lib/web/context'
import { crumbsFrom } from '@/lib/web/crumbs'
import {
  addPartyAction,
  answerItemAction,
  askItemAction,
  convertItemAction,
  makeProjectAction,
  setOngoingAction,
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

/* One item, the thread it belongs to, and everything that has happened to it. */
export default async function ItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ from?: string | string[] }>
}) {
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
  // Also who a decision or an answer can be reported to.
  const series = await listSeries(db, item.contextId)
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
    ? {
        name: targetMeeting.startsAt
          ? `${targetMeeting.title} · ${formatDay(todayIn(user.timeZone, targetMeeting.startsAt), today)}`
          : targetMeeting.title,
        href: `/meetings/${targetMeeting.id}`,
      }
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
  /* Its Granola notes: the origin meeting's, and any linked in the detail,
     which then leaves the text shown. A note linked there that we hold names
     the meeting it came from, when the item has no origin of its own. */
  const linked = item.detail ? splitGranolaLinks(item.detail) : { text: '', ids: [] }
  const detail = linked.ids.length > 0 ? linked.text : item.detail
  const originNotes = origin
    ? (await listNotes(db, origin.id)).flatMap((note) =>
        note.source === 'granola' && note.externalId ? [note.externalId] : [],
      )
    : []
  const granolaIds = [...new Set([...originNotes, ...linked.ids])]
  let noteMeeting: MeetingView | null = null
  for (const noteId of origin ? [] : linked.ids) {
    const note = await findNoteByExternalId(db, 'granola', noteId)
    const meeting = note?.meetingId ? await lookUp(note.meetingId) : null
    if (meeting && meeting.contextId === item.contextId) {
      noteMeeting = meeting
      break
    }
  }
  const from = origin ?? noteMeeting
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
  /* Asking a question someone else owes: the ask it waits on, if any, and
     the open actions it could go with instead of an ask of its own. */
  const askedOf =
    open && item.kind === 'question' ? item.parties.find((one) => one.role === 'owner' && !one.isSelf) : undefined
  const ask = open ? await askOf(db, item) : null
  const joinable: ItemOption[] = askedOf
    ? (await listItems(db, { contextId: item.contextId, open: true, kinds: ['action'] }))
        .filter((one) => one.id !== ask?.ask.id)
        .map((one) => ({ id: one.id, text: one.text, kind: one.kind }))
    : []
  const events = thread.events.filter((event) => event.itemId === id)
  /* Its Todoist task, or a way to give it one. */
  const todoist = await itemTodoist(db, item.id)
  const unsent = todoist && (todoist.state === 'none' || todoist.state === 'unmatched' || todoist.state === 'skipped')
  const taskChoices = unsent ? rankTasks(item.text, await openTasks(db)).slice(0, 60) : []
  /* Back to the page it was opened from; otherwise to where the item lives:
     its project, the meeting it came from, the person or group it is for, or
     the Inbox. */
  const party = item.parties.find((one) => !one.isSelf)
  const crumbs: Crumb[] =
    (await crumbsFrom(db, (await searchParams).from, item.contextId)) ??
    (item.project
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
        : [{ href: '/inbox', label: 'Inbox' }])

  const partyOptions: PartyOption[] = [
    ...people.map((person): PartyOption => ({ value: `person:${person.id}`, name: person.name, icon: 'person' })),
    ...groups.map((group): PartyOption => ({ value: `group:${group.id}`, name: group.name, icon: 'group' })),
  ]
  /* A person, a group, or a series, whose next meeting raises it. */
  const reportTo = (
    <PartyPicker
      label="Report to"
      name="reportTo"
      options={[
        ...partyOptions,
        ...series.map((one): PartyOption => ({ value: `series:${one.id}`, name: one.name, icon: 'refresh' })),
      ]}
      allowNew
      allowNewGroup
    />
  )

  return (
    <>
      <Breadcrumbs crumbs={crumbs} />
      <Card padding="md" className="mb-8">
        <div className="flex items-start gap-4">
          <KindIcon kind={item.kind} ongoing={item.ongoing} className="h-7 w-7" />
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

            {detail ? (
              <Markdown source={detail} className="mt-2 text-sm text-gray-700 dark:text-gray-300" />
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
                add={(row) => (
                  <FormModal
                    action={addPartyAction}
                    title={`${row.label}: add`}
                    icon="plus"
                    compact
                    submit="Add"
                  >
                    <input type="hidden" name="id" value={item.id} />
                    <input type="hidden" name="role" value={row.role} />
                    <PartyPicker
                      label="Person or group"
                      name="party"
                      options={partyOptions}
                      required
                      allowNew
                      allowNewGroup
                    />
                  </FormModal>
                )}
              />
            </div>

            {raisable || target || from || granolaIds.length > 0 || (open && item.parkedAt) ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {open && item.parkedAt && blocker ? (
                  <BackWhen
                    item={blocker}
                    on={item.laterOn ? formatDay(item.laterOn, today) : null}
                    remove={{
                      action: unparkItemAction,
                      fields: { id: item.id },
                      label: 'Bring back now',
                    }}
                  />
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
                {from ? (
                  <Chip icon="undo" href={`/meetings/${from.id}`}>
                    <span className="text-gray-500 dark:text-gray-400">From</span> {from.title}
                  </Chip>
                ) : null}
                {granolaIds.map((noteId) => (
                  <GranolaChip key={noteId} noteId={noteId} />
                ))}
                {raisable ? (
                  <RaiseAt
                    key={targetValue}
                    itemId={item.id}
                    action={setItemTargetAction}
                    value={targetValue}
                    target={target}
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
                  </RaiseAt>
                ) : target ? (
                  <Chip icon="meeting" href={target.href}>
                    {target.name}
                  </Chip>
                ) : null}
              </div>
            ) : null}

            {holdsUp.length > 0 ? (
              <div className="mt-4">
                <WaitingOnThis items={holdsUp} />
              </div>
            ) : null}

            <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-4 dark:border-gray-700">
              {open && item.kind === 'question' ? (
                <FormModal action={answerItemAction} title="Answer" label="Answer" icon="check" size="sm">
                  <input type="hidden" name="id" value={item.id} />
                  <Field label="Answer" required>
                    <Textarea name="answer" rows={3} required />
                  </Field>
                  {ask ? (
                    <Checkbox name="closeAsk" label={`Close: ${ask.ask.text}`} defaultChecked={!ask.shared} />
                  ) : null}
                  <Checkbox name="told" label="Already passed on" />
                  {reportTo}
                  <RecordDecision />
                </FormModal>
              ) : null}
              {askedOf ? (
                <FormModal
                  action={askItemAction}
                  title="Ask"
                  label="Ask"
                  icon="mail"
                  variant="secondary"
                  size="sm"
                  submit="Ask"
                >
                  <input type="hidden" name="id" value={item.id} />
                  <Field label="Ask">
                    <Input name="text" defaultValue={`Ask ${askedOf.name}: ${item.text}`} />
                  </Field>
                  <Field label="With">
                    <Select
                      name="with"
                      defaultValue={askedOf.type === 'person' ? `person:${askedOf.id}` : `group:${askedOf.id}`}
                    >
                      <PartyOptions people={people} groups={groups} />
                    </Select>
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Due">
                      <Input name="dueOn" type="date" defaultValue={item.dueOn ?? ''} />
                    </Field>
                    <Field label="Back on">
                      <Input name="laterOn" type="date" />
                    </Field>
                  </div>
                  {joinable.length > 0 ? <ItemPicker label="Or with" name="join" options={joinable} /> : null}
                </FormModal>
              ) : null}
              {open && !decision && item.kind !== 'question' ? (
                <ActionButton
                  action={itemStatusAction}
                  fields={{ id: item.id, op: 'done' }}
                  size="sm"
                  title={holdsUp.length > 0 ? `Brings back ${holdsUp.length}` : undefined}
                >
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

              {open && item.kind === 'topic' ? (
                <FormModal
                  action={makeProjectAction}
                  title="Make project"
                  label="Make project"
                  icon="project"
                  variant="secondary"
                  size="sm"
                  submit="Create"
                >
                  <input type="hidden" name="id" value={item.id} />
                  <MakeProjectFields
                    name={item.text}
                    parentId={item.project?.id ?? null}
                    projects={projects.filter((project) => project.status !== 'done' || project.id === item.project?.id)}
                  />
                </FormModal>
              ) : null}

              <QuickAdd
                label="Follow-up"
                title="New follow-up action"
                presets={{ parentItemId: item.id, kind: 'action' }}
              />


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
                    <Input name="until" type="date" />
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
                <FormModal
                  action={itemStatusAction}
                  title="Drop item"
                  label="Drop"
                  icon="close"
                  variant="secondary"
                  size="sm"
                  submit="Drop"
                  danger
                >
                  <input type="hidden" name="id" value={item.id} />
                  <input type="hidden" name="op" value="drop" />
                </FormModal>
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
                    {item.kind === 'question' ? (
                      <ActionButton
                        action={setOngoingAction}
                        fields={{ id: item.id, ongoing: item.ongoing ? '' : 'on' }}
                        variant="ghost"
                        size="sm"
                        aria-label="Ongoing"
                        aria-pressed={item.ongoing}
                        className={item.ongoing ? '!bg-gray-100 dark:!bg-gray-700' : ''}
                      >
                        <KindIcon kind="question" ongoing className="h-4 w-4" />
                      </ActionButton>
                    ) : null}
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

      <History
        item={item}
        events={events}
        comments={await itemComments(db, item.id)}
        accepted={await acceptedSteps(db, item.id)}
        timeZone={user.timeZone}
      />
    </>
  )
}
