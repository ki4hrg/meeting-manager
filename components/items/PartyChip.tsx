'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, useTransition } from 'react'
import { ActionButton } from '@/components/forms'
import { useToast } from '@/components/Toast'
import { Icon, type IconName } from '@/components/ui/icons'
import type { ActionResult } from '@/lib/web/action'

type Action = (formData: FormData) => Promise<ActionResult>

/** Another role a party can take: what the menu says, and what the action is sent. */
export type ChipMove = { label: string; icon: IconName; fields: Record<string, string> }

/**
 * One party on an item: its marks, its name, and its cross. Tapping the chip
 * (anywhere but the name or the cross) opens a small menu of the other roles
 * it can take, each one tap away.
 */
export function PartyChip({
  name,
  href,
  icon,
  marks = [],
  label,
  moves = [],
  move,
  remove,
}: {
  name: string
  href: string
  icon: 'person' | 'group'
  /** Marks before the icon: the arrow, the two-way mark. */
  marks?: IconName[]
  /** Its role in words, as a tooltip. */
  label: string
  moves?: ChipMove[]
  move?: Action
  remove: { action: Action; fields: Record<string, string> }
}) {
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const ref = useRef<HTMLSpanElement>(null)
  const movable = moves.length > 0 && move !== undefined

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  function run(fields: Record<string, string>) {
    const data = new FormData()
    for (const [key, value] of Object.entries(fields)) data.set(key, value)
    startTransition(async () => {
      const result = await move!(data)
      if (result?.error) toast.error(result.error)
      setOpen(false)
    })
  }

  const stop = (event: React.MouseEvent) => event.stopPropagation()

  return (
    <span ref={ref} className="relative inline-flex max-w-full">
      <span
        title={label}
        onClick={movable ? () => setOpen((now) => !now) : undefined}
        className={`inline-flex max-w-full items-center gap-1 rounded-full border border-gray-200 py-0.5 pl-2 pr-0.5 text-sm text-gray-700 dark:border-gray-600 dark:text-gray-200 ${
          movable ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700' : ''
        }`}
      >
        {marks.map((mark) => (
          <Icon key={mark} name={mark} className="h-3.5 w-3.5 shrink-0 text-gray-400" />
        ))}
        <Icon name={icon} className="h-3.5 w-3.5 shrink-0 text-gray-400" />
        <Link href={href} onClick={stop} className="min-w-0 truncate hover:underline">
          {name}
        </Link>
        {movable ? (
          <button
            type="button"
            aria-label={`${label}: change`}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={(event) => {
              stop(event)
              setOpen((now) => !now)
            }}
            className="flex h-5 w-5 items-center justify-center rounded-full text-gray-400 hover:bg-gray-200 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-gray-600 dark:hover:text-gray-200"
          >
            <Icon name="chevronDown" className="h-3 w-3" />
          </button>
        ) : null}
        <span onClick={stop} className="flex">
          <ActionButton
            action={remove.action}
            fields={remove.fields}
            variant="ghost"
            size="sm"
            aria-label={`Remove ${name}`}
            title={`Remove ${name}`}
            className="!rounded-full !p-1 !text-gray-400"
          >
            <Icon name="close" className="h-3 w-3" />
          </ActionButton>
        </span>
      </span>

      {open ? (
        <span
          role="menu"
          aria-label={name}
          className="absolute left-0 top-full z-20 mt-1 flex min-w-[10rem] flex-col rounded-md border border-gray-200 bg-white p-1 shadow-lg dark:border-gray-600 dark:bg-gray-800"
        >
          {moves.map((one) => (
            <button
              key={one.label}
              type="button"
              role="menuitem"
              disabled={pending}
              onClick={() => run(one.fields)}
              className="flex items-center gap-2 whitespace-nowrap rounded px-2.5 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              <Icon name={one.icon} className="h-4 w-4 shrink-0 text-gray-400" />
              {one.label}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  )
}
