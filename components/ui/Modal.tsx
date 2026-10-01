'use client'

import { useEffect, useRef } from 'react'
import { Icon } from './icons'

/*
 * A modal on the native <dialog>. showModal() gives the focus trap, Escape to
 * close, and an inert page behind it without any of that being written here.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  size = 'md',
}: {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  size?: 'md' | 'lg'
}) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself.
      onClick={(event) => {
        if (event.target === ref.current) onClose()
      }}
      aria-label={title}
      className={`m-auto w-[calc(100%-2rem)] rounded-lg bg-white p-0 text-gray-900 shadow-xl backdrop:bg-black/40 dark:bg-gray-800 dark:text-gray-100 ${
        size === 'lg' ? 'max-w-2xl' : 'max-w-md'
      }`}
    >
      <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-6 py-4 dark:border-gray-700">
        <h2 className="text-lg font-semibold">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="p-6">{children}</div>
    </dialog>
  )
}
