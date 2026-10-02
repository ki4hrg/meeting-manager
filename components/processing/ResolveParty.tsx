'use client'

import { useState } from 'react'
import { resolvePartyAction } from '@/app/(app)/meetings/processing-actions'
import { ActionForm } from '@/components/forms'
import { PartyOptions } from '@/components/items/PartyOptions'
import { Button } from '@/components/ui/Button'
import { Field, Select } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import { Modal } from '@/components/ui/Modal'
import { Badge } from '@/components/ui/StatusBadge'

type Option = { id: string; name: string }

/**
 * A name the note gave that matched nobody: an amber pill that opens the
 * question "who is this?". The answer is someone in the directory, a group,
 * or a new person by that name.
 */
export function ResolveParty({
  proposalId,
  name,
  people,
  groups,
}: {
  proposalId: string
  name: string
  people: Option[]
  /** Empty where only a person will do: who a meeting is with. */
  groups: Option[]
}) {
  const [opened, setOpened] = useState(0)
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)

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
          <Field label={groups.length > 0 ? 'Person or group' : 'Person'}>
            <Select name="party" defaultValue="">
              <PartyOptions people={people} groups={groups} />
            </Select>
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" name="create" value="1" variant="accent">
              <Icon name="plus" className="h-4 w-4" />
              New person
            </Button>
            <Button type="submit">Save</Button>
          </div>
        </ActionForm>
      </Modal>
    </>
  )
}
