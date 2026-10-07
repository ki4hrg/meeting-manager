'use client'

import { useState } from 'react'
import { Field, Input, Select, Textarea } from '@/components/ui/Field'
import { KIND, type ItemKind } from '@/components/ui/StatusBadge'
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
}) {
  const [kind, setKind] = useState(initial)
  const [chosen, setChosen] = useState<Record<PartyRole, PartyOption[]>>({
    owner: selected?.owner ?? [],
    with: selected?.with ?? [],
  })
  const shows = kindFields(kind)
  const other = (role: PartyRole): PartyRole => (role === 'owner' ? 'with' : 'owner')

  const kindField = kindSelect ? (
    <Field label="Kind">
      <Select name="kind" value={kind} onChange={(event) => setKind(event.target.value as ItemKind)}>
        {(Object.keys(KIND) as ItemKind[]).map((one) => (
          <option key={one} value={one}>
            {KIND[one].label}
          </option>
        ))}
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
      {/* Keyed by role, so a picker keeps its picks when the kind reorders them. */}
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
          />
        ))}
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
    </>
  )
}
