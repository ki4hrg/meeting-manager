'use client'

import { useState } from 'react'
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/Field'
import { KIND, PROJECT_STATUS, type ItemKind, type ProjectStatus } from '@/components/ui/StatusBadge'
import { roleLabel, roleOrder, type PartyRole } from '@/lib/items/roles'
import { PartyPicker, type PartyOption } from './PartyPicker'

/** Which of a proposed item's fields its kind takes: a decision has no deadline, target or resolution. */
export function kindFields(kind: ItemKind): { due: boolean; raiseAt: boolean; resolution: string | null } {
  const decision = kind === 'decision'
  return {
    due: !decision,
    raiseAt: !decision,
    resolution: decision ? null : kind === 'question' ? 'Answer' : 'Resolution',
  }
}

/* What a project made from a proposal can start as: proposed unless already agreed to. */
const PROJECT_STATUSES: ProjectStatus[] = ['proposed', 'pending', 'active']

/* Shown, or kept out of the form: a hidden field is disabled, so it is not submitted. */
function Shown({ when, children }: { when: boolean; children: React.ReactNode }) {
  return (
    <fieldset disabled={!when} className={when ? 'contents' : 'hidden'}>
      {children}
    </fieldset>
  )
}

/**
 * A proposed item's kind and the fields that follow it. Changing the kind
 * relabels and reorders the people pickers for the new kind and shows or
 * hides what that kind takes; who is picked stays in the role they are in.
 * The fields submit as `kind`, `owners`, `withs`, `dueOn` and `resolution`;
 * the rest come in as slots. Every part is optional, so a shorter form (Accept)
 * can take only the pickers it asks for.
 *
 * With `asProject`, the kind can also be Project: accepted as a project of its
 * own, the text its name, the project the one it sits within, the detail its
 * description. It submits `status` and `keepTopic`; the people pickers show,
 * labelled for a topic, only when a topic is kept on it.
 */
export function ItemFields({
  kind: initial,
  kindSelect = true,
  text,
  options,
  selected,
  roles = ['owner', 'with'],
  project,
  due,
  raiseAt,
  detail,
  resolution,
  ongoing,
  asProject = false,
}: {
  kind: ItemKind
  /** Off: the kind is fixed and submitted as it is. */
  kindSelect?: boolean
  /** The text field, beside the kind. */
  text?: React.ReactNode
  options: PartyOption[]
  selected?: Partial<Record<PartyRole, PartyOption[]>>
  /** The pickers to show. */
  roles?: PartyRole[]
  project?: React.ReactNode
  /** The deadline's value; leave out for no deadline field. */
  due?: { value: string | null }
  raiseAt?: React.ReactNode
  detail?: React.ReactNode
  resolution?: { value: string | null }
  /** Whether a question is ongoing; leave out for no such box. */
  ongoing?: { value: boolean }
  /** Offer Project as a kind: a proposal accepted as a project of its own. */
  asProject?: boolean
}) {
  const [chosenKind, setKind] = useState<ItemKind | 'project'>(initial)
  const [keepTopic, setKeepTopic] = useState(false)
  const isProject = chosenKind === 'project'
  // A project's people are the kept topic's.
  const kind: ItemKind = isProject ? 'topic' : chosenKind
  const [chosen, setChosen] = useState<Record<PartyRole, PartyOption[]>>({
    owner: selected?.owner ?? [],
    with: selected?.with ?? [],
  })
  const shows = isProject ? { due: false, raiseAt: false, resolution: null } : kindFields(kind)
  const other = (role: PartyRole): PartyRole => (role === 'owner' ? 'with' : 'owner')

  const kindField = kindSelect ? (
    <Field label="Kind">
      <Select name="kind" value={chosenKind} onChange={(event) => setKind(event.target.value as ItemKind | 'project')}>
        {(Object.keys(KIND) as ItemKind[]).map((one) => (
          <option key={one} value={one}>
            {KIND[one].label}
          </option>
        ))}
        {asProject ? <option value="project">Project</option> : null}
      </Select>
    </Field>
  ) : (
    <input type="hidden" name="kind" value={kind} />
  )

  return (
    <>
      {text && kindSelect ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_9rem]">
          {text}
          {kindField}
        </div>
      ) : (
        <>
          {text}
          {kindField}
        </>
      )}
      {asProject ? (
        <Shown when={isProject}>
          <Field label="Status">
            <Select name="status" defaultValue="proposed">
              {PROJECT_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {PROJECT_STATUS[status].label}
                </option>
              ))}
            </Select>
          </Field>
          <Checkbox
            name="keepTopic"
            label="Keep a topic for it"
            checked={keepTopic}
            onChange={(event) => setKeepTopic(event.target.checked)}
          />
        </Shown>
      ) : null}
      {/* Keyed by role, so a picker keeps its picks when the kind reorders them. */}
      <Shown when={!isProject || keepTopic}>
      {roleOrder(kind)
        .filter((role) => roles.includes(role))
        .map((role) => (
          <PartyPicker
            key={role}
            label={roleLabel(kind, role)}
            name={role === 'owner' ? 'owners' : 'withs'}
            options={options}
            chosen={chosen[role]}
            onChosen={(next) => setChosen((now) => ({ ...now, [role]: next }))}
            move={
              roles.includes(other(role))
                ? {
                    label: roleLabel(kind, other(role)),
                    icon: 'refresh',
                    to: (option) =>
                      setChosen((now) => ({
                        [role]: now[role].filter((one) => one.value !== option.value),
                        [other(role)]: [...now[other(role)].filter((one) => one.value !== option.value), option],
                      }) as Record<PartyRole, PartyOption[]>),
                  }
                : undefined
            }
            allowNew
            allowNewGroup
          />
        ))}
      </Shown>
      {project || due || raiseAt ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {project}
          {due ? (
            <Shown when={shows.due}>
              <Field label="Due">
                <Input name="dueOn" type="date" defaultValue={due.value ?? ''} />
              </Field>
            </Shown>
          ) : null}
          {raiseAt ? <Shown when={shows.raiseAt}>{raiseAt}</Shown> : null}
        </div>
      ) : null}
      {detail}
      {resolution ? (
        <Shown when={shows.resolution !== null}>
          <Field label={shows.resolution ?? 'Resolution'}>
            <Textarea name="resolution" rows={2} defaultValue={resolution.value ?? ''} />
          </Field>
        </Shown>
      ) : null}
      {ongoing ? (
        <Shown when={chosenKind === 'question'}>
          <Checkbox name="ongoing" label="Ongoing" defaultChecked={ongoing.value} />
        </Shown>
      ) : null}
    </>
  )
}
