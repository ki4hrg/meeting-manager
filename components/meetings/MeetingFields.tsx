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
  groups: Option[]
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

      {/* The same pickers as a series' roster and projects. Groups sit among the
          people, each standing for its members. Empty lists draw nothing. */}
      <PartyPicker
        label="People"
        name="personIds"
        options={[
          ...choices.people.map((person) => ({ value: person.id, name: person.name, icon: 'person' as const })),
          ...choices.groups.map((group) => ({ value: `group:${group.id}`, name: group.name, icon: 'group' as const })),
        ]}
        selected={[
          ...(meeting?.groups ?? []).map((group) => ({ value: `group:${group.id}`, name: group.name, icon: 'group' as const })),
          ...(meeting?.people ?? []).map((person) => ({ value: person.id, name: person.name, icon: 'person' as const })),
        ]}
        allowNew
      />
      <CheckList
        label="Projects"
        name="projectIds"
        options={choices.projects}
        selected={meeting?.projects.map((project) => project.id)}
      />

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
    </>
  )
}
