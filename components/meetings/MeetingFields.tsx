import { CheckList } from '@/components/ui/CheckList'
import { Field, Input, Select } from '@/components/ui/Field'
import { toLocalInput } from '@/lib/core/dates'

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

/** When a meeting is: a start on the user's clock and a length. Both empty is an undated stub. */
export function WhenFields({
  startsAt,
  endsAt,
  timeZone,
}: {
  startsAt?: Date | null
  endsAt?: Date | null
  timeZone: string | null
}) {
  const length = startsAt && endsAt ? Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000) : ''
  return (
    <div className="grid grid-cols-[1fr_6rem] gap-3">
      <Field label="Starts">
        <Input
          name="startsAt"
          type="datetime-local"
          defaultValue={startsAt ? toLocalInput(startsAt, timeZone) : ''}
        />
      </Field>
      <Field label="Minutes">
        <Input name="length" type="number" min={0} step={5} inputMode="numeric" defaultValue={length} />
      </Field>
    </div>
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
      <CheckList
        label="People"
        name="personIds"
        options={choices.people}
        selected={meeting?.people.map((person) => person.id)}
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
