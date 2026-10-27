import { RollCall } from '@/components/meetings/RollCall'
import { Roster } from '@/components/meetings/Roster'
import { copyListIfOver, rollCall } from '@/lib/meetings/attendance'
import { ArchiveButton, ArchivedBar, Muted } from '@/components/archive/Archive'
import { notFound } from 'next/navigation'
import { Export } from '@/components/Export'
import { ActionButton, FormModal, IconAction } from '@/components/forms'
import { AgendaCard, type LeaderChoice } from '@/components/meetings/AgendaCard'
import { Blocks } from '@/components/meetings/Blocks'
import { SessionAgenda } from '@/components/meetings/SessionAgenda'
import { MeetingFields, WhenFields } from '@/components/meetings/MeetingFields'
import { LivesIn, MoveTo } from '@/components/meetings/Move'
import { Suggestions } from '@/components/meetings/Suggestions'
import { QuickAdd } from '@/components/QuickAdd'
import { Card, CardGrid, Section, TwoColumn } from '@/components/ui/Card'
import { DocumentCard } from '@/components/documents/DocumentCard'
import { ItemsByKind } from '@/components/items/ItemCard'
import { Chip } from '@/components/ui/Chip'
import { Field, Input, Textarea } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import { ButtonLink } from '@/components/ui/Button'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/StatusBadge'
import { briefOutline } from '@/lib/agenda/brief'
import { getCandidates, placeAutomatic } from '@/lib/agenda/candidates'
import { computeBlocks } from '@/lib/agenda/generated'
import { getAgenda } from '@/lib/agenda/lines'
import { formatDay, formatSpan, todayIn } from '@/lib/core/dates'
import { listDocuments } from '@/lib/documents/documents'
import { isUuid } from '@/lib/core/match'
import { NotFoundError } from '@/lib/core/types'
import { db } from '@/lib/db'
import { listGroups } from '@/lib/directory/groups'
import { listPeople } from '@/lib/directory/people'
import { listItems } from '@/lib/items/items'
import { getMeeting, isOver } from '@/lib/meetings/meetings'
import { listSeries } from '@/lib/meetings/series'
import { listProjectChoices } from '@/lib/projects/projects'
import { allContexts, requireContext, viewer, webActor } from '@/lib/web/context'
import { separateSessionAction } from '../processing-actions'
import { reviewOf } from './review-parts'
import { crumbsFrom } from '@/lib/web/crumbs'
import {
  addSectionAction,
  addSessionAction,
  importOutlineAction,
  moveMeetingAction,
  openMeetingAction,
  takeRollAction,
  updateMeetingAction,
} from '../actions'

