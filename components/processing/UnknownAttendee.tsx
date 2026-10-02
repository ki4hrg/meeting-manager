'use client'

import { useState } from 'react'
import { nameAttendeeAction } from '@/app/(app)/meetings/processing-actions'
import { ActionForm } from '@/components/forms'
import { PartyOptions } from '@/components/items/PartyOptions'
import { Button } from '@/components/ui/Button'
import { Field, Input, Select } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import { Modal } from '@/components/ui/Modal'
import { Badge } from '@/components/ui/StatusBadge'

type Option = { id: string; name: string }

/* "sarah.jones@…" reads as "Sarah Jones" until John says otherwise. */
const guess = (email: string) =>
  email
    .split('@')[0]!
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(' ')

/**
 * Someone the note names by an address the directory does not have: an amber
 * pill that opens "who is this?". The answer is someone already known, a new
 * person, or nobody worth keeping.
 */
export function UnknownAttendee({
  meetingId,
  email,
  name,
  people,
}: {
  meetingId: string
  email: string
  name: string | null
  people: Option[]
}) {
  const [opened, setOpened] = useState(0)
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)
  const shown = name ?? email

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpened((count) => count + 1)
          setOpen(true)
        }}
        aria-label={`Who is ${shown}?`}
        title={email}
        className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        <Badge tone="amber">
          <Icon name="alert" className="h-3 w-3" />
          {shown}
        </Badge>
      </button>

      <Modal open={open} onClose={close} title={email}>
        <ActionForm key={opened} action={nameAttendeeAction} onDone={close}>
          <input type="hidden" name="meetingId" value={meetingId} />
          <input type="hidden" name="email" value={email} />
          <Field label="Name">
            <Input name="name" defaultValue={name ?? guess(email)} />
          </Field>
          <Field label="Person">
            <Select name="party" defaultValue="">
              <PartyOptions people={people} groups={[]} />
            </Select>
          </Field>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="submit" name="skip" value="1" variant="secondary">
              <Icon name="close" className="h-4 w-4" />
              Skip
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
