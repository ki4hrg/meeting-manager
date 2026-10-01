'use client'

import { useState } from 'react'
import { useToast } from '@/components/Toast'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Field, Input } from '@/components/ui/Field'
import { Modal } from '@/components/ui/Modal'

export function Interactive() {
  const [open, setOpen] = useState(false)
  const toast = useToast()

  return (
    <Card>
      <div className="flex flex-wrap gap-3">
        <Button onClick={() => setOpen(true)}>Modal</Button>
        <Button variant="secondary" onClick={() => toast.success('Saved')}>
          Toast
        </Button>
        <Button variant="secondary" onClick={() => toast.error('Could not save')}>
          Error
        </Button>
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="New item">
        <div className="flex flex-col gap-4">
          <Field label="Title">
            <Input name="title" autoFocus />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => setOpen(false)}>Save</Button>
          </div>
        </div>
      </Modal>
    </Card>
  )
}
