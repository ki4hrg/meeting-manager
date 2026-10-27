/*
 * What a meeting's page shows once there is something to review: the notes,
 * how far processing has got, and the proposals waiting, accepted and
 * rejected. It was a page of its own; it is now part of the meeting's, so what
 * came of a meeting is reviewed beside its agenda and outcomes.
 */

import { GranolaChip } from '@/components/GranolaChip'
import { ActionSelect } from '@/components/ActionSelect'
import { ActionButton, FormModal, IconAction } from '@/components/forms'
import { ApproveAll } from '@/components/processing/ApproveAll'
import { ProposalCard } from '@/components/processing/ProposalCard'
import { RunState } from '@/components/processing/RunState'
import { UnknownAttendee } from '@/components/processing/UnknownAttendee'
import { Card, CardGrid, Section } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Field, Textarea } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import { knownPeople } from '@/lib/connect/granola/ingest'
import { formatMoment } from '@/lib/core/dates'
import { db } from '@/lib/db'
import type { RollCallEntry } from '@/lib/meetings/attendance'
import { sittingBefore, type MeetingView } from '@/lib/meetings/meetings'
import { unknownAttendees } from '@/lib/notes/attendees'
import { listNotes } from '@/lib/notes/notes'
import { listProposals, type ProposalView } from '@/lib/processing/proposals'
import { latestRun } from '@/lib/processing/run'
import {
  addNoteAction,
  makeSessionOfAction,
  moveNoteAction,
  ownMeetingFromNoteAction,
  sessionFromNoteAction,
} from '../processing-actions'

const SUMMARY =
  'mb-4 flex cursor-pointer list-none items-center gap-2 rounded-md text-lg font-semibold text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-100 [&::-webkit-details-marker]:hidden'

const GROUP = 'mb-2 flex items-center gap-1.5 text-sm font-medium text-gray-600 dark:text-gray-300'

/* How a note reads in a list: its title, or the line it starts with. */
const firstLine = (note: { title: string | null; body: string }) =>
  note.title ?? note.body.split('\n').find((line) => line.trim() !== '')?.trim() ?? '—'

type Choices = Parameters<typeof ProposalCard>[0]['choices']

/**
 * The review's pieces, each placed by the meeting's page: Approve all and
 * "Session of" go in its header; the run, strangers and proposals under its
 * attendance; the notes in its main column.
 */
