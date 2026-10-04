import { PartyPicker } from '@/components/processing/PartyPicker'
import { CheckList } from '@/components/ui/CheckList'
import { Field, Input, Select } from '@/components/ui/Field'
import { toLocalInput } from '@/lib/core/dates'
import { DayEvents } from './DayEvents'
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
  offerEvents = false,
}: {
  meeting?: Current
  choices: MeetingChoices
  timeZone: string | null
  /** New meetings only: the chosen day's calendar events, to prep one instead. */
  offerEvents?: boolean
}) {
  return (
    <>
      <Field label="Title" required={Boolean(meeting)}>
        <Input name="title" defaultValue={meeting?.title ?? ''} required={Boolean(meeting)} />
      </Field>
      <WhenFields startsAt={meeting?.startsAt} endsAt={meeting?.endsAt} timeZone={timeZone} />
      {offerEvents ? <DayEvents /> : null}

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
        me
      />
      <CheckList
        label="Projects"
        name="projectIds"
        options={choices.projects}
        selected={meeting?.projects.map((project) => project.id)}
      />

      {/* Someone added here can join the series' roster too, and so its next meetings. */}
      {meeting?.series ? (
        <label className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            name="toSeries"
            className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
          />
          Also add to {meeting.series.name}
        </label>
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
    </>
  )
}
