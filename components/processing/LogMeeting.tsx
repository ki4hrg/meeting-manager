import { logMeetingAction } from '@/app/(app)/meetings/processing-actions'
import { FormModal } from '@/components/forms'
import { WhenFields } from '@/components/meetings/MeetingFields'
import { CheckList } from '@/components/ui/CheckList'
import { Field, Input, Textarea } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import { PartyPicker } from './PartyPicker'

type Option = { id: string; name: string }

/**
 * Log a meeting that has already happened: who was there and what was written
 * down. People and notes are all a drop-in needs; the rest is folded away.
 */
export function LogMeeting({
  people,
  groups,
  projects,
  timeZone,
}: {
  people: Option[]
  groups: Option[]
  projects: Option[]
  timeZone: string | null
}) {
  return (
    <FormModal
      action={logMeetingAction}
      title="Log a meeting"
      label="Log"
      icon="clipboard"
      variant="secondary"
      submit="Log"
      wide
    >
      <PartyPicker
        label="People"
        name="people"
        options={[
          ...people.map((person) => ({ value: person.id, name: person.name, icon: 'person' as const })),
          ...groups.map((group) => ({ value: `group:${group.id}`, name: group.name, icon: 'group' as const })),
        ]}
        me
      />
      <Field label="Notes" required>
        <Textarea name="notes" rows={10} required placeholder={'D: \nQ: \nA: \nT: '} />
      </Field>

      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-1 rounded-md text-sm font-medium text-gray-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 [&::-webkit-details-marker]:hidden">
          <Icon name="chevronDown" className="h-4 w-4 transition-transform group-open:rotate-180" />
          More
        </summary>
        <div className="mt-3 flex flex-col gap-4">
          <Field label="Title">
            <Input name="title" />
          </Field>
          <WhenFields timeZone={timeZone} />
          <CheckList label="Projects" name="projectIds" options={projects} />
        </div>
      </details>
    </FormModal>
  )
}
