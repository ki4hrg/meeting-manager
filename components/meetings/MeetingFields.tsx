import { PartyPicker } from '@/components/processing/PartyPicker'
import { CheckList } from '@/components/ui/CheckList'
import { Field, Input, Select } from '@/components/ui/Field'
import { toLocalInput } from '@/lib/core/dates'
import { WhenInputs } from './WhenInputs'

type Option = { id: string; name: string }

export type MeetingChoices = {
  people: Option[]
  groups: Option[]
  projects: Option[]
  series: Option[]
}

type Current = {
  title: string
  startsAt: Date | null
  endsAt: Date | null
  people: Option[]
  projects: Option[]
  group: Option | null
  series: Option | null
}

/** When a meeting is: a start and an end on the user's clock. Both empty is an undated stub. */
export function WhenFields({
  startsAt,
  endsAt,
  timeZone,
}: {
  startsAt?: Date | null
  endsAt?: Date | null
  timeZone: string | null
}) {
  return (
    <WhenInputs
      starts={startsAt ? toLocalInput(startsAt, timeZone) : ''}
      ends={endsAt ? toLocalInput(endsAt, timeZone) : ''}
    />
  )
}

/** The fields of a meeting, for making one by hand and for editing one. */
export function MeetingFields({
  meeting,
  choices,
  timeZone,
}: {
  meeting?: Current
  choices: MeetingChoices
  timeZone: string | null
}) {
  return (
    <>
      <Field label="Title" required={Boolean(meeting)}>
        <Input name="title" defaultValue={meeting?.title ?? ''} required={Boolean(meeting)} />
      </Field>
      <WhenFields startsAt={meeting?.startsAt} endsAt={meeting?.endsAt} timeZone={timeZone} />

      {/* The same pickers as a series' roster and projects. Empty lists draw nothing. */}
      <PartyPicker
        label="People"
        name="personIds"
        options={choices.people.map((person) => ({ value: person.id, name: person.name, icon: 'person' }))}
        selected={meeting?.people.map((person) => ({ value: person.id, name: person.name, icon: 'person' }))}
        allowNew
      />
      <CheckList
        label="Projects"
        name="projectIds"
        options={choices.projects}
        selected={meeting?.projects.map((project) => project.id)}
      />

      {choices.groups.length + choices.series.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {choices.groups.length > 0 ? (
            <Field label="Group">
              <Select name="groupId" defaultValue={meeting?.group?.id ?? ''}>
                <option value="">—</option>
                {choices.groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {choices.series.length > 0 ? (
            <Field label="Series">
              <Select name="seriesId" defaultValue={meeting?.series?.id ?? ''}>
                <option value="">—</option>
                {choices.series.map((series) => (
                  <option key={series.id} value={series.id}>
                    {series.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
