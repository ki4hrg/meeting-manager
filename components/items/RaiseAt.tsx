'use client'

import { useState } from 'react'
import { ActionSelect } from '@/components/ActionSelect'
import { Icon } from '@/components/ui/icons'
import { RemovableChip } from '@/components/ui/RemovableChip'
import type { ActionResult } from '@/lib/web/action'

/**
 * Where an open item is to be raised: once set, the meeting (with its day),
 * series or project as a chip, with a pencil to choose again and a cross to
 * stop; unset, the picker. `children` are the picker's options, by `value`
 * (`meeting:<id>`, `series:<id>`, `project:<id>`).
 */
export function RaiseAt({
  itemId,
  action,
  value,
  target,
  children,
}: {
  itemId: string
  action: (formData: FormData) => Promise<ActionResult>
  value: string
  target: { name: string; href: string } | null
  children: React.ReactNode
}) {
  const [choosing, setChoosing] = useState(false)

  if (target && !choosing) {
    return (
      <RemovableChip
        icon="meeting"
        iconLabel="Raise at"
        href={target.href}
        edit={{ label: 'Raise elsewhere', onClick: () => setChoosing(true) }}
        remove={{ action, fields: { id: itemId, target: '' }, label: `Stop raising at ${target.name}` }}
      >
        {target.name}
      </RemovableChip>
    )
  }

  return (
    <span className="flex min-w-0 max-w-full items-center gap-1.5">
      {/* Decorative: the select carries the name. */}
      <Icon name="meeting" className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" />
      <ActionSelect
        key={value}
        action={action}
        fields={{ id: itemId }}
        name="target"
        value={value}
        label="Raise at"
        // min-w-0: a select is as wide as its longest option unless told it may be narrower.
        className="!w-auto min-w-0 max-w-full !py-1 !text-sm"
      >
        {children}
      </ActionSelect>
    </span>
  )
}
