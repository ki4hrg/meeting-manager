import { Field, Input, Select, Textarea } from '@/components/ui/Field'
import { KIND, type ItemKind } from '@/components/ui/StatusBadge'
import type { MissingDetail } from '@/lib/processing/missing'
import type { ProposalParty, ProposalView } from '@/lib/processing/proposals'
import { PartyPicker, type PartyOption } from './PartyPicker'

type Option = { id: string; name: string }

export type ProposalChoices = {
  people: Option[]
  groups: Option[]
  projects: Option[]
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
      {missing.includes('owner') ? <PartyPicker label="Owner" name="owners" options={parties} /> : null}
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
    return (
      <>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_9rem]">
          <Field label="Text" required>
            <Input name="text" defaultValue={payload.text} required />
          </Field>
          <Field label="Kind">
            <Select name="kind" defaultValue={payload.kind}>
              {(Object.keys(KIND) as ItemKind[]).map((kind) => (
                <option key={kind} value={kind}>
                  {KIND[kind].label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <PartyPicker
          label="Owner"
          name="owners"
          options={parties}
          selected={proposal.parties.filter((party) => party.role === 'owner').map(picked)}
        />
        <PartyPicker
          label="With"
          name="withs"
          options={parties}
          selected={proposal.parties.filter((party) => party.role === 'with').map(picked)}
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ProjectField projects={choices.projects} value={payload.projectId} />
          <Field label="Due">
            <Input name="dueOn" type="date" defaultValue={payload.dueOn ?? ''} />
          </Field>
        </div>
        <Field label="Detail">
          <Textarea name="detail" rows={3} defaultValue={payload.detail ?? ''} />
        </Field>
        <Field label="Resolution">
          <Textarea name="resolution" rows={2} defaultValue={payload.resolution ?? ''} />
        </Field>
      </>
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
      <PartyPicker label="People" name="people" options={people} selected={proposal.parties.map(picked)} />
    </>
  )
}