export async function reviewOf({
  meeting,
  parent,
  choices,
  people,
  groups,
  roll,
  today,
  selfId,
  timeZone,
}: {
  meeting: MeetingView
  parent: MeetingView | null
  choices: Choices
  people: Array<{ id: string; name: string; isSelf: boolean }>
  groups: Parameters<typeof UnknownAttendee>[0]['groups']
  /** The roll call, to which the notes' own attendees are offered. */
  roll: RollCallEntry[]
  today: string
  selfId: string
  timeZone: string | null
}) {
  const [run, proposals, notes, strangers, before] = await Promise.all([
    latestRun(db, meeting.id),
    listProposals(db, meeting.id),
    listNotes(db, meeting.id),
    unknownAttendees(db, meeting.id),
    sittingBefore(db, meeting),
  ])

  /* The notes' own attendees, when in the directory, are offered on the list,
     not yet said; they never take anyone off. */
  const listed = new Set(roll.map((entry) => entry.id))
  const named = await knownPeople(
    db,
    notes.flatMap((note) => note.attendees.map((attendee) => attendee.email)),
  )
  for (const person of people) {
    if (named.includes(person.id) && !listed.has(person.id)) {
      roll.push({ id: person.id, name: person.name, mark: null, via: 'person', groupId: null })
    }
  }

  const cards = (list: ProposalView[]) => (
    <CardGrid>
      {list.map((proposal) => (
        <ProposalCard
          key={proposal.id}
          proposal={proposal}
          choices={choices}
          today={today}
          selfId={selfId}
          meetingTitle={meeting.title}
        />
      ))}
    </CardGrid>
  )

  const pending = proposals.filter((proposal) => proposal.status === 'pending')
  const accepted = proposals.filter((proposal) => proposal.status === 'accepted')
  const rejected = proposals.filter((proposal) => proposal.status === 'rejected')
  // What approve-all passes over: a guess, or a name still to be settled.
  const needsLook = (proposal: ProposalView) => proposal.ownerGuessed || proposal.unresolved.length > 0
  const unsure = pending.filter(needsLook)
  const ready = pending.filter((proposal) => !needsLook(proposal))

  /* A note can be filed on the meeting or on any of its sessions; with no
     sessions there is nowhere else for it to go and no picker. */
  const family = parent ?? meeting
  const places = family.sessions.length > 0 ? [family, ...family.sessions] : []
  /* Two notes on one meeting may be two conversations: either can become a
     session of it (it reconvened) or a meeting of its own (a 1:1 after). */
  const splits = !meeting.parentMeetingId && notes.length > 1

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
      {notes.length === 0 ? null : (
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
                  {formatMoment(note.createdAt, timeZone)}
                </span>
                {note.source === 'granola' && note.externalId ? <GranolaChip noteId={note.externalId} compact /> : null}
                {places.length > 0 ? (
                  <ActionSelect
                    key={note.meetingId}
                    action={moveNoteAction}
                    fields={{ noteId: note.id }}
                    name="meetingId"
                    value={note.meetingId}
                    label="Session"
                    className="!w-auto min-w-0 max-w-full !py-1 text-xs sm:!text-xs"
                  >
                    {places.map((place) => (
                      <option key={place.id} value={place.id}>
                        {place.title}
                      </option>
                    ))}
                  </ActionSelect>
                ) : null}
                {splits ? (
                  <>
                    <IconAction
                      action={sessionFromNoteAction}
                      fields={{ noteId: note.id }}
                      icon="section"
                      label="New session"
                    />
                    <IconAction
                      action={ownMeetingFromNoteAction}
                      fields={{ noteId: note.id }}
                      icon="meeting"
                      label="Own meeting"
                    />
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Section>
  )

  /* Proposals waiting, the guesses first; then what was decided on them:
     accepted ones open, for their Undo, rejected ones folded away. */
  const decided = (title: string, list: ProposalView[], open: boolean) =>
    list.length > 0 ? (
      <details className="group mb-8" open={open}>
        <summary className={SUMMARY}>
          {title}
          <span className="text-sm font-normal tabular-nums text-gray-500 dark:text-gray-400">{list.length}</span>
          <Icon
            name="chevronDown"
            className="h-4 w-4 text-gray-400 transition-transform group-open:rotate-180 dark:text-gray-500"
          />
        </summary>
        {cards(list)}
      </details>
    ) : null

  const body = (
    <div id="review" className="scroll-mt-4">
      {run ? (
        <div className="mb-8 flex flex-wrap items-center gap-2">
          <RunState run={run} meetingId={meeting.id} />
        </div>
      ) : null}
      {strangers.length > 0 ? (
        <div className="mb-8 flex flex-wrap items-center gap-2">
          <Icon name="group" className="h-4 w-4 text-gray-400 dark:text-gray-500" label="Not in the directory" />
          {strangers.map((one) => (
            <UnknownAttendee
              key={one.email}
              meetingId={meeting.id}
              email={one.email}
              name={one.name}
              people={people.filter((person) => !person.isSelf)}
              groups={groups}
            />
          ))}
        </div>
      ) : null}
      {/* A note waiting to be told which session it belongs to comes first. */}
      {places.length > 0 ? noteList : null}
      {pending.length > 0 ? (
        <Section title="To review" count={pending.length}>
          <div className="flex flex-col gap-5">
            {unsure.length > 0 ? (
              <div>
                <h3 className={GROUP}>
                  <Icon name="alert" className="h-4 w-4" />
                  Check
                  <span className="font-normal tabular-nums text-gray-500 dark:text-gray-400">{unsure.length}</span>
                </h3>
                {cards(unsure)}
              </div>
            ) : null}
            {ready.length > 0 ? (
              <div>
                {unsure.length > 0 ? (
                  <h3 className={GROUP}>
                    <Icon name="check" className="h-4 w-4" />
                    Ready
                    <span className="font-normal tabular-nums text-gray-500 dark:text-gray-400">{ready.length}</span>
                  </h3>
                ) : null}
                {cards(ready)}
              </div>
            ) : null}
          </div>
        </Section>
      ) : proposals.length === 0 && run?.status === 'done' ? (
        <div className="mb-8">
          <EmptyState icon="check" />
        </div>
      ) : null}
      {decided('Accepted', accepted, true)}
      {decided('Rejected', rejected, false)}
    </div>
  )

  return {
    /* Whether there is anything to review yet: a note, a proposal or a run. */
    any: notes.length > 0 || proposals.length > 0 || run !== null,
    pending: pending.length,
    /* The page's one blue button while anything is ready. */
    approveAll: ready.length > 0 ? <ApproveAll meetingId={meeting.id} count={ready.length} /> : null,
    /* A meeting just after another may be its next sitting: John says so. */
    sessionOf: before ? (
      <ActionButton
        action={makeSessionOfAction}
        fields={{ meetingId: meeting.id, parentId: before.id }}
        variant="secondary"
        className="max-w-full"
      >
        <Icon name="section" className="h-4 w-4 shrink-0" />
        <span className="truncate">Session of {before.title}</span>
      </ActionButton>
    ) : null,
    body,
    /* With no sessions to file into, the notes sit in the main column. */
    notes: places.length > 0 ? null : noteList,
  }
}
