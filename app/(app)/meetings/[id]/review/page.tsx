import { notFound } from 'next/navigation'
import { ActionSelect } from '@/components/ActionSelect'
import { FormModal } from '@/components/forms'
import { LivesIn } from '@/components/meetings/Move'
import { ApproveAll } from '@/components/processing/ApproveAll'
import { ProposalCard } from '@/components/processing/ProposalCard'
import { RunState } from '@/components/processing/RunState'
import { UnknownAttendee } from '@/components/processing/UnknownAttendee'
import { ButtonLink } from '@/components/ui/Button'
import { Card, CardGrid, Section } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Field, Textarea } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import { PageHeader } from '@/components/ui/PageHeader'
import { formatMoment } from '@/lib/core/dates'
import { isUuid } from '@/lib/core/match'
import { NotFoundError } from '@/lib/core/types'
import { db } from '@/lib/db'
import { listGroups } from '@/lib/directory/groups'
import { listPeople } from '@/lib/directory/people'
import { getMeeting } from '@/lib/meetings/meetings'
import { unknownAttendees } from '@/lib/notes/attendees'
import { listNotes } from '@/lib/notes/notes'
import { listProposals, type ProposalView } from '@/lib/processing/proposals'
import { latestRun } from '@/lib/processing/run'
import { listProjectChoices } from '@/lib/projects/projects'
import { allContexts, requireContext, viewer } from '@/lib/web/context'
import { openMeetingAction } from '../../actions'
import { addNoteAction, moveNoteAction } from '../../processing-actions'

const SUMMARY =
  'mb-4 flex cursor-pointer list-none items-center gap-2 rounded-md text-lg font-semibold text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-100 [&::-webkit-details-marker]:hidden'