export default async function MeetingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ from?: string | string[] }>
}) {
  const { id } = await params
  if (!isUuid(id)) notFound()

  const context = await requireContext()
  const { user, self, today } = await viewer()
  const timeZone = user.timeZone

  let meeting = await getMeeting(db, id).catch((err) => {
    if (err instanceof NotFoundError) notFound()
    throw err
  })
  /* A meeting belongs to its context. With another one selected nothing of it
     is drawn but its name and the way to where it lives. */
  const contexts = await allContexts()
  if (meeting.contextId !== context.id) {
    const home = contexts.find((one) => one.id === meeting.contextId)
    if (!home) notFound()
    return <LivesIn title={meeting.title} context={home} action={openMeetingAction} id={meeting.id} />
  }

  /* A meeting with sessions is their rollup: its agenda is theirs, and it has
     no suggestions of its own. A session has no sessions. */
  const rollup = !meeting.parentMeetingId && meeting.sessions.length > 0
  /* Until a meeting is over, whatever places itself is put on the agenda
     before it is read, so routine prep is opening the page. */
  for (const one of rollup ? meeting.sessions : [meeting]) {
    if (!isOver(one)) await placeAutomatic(db, webActor(user), one.id)
  }
  /* The first look after it ended copies its list from its groups, if no roll call did. */
  if (await copyListIfOver(db, id)) meeting = await getMeeting(db, id)
  // Once it has started, who was there is taken here, and can be taken again at any time.
  const takesRoll = !rollup && meeting.startsAt !== null && meeting.startsAt <= new Date()
  const roll = takesRoll ? await rollCall(db, id) : []

  const covered = [meeting.id, ...meeting.sessions.map((one) => one.id)]
  const [agenda, sessionAgendas, candidates, blocks, parent, people, groups, projects, series, documents, outcomes] = await Promise.all([
    getAgenda(db, id, { timeZone }),
    Promise.all(meeting.sessions.map((session) => getAgenda(db, session.id, { timeZone }))),
    getCandidates(db, id),
    computeBlocks(db, id, { today }),
    meeting.parentMeetingId ? getMeeting(db, meeting.parentMeetingId) : null,
    listPeople(db),
    listGroups(db, context.id),
    listProjectChoices(db, context.id),
    listSeries(db, context.id),
    // What its notes drafted, its sessions' with it.
    listDocuments(db, { contextId: context.id, meetingIds: covered }),
    // What came out of it, its sessions' with it.
    Promise.all(covered.map((one) => listItems(db, { contextId: context.id, originMeetingId: one }))),
  ])
  const outcome = outcomes.flat()
  // Once it has started there can be something to show for it.
  const started = meeting.startsAt !== null && meeting.startsAt <= new Date()
  /* What came of it, reviewed here: its notes, the run and the proposals. */
  const review = await reviewOf({
    meeting,
    parent,
    choices: { people, groups, projects, series },
    people,
    groups,
    roll,
    today,
    selfId: self.id,
    timeZone,
  })
  const reviewing = started || review.any

  const sessions = rollup
    ? meeting.sessions.map((session, index) => ({ ...session, agenda: sessionAgendas[index]! }))
    : []
  const brief = { meeting, agenda, sessions, blocks, timeZone, today }
  // Who can lead a line: anyone, John first.
  const leaders: LeaderChoice[] = [
    ...people.filter((person) => person.isSelf),
    ...people.filter((person) => !person.isSelf),
  ]
  const choices = {
    people: people.filter((person) => !person.isSelf),
    groups,
    projects: projects.filter(
      (project) => project.status !== 'done' || meeting.projects.some((p) => p.id === project.id),
    ),
    series,
  }

  // Import, Section and quick-add, aimed at one meeting's own agenda (a session's, on a rollup).
  const agendaTools = (meetingId: string, extra?: React.ReactNode) => (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {extra}
      <FormModal
        action={importOutlineAction}
        title="Import outline"
        label="Import"
        icon="document"
        variant="secondary"
        size="sm"
        submit="Import"
        wide
      >
        <input type="hidden" name="meetingId" value={meetingId} />
        <Field label="Outline" required>
          <Textarea
            name="text"
            rows={12}
            required
            className="font-mono"
            placeholder={'# Section\n## Line 10 min'}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            name="replace"
            className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
          />
          Replace
        </label>
      </FormModal>
      <FormModal
        action={addSectionAction}
        title="New section"
        label="Section"
        icon="plus"
        variant="secondary"
        size="sm"
        submit="Add"
      >
        <input type="hidden" name="meetingId" value={meetingId} />
        <Field label="Title" required>
          <Input name="title" required />
        </Field>
      </FormModal>
      <QuickAdd presets={{ targetMeetingId: meetingId }} />
    </div>
  )

  const addSession = (
    <FormModal
      action={addSessionAction}
      title="New session"
      label="Session"
      icon="plus"
      variant="secondary"
      size="sm"
      submit="Add"
    >
      <input type="hidden" name="parentMeetingId" value={meeting.id} />
      <Field label="Title" required>
        <Input name="title" required />
      </Field>
      <WhenFields timeZone={timeZone} />
    </FormModal>
  )

  const archived = !!meeting.archivedAt

  return (
    <>
      <PageHeader
        title={meeting.title}
        crumbs={
          (await crumbsFrom(db, (await searchParams).from, meeting.contextId)) ?? [
            { href: '/meetings', label: 'Meetings' },
            ...(parent ? [{ href: `/meetings/${parent.id}`, label: parent.title }] : []),
          ]
        }
        actions={
          <>
            {review.approveAll}
            {/* The one blue button is Approve all while anything is ready to approve. */}
            <Export
              kind="agenda"
              outline={briefOutline(brief)}
              title={meeting.title}
              mailto={`mailto:?subject=${encodeURIComponent(meeting.title)}`}
              variant={review.approveAll ? 'secondary' : 'primary'}
            />
            {review.sessionOf}
            <ButtonLink href={`/meetings/${meeting.id}/recap`} variant="secondary">
              <Icon name="document" className="h-4 w-4" />
              Recap
            </ButtonLink>
          </>
        }
        tools={
          <>
            <FormModal action={updateMeetingAction} title="Edit" icon="pencil" compact iconSize="md">
              <input type="hidden" name="id" value={meeting.id} />
              <MeetingFields
                meeting={meeting}
                choices={choices}
                timeZone={timeZone}
              />
            </FormModal>
            {/* A session goes where its meeting goes, or comes out of it. */}
            {parent ? (
              <IconAction
                action={separateSessionAction}
                fields={{ meetingId: meeting.id }}
                icon="meeting"
                label="Own meeting"
                size="md"
              />
            ) : (
              <MoveTo
                action={moveMeetingAction}
                id={meeting.id}
                contexts={contexts.filter((one) => one.id !== context.id)}
              />
            )}
            {archived ? null : <ArchiveButton kind="meeting" id={meeting.id} />}
          </>
        }
      />
      {archived ? <ArchivedBar kind="meeting" id={meeting.id} /> : null}
      <Muted archived={archived}>

        <div className="mb-8 flex flex-wrap items-center gap-2">
          {meeting.startsAt ? (
            <span className="mr-1 flex items-center gap-1.5 text-sm font-medium tabular-nums text-gray-700 dark:text-gray-300">
              <Icon name="meeting" className="h-4 w-4 text-gray-400 dark:text-gray-500" />
              {formatSpan(meeting.startsAt, meeting.endsAt, timeZone, today)}
            </span>
          ) : (
            <Badge tone="amber">Undated</Badge>
          )}
          {meeting.series ? (
            <Chip href={`/series/${meeting.series.id}`} icon="refresh">
              {meeting.series.name}
            </Chip>
          ) : null}
          {/* John first; then who is on it by name; then each group with who it brings
              (live until its list is copied, then as it was). Once the roll call is
              below, it is the list. */}
          {takesRoll ? null : (
            <Roster selfId={self?.id} groups={meeting.groups} attendees={meeting.attendees} absent={meeting.absent} />
          )}
          {meeting.projects.map((project) => (
            <Chip key={project.id} href={`/projects/${project.id}`} icon="project">
              {project.name}
            </Chip>
          ))}
        </div>

        {takesRoll ? (
          <Section title="Attendance">
            <Card>
              <RollCall
                action={takeRollAction}
                meetingId={meeting.id}
                entries={roll}
                groups={meeting.groups}
                people={people
                  .filter((person) => !person.isSelf)
                  .map((person) => ({ value: person.id, name: person.name, icon: 'person' as const }))}
              />
            </Card>
          </Section>
        ) : null}

        {reviewing ? review.body : null}

        <TwoColumn
          main={
            <>
              {rollup ? (
                <>
                  {/* What was on the meeting itself before it had sessions. */}
                  {agenda.nodes.length > 0 ? (
                    <Section title="Agenda">
                      <AgendaCard agenda={agenda} today={today} people={leaders} />
                    </Section>
                  ) : null}
                  <Section title="Sessions" count={sessions.length} action={addSession}>
                    <div className="flex flex-col gap-6">
                      {sessions.map((session) => (
                        <SessionAgenda
                          key={session.id}
                          session={session}
                          agenda={session.agenda}
                          today={today}
                          timeZone={timeZone}
                          people={leaders}
                          sessions={sessions}
                          tools={agendaTools(
                            session.id,
                            /* Out of this meeting, a meeting of its own: the undo for a join. */
                            <ActionButton
                              action={separateSessionAction}
                              fields={{ meetingId: session.id }}
                              variant="secondary"
                              size="sm"
                            >
                              <Icon name="meeting" className="h-4 w-4" />
                              Own meeting
                            </ActionButton>,
                          )}
                        />
                      ))}
                    </div>
                  </Section>
                </>
              ) : (
                <Section title="Agenda" action={agendaTools(meeting.id)}>
                  <AgendaCard agenda={agenda} today={today} people={leaders} sessions={parent?.sessions} />
                </Section>
              )}

              {started || outcome.length > 0 ? (
                <Section
                  title="Outcomes"
                  count={outcome.length}
                  action={<QuickAdd presets={{ kind: 'action', originMeetingId: meeting.id }} />}
                >
                  <ItemsByKind items={outcome} today={today} empty="action" />
                </Section>
              ) : null}

              {reviewing ? review.notes : null}

              {/* One level only: a session has no sessions of its own. */}
              {rollup || parent ? null : <Section title="Sessions" count={0} action={addSession} />}
            </>
          }
          side={
            <>
              {rollup ? null : <Suggestions candidates={candidates} meetingId={meeting.id} />}

              {/* Made by accepting a proposal, so with none there is nothing here to fill. */}
              {documents.length > 0 ? (
                <Section title="Documents" count={documents.length}>
                  <div id="documents" className="scroll-mt-4">
                    <CardGrid>
                      {documents.map((document) => (
                        <DocumentCard
                          key={document.id}
                          title={document.title}
                          body={document.body}
                          meta={formatDay(todayIn(timeZone, document.updatedAt), today)}
                        />
                      ))}
                    </CardGrid>
                  </div>
                </Section>
              ) : null}

              <Blocks
                meetingId={meeting.id}
                settings={meeting.blocks}
                blocks={blocks}
                today={today}
                timeZone={timeZone}
              />
            </>
          }
        />
      </Muted>
    </>
  )
}
