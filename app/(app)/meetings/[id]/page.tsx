import Link from 'next/link'
import { notFound } from 'next/navigation'
import { CopyButton } from '@/components/CopyButton'
import { FormModal } from '@/components/forms'
import { AgendaCard, type LeaderChoice } from '@/components/meetings/AgendaCard'
import { Blocks } from '@/components/meetings/Blocks'
import { SessionAgenda } from '@/components/meetings/SessionAgenda'
import { MeetingFields, WhenFields } from '@/components/meetings/MeetingFields'
import { LivesIn, MoveTo } from '@/components/meetings/Move'
import { Suggestions } from '@/components/meetings/Suggestions'
import { QuickAdd } from '@/components/QuickAdd'
import { Section } from '@/components/ui/Card'
import { Chip } from '@/components/ui/Chip'
import { Field, Input, Textarea } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import { PendingBadge } from '@/components/processing/PendingBadge'
import { ButtonLink } from '@/components/ui/Button'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/StatusBadge'
import { renderAgenda, renderAgendaHtml, renderBrief, renderBriefHtml } from '@/lib/agenda/brief'
import { getCandidates, placeAutomatic } from '@/lib/agenda/candidates'
import { computeBlocks } from '@/lib/agenda/generated'
import { getAgenda } from '@/lib/agenda/lines'
import { formatSpan } from '@/lib/core/dates'
import { isUuid } from '@/lib/core/match'
import { NotFoundError } from '@/lib/core/types'
import { db } from '@/lib/db'
import { listGroups } from '@/lib/directory/groups'
import { listPeople } from '@/lib/directory/people'
import { getMeeting, isOver } from '@/lib/meetings/meetings'
import { listSeries } from '@/lib/meetings/series'
import { pendingByMeeting } from '@/lib/processing/proposals'
import { listProjects } from '@/lib/projects/projects'
import { allContexts, requireContext, viewer, webActor } from '@/lib/web/context'
import {
  addSectionAction,
  addSessionAction,
  deleteMeetingAction,
  importOutlineAction,
  moveMeetingAction,
  openMeetingAction,
  updateMeetingAction,
} from '../actions'

export default async function MeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) notFound()

  const context = await requireContext()
  const { user, today } = await viewer()
  const timeZone = user.timeZone

  const meeting = await getMeeting(db, id).catch((err) => {
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

  const [agenda, sessionAgendas, candidates, blocks, parent, people, groups, projects, series, pending] = await Promise.all([
    getAgenda(db, id, { timeZone }),
    Promise.all(meeting.sessions.map((session) => getAgenda(db, session.id, { timeZone }))),
    getCandidates(db, id),
    computeBlocks(db, id, { today }),
    meeting.parentMeetingId ? getMeeting(db, meeting.parentMeetingId) : null,
    listPeople(db),
    listGroups(db, context.id),
    listProjects(db, context.id),
    listSeries(db, context.id),
    pendingByMeeting(db, context.id),
  ])

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

  const agendaTools = (
    <div className="flex items-center gap-2">
      <FormModal
        action={importOutlineAction}
        title="Import outline"
        icon="document"
        variant="secondary"
        size="sm"
        submit="Import"
        wide
      >
        <input type="hidden" name="meetingId" value={meeting.id} />
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
        variant="secondary"
        size="sm"
        submit="Add"
      >
        <input type="hidden" name="meetingId" value={meeting.id} />
        <Field label="Title" required>
          <Input name="title" required />
        </Field>
      </FormModal>
      <QuickAdd presets={{ targetMeetingId: meeting.id }} />
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

  return (
    <>
      {parent ? (
        <Link
          href={`/meetings/${parent.id}`}
          className="mb-2 inline-flex items-center gap-1 text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          <Icon name="chevronDown" className="h-4 w-4 rotate-90" />
          {parent.title}
        </Link>
      ) : null}

      <PageHeader
        title={meeting.title}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <CopyButton
              label="Copy brief"
              variant="primary"
              text={renderBrief(brief)}
              html={renderBriefHtml(brief)}
            />
            <CopyButton label="Copy agenda" text={renderAgenda(brief)} html={renderAgendaHtml(brief)} />
            <ButtonLink href={`/meetings/${meeting.id}/review`} variant="secondary">
              Review
              <PendingBadge count={pending.get(meeting.id)} />
            </ButtonLink>
            <ButtonLink href={`/meetings/${meeting.id}/recap`} variant="secondary">
              Recap
            </ButtonLink>
            <FormModal action={updateMeetingAction} title="Edit" label="Edit" variant="secondary">
              <input type="hidden" name="id" value={meeting.id} />
              <MeetingFields
                meeting={meeting}
                choices={choices}
                timeZone={timeZone}
              />
            </FormModal>
            {/* A session goes where its meeting goes. */}
            {parent ? null : (
              <MoveTo
                action={moveMeetingAction}
                id={meeting.id}
                contexts={contexts.filter((one) => one.id !== context.id)}
              />
            )}
            <FormModal
              action={deleteMeetingAction}
              title="Delete meeting"
              icon="trash"
              variant="secondary"
              submit="Delete"
              danger
            >
              <input type="hidden" name="id" value={meeting.id} />
            </FormModal>
          </div>
        }
      />

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
        {meeting.group ? (
          <Chip href={`/groups/${meeting.group.id}`} icon="group">
            {meeting.group.name}
          </Chip>
        ) : null}
        {meeting.people.map((person) => (
          <Chip key={person.id} href={`/people/${person.id}`} icon="person">
            {person.name}
          </Chip>
        ))}
        {meeting.projects.map((project) => (
          <Chip key={project.id} href={`/projects/${project.id}`} icon="project">
            {project.name}
          </Chip>
        ))}
      </div>

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
                />
              ))}
            </div>
          </Section>
        </>
      ) : (
        <>
          <Section title="Agenda" action={agendaTools}>
            <AgendaCard agenda={agenda} today={today} people={leaders} />
          </Section>
          <Suggestions candidates={candidates} meetingId={meeting.id} />
        </>
      )}

      <Blocks
        meetingId={meeting.id}
        settings={meeting.blocks}
        blocks={blocks}
        today={today}
        timeZone={timeZone}
      />

      {/* One level only: a session has no sessions of its own. */}
      {rollup || parent ? null : <Section title="Sessions" count={0} action={addSession}>{null}</Section>}
    </>
  )
}
