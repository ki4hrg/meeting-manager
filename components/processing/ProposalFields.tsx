import { Field, Input, Select, Textarea } from '@/components/ui/Field'
import type { MissingDetail } from '@/lib/processing/missing'
import { roleLabel } from '@/lib/items/roles'
import type { ProposalParty, ProposalView } from '@/lib/processing/proposals'
import { ItemFields } from './ItemFields'
import { PartyPicker, type PartyOption } from './PartyPicker'

type Option = { id: string; name: string }

export type ProposalChoices = {
  people: Option[]
  groups: Option[]
  projects: Option[]
  /** Where an item can be raised: the context's series. */
  series?: Option[]
}

/* What an update does to its item, as the select and the card both word it. */
export const CHANGES = {
  complete: 'Done',
  answer: 'Answered',
  drop: 'Dropped',
  note: 'Note',
  discussed: 'Discussed',
} as const

const picked = (party: ProposalParty): PartyOption =>
  party.unresolved || !party.type
    ? { value: `name:${party.name}`, name: party.name, icon: 'alert' }
    : { value: `${party.type}:${party.id}`, name: party.name, icon: party.type }

function ProjectField({ projects, value }: { projects: Option[]; value: string | null | undefined }) {
  if (projects.length === 0) return null
  return (
    <Field label="Project">
      <Select name="projectId" defaultValue={value ?? ''}>
        <option value="">—</option>
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </Select>
    </Field>
  )
}

function SeriesField({ series, value }: { series: Option[]; value: string | null | undefined }) {
  if (series.length === 0) return null
  return (
    <Field label="Raise at">
      <Select name="seriesId" defaultValue={value ?? ''}>
        <option value="">—</option>
        {series.map((one) => (
          <option key={one.id} value={one.id}>
            {one.name}
          </option>
        ))}
      </Select>
    </Field>
  )
}

/** The short form on Accept: only what the proposal leaves unsaid, each one optional. */
export function AcceptFields({
  proposal,
  missing,
  choices,
}: {
  proposal: ProposalView
  missing: MissingDetail[]
  choices: ProposalChoices
}) {
  const parties: PartyOption[] = [
    ...choices.people.map((person): PartyOption => ({ value: `person:${person.id}`, name: person.name, icon: 'person' })),
    ...choices.groups.map((group): PartyOption => ({ value: `group:${group.id}`, name: group.name, icon: 'group' })),
  ]
  return (
    <>
      <input type="hidden" name="id" value={proposal.id} />
      {missing.map((one) => (
        <input key={one} type="hidden" name="asked" value={one} />
      ))}
      {missing.includes('owner') && proposal.payload.type === 'item' ? (
        <PartyPicker
          label={roleLabel(proposal.payload.kind, 'owner')}
          name="owners"
          options={parties}
          allowNew
        />
      ) : null}
      {missing.includes('project') || missing.includes('due') ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {missing.includes('project') ? <ProjectField projects={choices.projects} value={null} /> : null}
          {missing.includes('due') ? (
            <Field label="Due">
              <Input name="dueOn" type="date" />
            </Field>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

/** The fields of a proposal's edit form: whatever its payload holds that John could correct. */
export function ProposalFields({
  proposal,
  choices,
}: {
  proposal: ProposalView
  choices: ProposalChoices
}) {
  const { payload } = proposal
  const people: PartyOption[] = choices.people.map((person) => ({
    value: `person:${person.id}`,
    name: person.name,
    icon: 'person',
  }))
  const parties: PartyOption[] = [
    ...people,
    ...choices.groups.map(
      (group): PartyOption => ({ value: `group:${group.id}`, name: group.name, icon: 'group' }),
    ),
  ]

  if (payload.type === 'item') {
    const of = (role: 'owner' | 'with') => proposal.parties.filter((party) => party.role === role).map(picked)
    return (
      <ItemFields
        kind={payload.kind}
        text={
          <Field label="Text" required>
            <Input name="text" defaultValue={payload.text} required />
          </Field>
        }
        options={parties}
        selected={{ owner: of('owner'), with: of('with') }}
        project={<ProjectField projects={choices.projects} value={payload.projectId} />}
        due={{ value: payload.dueOn ?? null }}
        raiseAt={(choices.series ?? []).length > 0 ? <SeriesField series={choices.series ?? []} value={payload.seriesId} /> : undefined}
        detail={
          <Field label="Detail">
            {/* A decision has no resolution of its own: what was said about it is its detail. */}
            <Textarea
              name="detail"
              rows={3}
              defaultValue={payload.detail ?? (payload.kind === 'decision' ? (payload.resolution ?? '') : '')}
            />
          </Field>
        }
        resolution={{ value: payload.resolution ?? null }}
      />
    )
  }

  if (payload.type === 'update') {
    return (
      <>
        <Field label="Change">
          <Select name="change" defaultValue={payload.change}>
            {(Object.keys(CHANGES) as (keyof typeof CHANGES)[]).map((change) => (
              <option key={change} value={change}>
                {CHANGES[change]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Text">
          <Textarea name="text" rows={3} defaultValue={payload.text ?? ''} />
        </Field>
      </>
    )
  }

  if (payload.type === 'document') {
    return (
      <>
        <Field label="Title" required>
          <Input name="title" defaultValue={payload.title} required />
        </Field>
        <ProjectField projects={choices.projects} value={payload.projectId} />
        <Field label="Content" required>
          <Textarea name="body" rows={12} defaultValue={payload.body} required />
        </Field>
      </>
    )
  }

  return (
    <>
      <Field label="Title" required>
        <Input name="title" defaultValue={payload.title} required />
      </Field>
      <PartyPicker label="People" name="people" options={people} selected={proposal.parties.map(picked)} allowNew />
    </>
  )
}
