import { dismissNoteAction, fileNoteAction } from '@/app/(app)/meetings/processing-actions'
import { ActionButton, FormModal, IconAction } from '@/components/forms'
import { Card } from '@/components/ui/Card'
import { Field, Select } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import type { UnfiledNote } from '@/lib/connect/granola/unfiled'
import { formatMoment } from '@/lib/core/dates'
import type { MeetingView } from '@/lib/meetings/meetings'
import { Roster, When } from './MeetingCard'

type Option = { id: string; name: string }

type Choice = Pick<MeetingView, 'id' | 'title' | 'startsAt' | 'sessions'>

/**
 * A Granola note no folder filed: when it was and who was there, filed into a
 * context with one click (the selected one) or waved away. With several
 * contexts, File asks which, starting from the selected one. The footer shows
 * where File would put it in the selected context; Link picks the meeting.
 */
export function UnfiledCard({
  note,
  contexts,
  current,
  timeZone,
  match,
  choices,
}: {
  note: UnfiledNote
  contexts: Option[]
  current: string
  timeZone: string | null
  /** The meeting File would use in the selected context; null for a new one. */
  match: Choice | null
  /** The selected context's meetings nearest the note. */
  choices: Choice[]
}) {
  const people = note.attendees.map((attendee) => ({ name: attendee.name ?? attendee.email }))
  const when = (at: Date | null) => (at ? ` · ${formatMoment(at, timeZone)}` : '')
  return (
    <Card>
      <div className="flex items-start gap-3">
        <When label={note.startsAt ? formatMoment(note.startsAt, timeZone) : null} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <Icon name="sparkles" className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" label="Granola" />
            <span className="truncate">{note.title ?? 'Meeting'}</span>
          </p>
          <Roster people={people} />
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end gap-1 border-t border-gray-100 pt-2 dark:border-gray-700">
        <span className="mr-auto flex min-w-0 items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
          <Icon name={match ? 'meeting' : 'plus'} className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            {match ? `${match.title}${when(match.startsAt)}` : 'New meeting'}
          </span>
        </span>
        <IconAction action={dismissNoteAction} fields={{ noteId: note.id }} icon="close" label="Dismiss" />
        {choices.length > 0 ? (
          <FormModal action={fileNoteAction} title="Link" label="Link" variant="secondary" size="sm" submit="Link">
            <input type="hidden" name="noteId" value={note.id} />
            <input type="hidden" name="contextId" value={current} />
            <Field label="Meeting" required>
              <Select name="meetingId" required defaultValue={match?.id ?? ''}>
                <option value="" disabled>
                  —
                </option>
                {/* A meeting with sessions takes a session, so it is a heading over them. */}
                {choices.map((choice) =>
                  choice.sessions.length > 0 ? (
                    <optgroup key={choice.id} label={`${choice.title}${when(choice.startsAt)}`}>
                      {choice.sessions.map((session) => (
                        <option key={session.id} value={session.id}>
                          {`${session.title}${when(session.startsAt)}`}
                        </option>
                      ))}
                    </optgroup>
                  ) : (
                    <option key={choice.id} value={choice.id}>
                      {`${choice.title}${when(choice.startsAt)}`}
                    </option>
                  ),
                )}
              </Select>
            </Field>
          </FormModal>
        ) : null}
        {contexts.length > 1 ? (
          <FormModal action={fileNoteAction} title="File" label="File" size="sm" submit="File">
            <input type="hidden" name="noteId" value={note.id} />
            <Field label="Context" required>
              <Select name="contextId" required defaultValue={current}>
                {contexts.map((context) => (
                  <option key={context.id} value={context.id}>
                    {context.name}
                  </option>
                ))}
              </Select>
            </Field>
          </FormModal>
        ) : (
          <ActionButton action={fileNoteAction} fields={{ noteId: note.id, contextId: current }} size="sm">
            File
          </ActionButton>
        )}
      </div>
    </Card>
  )
}
