'use client'

import { useState } from 'react'
import { FormModal } from '@/components/forms'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/icons'
import { Modal } from '@/components/ui/Modal'
import type { ActionResult } from '@/lib/web/action'

/**
 * Delete, for an archived row. It says what goes with it; while something
 * still depends on it, it names that instead and offers nothing to press.
 */
export function DeleteButton({
  action,
  fields,
  blockers,
  takes,
}: {
  action: (formData: FormData) => Promise<ActionResult>
  fields: Record<string, string>
  blockers: string[]
  takes: string[]
}) {
  const [open, setOpen] = useState(false)

  if (blockers.length > 0) {
    return (
      <>
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          <Icon name="trash" className="h-4 w-4" />
          Delete
        </Button>
        <Modal open={open} onClose={() => setOpen(false)} title="Not yet">
          <ul className="flex flex-col gap-2 text-sm text-gray-700 dark:text-gray-300">
            {blockers.map((blocker) => (
              <li key={blocker} className="flex items-start gap-2">
                <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0 text-amber-500 dark:text-amber-400" />
                {blocker}
              </li>
            ))}
          </ul>
          <div className="mt-4 flex justify-end">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
        </Modal>
      </>
    )
  }

  return (
    <FormModal action={action} title="Delete" label="Delete" icon="trash" variant="ghost" size="sm" submit="Delete" danger>
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {takes.length > 0 ? (
        <ul className="flex flex-col gap-2 text-sm text-gray-700 dark:text-gray-300">
          {takes.map((take) => (
            <li key={take} className="flex items-start gap-2">
              <Icon name="trash" className="mt-0.5 h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" />
              {take}
            </li>
          ))}
        </ul>
      ) : null}
    </FormModal>
  )
}
