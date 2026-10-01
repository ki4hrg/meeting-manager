import Link from 'next/link'
import { notFound } from 'next/navigation'
import { CopyButton } from '@/components/CopyButton'
import { FormModal } from '@/components/forms'
import { AgendaCard } from '@/components/meetings/AgendaCard'
import { Blocks } from '@/components/meetings/Blocks'
import { MeetingCard } from '@/components/meetings/MeetingCard'
import { MeetingFields, WhenFields } from '@/components/meetings/MeetingFields'
import { Suggestions } from '@/components/meetings/Suggestions'
import { QuickAdd } from '@/components/QuickAdd'
import { CardGrid, Section } from '@/components/ui/Card'
import { Chip } from '@/components/ui/Chip'
import { Field, Input, Textarea } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/StatusBadge'
import { renderAgenda, renderAgendaHtml, renderBrief, renderBriefHtml } from '@/lib/agenda/brief'
import { getCandidates, placeAutomatic } from '@/lib/agenda/candidates'
import { computeBlocks } from '@/lib/agenda/generated'
import { getAgenda } from '@/lib/agenda/lines'
import { formatMoment, formatTime, formatWeekday, todayIn } from '@/lib/core/dates'
import { isUuid } from '@/lib/core/match'
import { NotFoundError } from '@/lib/core/types'
import { db } from '@/lib/db'
import { listGroups } from '@/lib/directory/groups'
import { listPeople } from '@/lib/directory/people'
import { getMeeting, isOver } from '@/lib/meetings/meetings'
import { listSeries } from '@/lib/meetings/series'
import { listProjects } from '@/lib/projects/projects'
import { requireContext, viewer, webActor } from '@/lib/web/context'
import {
  addSectionAction,
  addSessionAction,
  deleteMeetingAction,
  importOutlineAction,
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
  // A meeting belongs to its context: with another one selected it is not here.
  if (meeting.contextId !== context.id) notFound()

  const day = meeting.startsAt ? todayIn(timeZone, meeting.startsAt) : null
  /* Until the meeting is over, whatever places itself is put on the agenda
     before it is read, so routine prep is opening the page. */
  if (!isOver(meeting)) await placeAutomatic(db, webActor(user), id)

  const [agenda, candidates, blocks, parent, people, groups, projects, series] = await Promise.all([
    getAgenda(db, id, { timeZone }),
    getCandidates(db, id),
    computeBlocks(db, id, { today }),
    meeting.parentMeetingId ? getMeeting(db, meeting.parentMeetingId) : null,
    listPeople(db),
    listGroups(db, context.id),
    listProjects(db, context.id),
    listSeries(db, context.id),
  ])

  const brief = { meeting, agenda, blocks, timeZone, today }
  const choices = {
    people: people.filter((person) => !person.isSelf),
    groups,
    projects: projects.filter(
      (project) => project.status !== 'done' || meeting.projects.some((p) => p.id === project.id),
    ),
    series,
  }

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
            <FormModal action={updateMeetingAction} title="Edit" label="Edit" variant="secondary">
              <input type="hidden" name="id" value={meeting.id} />
              <MeetingFields meeting={meeting} choices={choices} timeZone={timeZone} />
            </FormModal>
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
        {meeting.startsAt && day ? (
          <span className="mr-1 flex items-center gap-1.5 text-sm font-medium text-gray-700 dark:text-gray-300">
            <Icon name="meeting" className="h-4 w-4 text-gray-400 dark:text-gray-500" />
            {formatWeekday(day, today)}
            <span className="tabular-nums">
              {formatTime(meeting.startsAt, timeZone)}
              {meeting.endsAt ? ` – ${formatTime(meeting.endsAt, timeZone)}` : ''}
            </span>
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

      <Section
        title="Agenda"
        action={
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
        }
      >
        <AgendaCard agenda={agenda} today={today} />
      </Section>

      <Suggestions candidates={candidates} meetingId={meeting.id} />

      <Blocks
        meetingId={meeting.id}
        settings={meeting.blocks}
        blocks={blocks}
        today={today}
        timeZone={timeZone}
      />

      {/* One level only: a session has no sessions of its own. */}
      {parent ? null : (
        <Section
          title="Sessions"
          count={meeting.sessions.length}
          action={
            <FormModal
              action={addSessionAction}
              title="New session"
              label="Add"
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
          }
        >
          {meeting.sessions.length > 0 ? (
            <CardGrid>
              {meeting.sessions.map((session) => (
                <MeetingCard
                  key={session.id}
                  meeting={{ ...session, people: [] }}
                  when={session.startsAt ? formatMoment(session.startsAt, timeZone) : null}
                />
              ))}
            </CardGrid>
          ) : null}
        </Section>
      )}
    </>
  )
}
