'use client'

import { useState } from 'react'
import { resolvePartyAction } from '@/app/(app)/meetings/processing-actions'
import { ActionForm } from '@/components/forms'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/icons'
import { Modal } from '@/components/ui/Modal'
import { Badge } from '@/components/ui/StatusBadge'
import { PartyPicker, type PartyOption } from './PartyPicker'

type Option = { id: string; name: string }

/**
 * A name the note gave that matched nobody: an amber pill that opens the
 * question "who is this?". The answer is picked the way any party is: someone
 * in the directory, a group, or a new person (or group) by that name,
 * completed first.
 */
export function ResolveParty({
  proposalId,
  name,
  people,
  groups,
  takesGroups = groups.length > 0,
}: {
  proposalId: string
  name: string
  people: Option[]
  /** Empty where only a person will do: who a meeting is with. */
  groups: Option[]
  /** Whether the answer may be a group, so a new one is offered too. */
  takesGroups?: boolean
}) {
  const [opened, setOpened] = useState(0)
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)
  const options: PartyOption[] = [
    ...people.map((person): PartyOption => ({ value: `person:${person.id}`, name: person.name, icon: 'person' })),
    ...groups.map((group): PartyOption => ({ value: `group:${group.id}`, name: group.name, icon: 'group' })),
  ]

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpened((count) => count + 1)
          setOpen(true)
        }}
        aria-label={`Who is ${name}?`}
        title={`Who is ${name}?`}
        className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        <Badge tone="amber">
          <Icon name="alert" className="h-3 w-3" />
          {name}
        </Badge>
      </button>

      <Modal open={open} onClose={close} title={name}>
        <ActionForm key={opened} action={resolvePartyAction} onDone={close}>
          <input type="hidden" name="id" value={proposalId} />
          <input type="hidden" name="name" value={name} />
          <PartyPicker
            label={takesGroups ? 'Person or group' : 'Person'}
            name="party"
            options={options}
            selected={[{ value: `name:${name}`, name, icon: 'alert' }]}
            allowNew
            allowNewGroup={takesGroups}
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button type="submit">Save</Button>
          </div>
        </ActionForm>
      </Modal>
    </>
  )
}