/* How a note reads in a list: its title, or the line it starts with. */
const firstLine = (note: { title: string | null; body: string }) =>
  note.title ?? note.body.split('\n').find((line) => line.trim() !== '')?.trim() ?? '—'

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) notFound()

  const context = await requireContext()
  const { user, self, today } = await viewer()

  const meeting = await getMeeting(db, id).catch((err) => {
    if (err instanceof NotFoundError) notFound()
    throw err
  })
  /* As on the meeting's own page: with another context selected, nothing of it is drawn. */
  if (meeting.contextId !== context.id) {
    const home = (await allContexts()).find((one) => one.id === meeting.contextId)
    if (!home) notFound()
    return <LivesIn title={meeting.title} context={home} action={openMeetingAction} id={meeting.id} />
  }

  const [run, proposals, notes, parent, people, groups, projects, strangers] = await Promise.all([
    latestRun(db, id),
    listProposals(db, id),
    listNotes(db, id),
    meeting.parentMeetingId ? getMeeting(db, meeting.parentMeetingId) : null,
    listPeople(db),
    listGroups(db, context.id),
    listProjectChoices(db, context.id),
    unknownAttendees(db, id),
  ])

  const choices = { people, groups, projects }
  const cards = (list: ProposalView[]) => (
    <CardGrid>
      {list.map((proposal) => (
        <ProposalCard
          key={proposal.id}
          proposal={proposal}
          choices={choices}
          today={today}
          selfId={self.id}
        />
      ))}
    </CardGrid>
  )

  const pending = proposals.filter((proposal) => proposal.status === 'pending')
  const accepted = proposals.filter((proposal) => proposal.status === 'accepted')
  const rejected = proposals.filter((proposal) => proposal.status === 'rejected')
  // What approve-all passes over: a guess, or a name still to be settled.
  const needsLook = (proposal: ProposalView) => proposal.lowConfidence || proposal.unresolved.length > 0
  const unsure = pending.filter(needsLook)
  const ready = pending.filter((proposal) => !needsLook(proposal))

  /* A note can be filed on the meeting or on any of its sessions; with no
     sessions there is nowhere else for it to go and no picker. */
  const family = parent ?? meeting
  const places = family.sessions.length > 0 ? [family, ...family.sessions] : []

  const addNote = (
    <FormModal
      action={addNoteAction}
      title="Add a note"
      label="Note"
      icon="plus"
      variant="secondary"
      size="sm"
      submit="Add"
      wide
    >
      <input type="hidden" name="meetingId" value={meeting.id} />
      <Field label="Notes" required>
        <Textarea name="body" rows={12} required />
      </Field>
    </FormModal>
  )

  const noteList = (
    <Section title="Notes" count={notes.length} action={addNote}>
      {notes.length === 0 ? (
        <EmptyState icon="clipboard" />
      ) : (
        <Card>
          <ul className="divide-y divide-gray-100 dark:divide-gray-700">
            {notes.map((note) => (
              <li key={note.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2 first:pt-0 last:pb-0">
                <Icon
                  name={note.source === 'granola' ? 'sparkles' : 'clipboard'}
                  className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500"
                  label={note.source === 'granola' ? 'Granola' : 'Pasted'}
                />
                <span className="min-w-0 flex-1 basis-[calc(100%-2rem)] truncate text-sm font-medium text-gray-900 sm:basis-0 dark:text-gray-100">
                  {firstLine(note)}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-gray-500 dark:text-gray-400">
                  {formatMoment(note.createdAt, user.timeZone)}
                </span>
                {places.length > 0 ? (
                  <ActionSelect
                    key={note.meetingId}
                    action={moveNoteAction}
                    fields={{ noteId: note.id }}
                    name="meetingId"
                    value={note.meetingId}
                    label="Session"
                    className="!w-auto max-w-full !py-1 text-xs sm:!text-xs"
                  >
                    {places.map((place) => (
                      <option key={place.id} value={place.id}>
                        {place.title}
                      </option>
                    ))}
                  </ActionSelect>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Section>
  )

  return (
    <>
      <PageHeader
        title="Review"
        crumbs={[
          { href: '/meetings', label: 'Meetings' },
          ...(parent ? [{ href: `/meetings/${parent.id}`, label: parent.title }] : []),
          { href: `/meetings/${meeting.id}`, label: meeting.title },
        ]}
        count={pending.length}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {ready.length > 0 ? <ApproveAll meetingId={meeting.id} count={ready.length} /> : null}
            <ButtonLink href={`/meetings/${meeting.id}/recap`} variant="secondary">
              <Icon name="document" className="h-4 w-4" />
              Recap
            </ButtonLink>
          </div>
        }
      />

      {run ? (
        <div className="mb-8 flex flex-wrap items-center gap-2">
          <RunState run={run} meetingId={meeting.id} />
        </div>
      ) : null}

      {/* Who was there comes before what was said: a name settled here is one
          the proposals below can be given to. */}
      {strangers.length > 0 ? (
        <div className="mb-8 flex flex-wrap items-center gap-2">
          <Icon
            name="group"
            className="h-4 w-4 text-gray-400 dark:text-gray-500"
            label="Not in the directory"
          />
          {strangers.map((one) => (
            <UnknownAttendee
              key={one.email}
              meetingId={meeting.id}
              email={one.email}
              name={one.name}
              people={people.filter((person) => !person.isSelf)}
            />
          ))}
        </div>
      ) : null}

      {/* A note waiting to be told which session it belongs to comes first. */}
      {places.length > 0 ? noteList : null}

      {pending.length > 0 ? (
        <div className="mb-8 flex flex-col gap-5">
          {unsure.length > 0 ? (
            <div>
              <h2 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-gray-600 dark:text-gray-300">
                <Icon name="alert" className="h-4 w-4" />
                Check
                <span className="font-normal tabular-nums text-gray-500 dark:text-gray-400">{unsure.length}</span>
              </h2>
              {cards(unsure)}
            </div>
          ) : null}
          {ready.length > 0 ? (
            <div>
              {unsure.length > 0 ? (
                <h2 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-gray-600 dark:text-gray-300">
                  <Icon name="check" className="h-4 w-4" />
                  Ready
                  <span className="font-normal tabular-nums text-gray-500 dark:text-gray-400">{ready.length}</span>
                </h2>
              ) : null}
              {cards(ready)}
            </div>
          ) : null}
        </div>
      ) : proposals.length === 0 && run?.status === 'done' ? (
        <div className="mb-8">
          <EmptyState icon="check" />
        </div>
      ) : null}

      {accepted.length > 0 ? (
        <Section title="Accepted" count={accepted.length}>
          {cards(accepted)}
        </Section>
      ) : null}

      {rejected.length > 0 ? (
        <details className="group mb-8">
          <summary className={SUMMARY}>
            Rejected
            <span className="text-sm font-normal tabular-nums text-gray-500 dark:text-gray-400">
              {rejected.length}
            </span>
            <Icon
              name="chevronDown"
              className="h-4 w-4 text-gray-400 transition-transform group-open:rotate-180 dark:text-gray-500"
            />
          </summary>
          {cards(rejected)}
        </details>
      ) : null}

      {places.length > 0 ? null : noteList}
    </>
  )
}
