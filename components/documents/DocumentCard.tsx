'use client'

import { useState } from 'react'
import { CopyButton } from '@/components/CopyButton'
import { Icon } from '@/components/ui/icons'
import { Modal } from '@/components/ui/Modal'

/**
 * A working document as a card: its title and how it starts. The whole card
 * opens it to be read, with one button to copy it out.
 */
export function DocumentCard({
  title,
  body,
  meta,
}: {
  title: string
  body: string
  /** When it last changed, as the list it sits in words it. */
  meta?: string
}) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block w-full rounded-lg bg-white p-4 text-left shadow transition-shadow hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 dark:bg-gray-800"
      >
        <span className="flex items-start gap-3">
          <Icon name="document" className="h-5 w-5 shrink-0 text-gray-400 dark:text-gray-500" />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline justify-between gap-2">
              <span className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
                {title}
              </span>
              {meta ? (
                <span className="shrink-0 text-xs tabular-nums text-gray-500 dark:text-gray-400">
                  {meta}
                </span>
              ) : null}
            </span>
            <span className="mt-1 line-clamp-2 whitespace-pre-line text-sm text-gray-600 dark:text-gray-300">
              {body}
            </span>
          </span>
        </span>
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title={title} size="lg">
        <div className="flex flex-col gap-4">
          <div className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap break-words text-sm text-gray-700 dark:text-gray-300">
            {body}
          </div>
          <div className="flex justify-end">
            <CopyButton label="Copy" text={body} />
          </div>
        </div>
      </Modal>
    </>
  )
}
