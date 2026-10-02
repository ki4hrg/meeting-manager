import { dismissNoteAction, fileNoteAction } from '@/app/(app)/meetings/processing-actions'
import { ActionButton, FormModal, IconAction } from '@/components/forms'
import { Card } from '@/components/ui/Card'
import { Field, Select } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import type { UnfiledNote } from '@/lib/connect/granola/unfiled'
import { formatMoment } from '@/lib/core/dates'
import { Roster, When } from './MeetingCard'

type Option = { id: string; name: string }

/**
 * A Granola note no folder filed: when it was and who was there, filed into a
 * context with one click (the selected one) or waved away. With several
 * contexts, File asks which, starting from the selected one.
 */
export function UnfiledCard({
  note,
  contexts,
  current,
  timeZone,
}: {
  note: UnfiledNote
  contexts: Option[]
  current: string
  timeZone: string | null
}) {
  const people = note.attendees.map((attendee) => ({ name: attendee.name ?? attendee.email }))
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
        <IconAction action={dismissNoteAction} fields={{ noteId: note.id }} icon="close" label="Dismiss" />
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
