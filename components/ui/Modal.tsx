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
  footer,
  size = 'md',
}: {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  /** Kept in view under the body, however long it runs: the button that does the thing. */
  footer?: React.ReactNode
  size?: 'md' | 'lg'
}) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
      // showModal() focuses the first focusable element, which is the close
      // button. A modal with a form should start in its first field.
      dialog.querySelector<HTMLElement>('input:not([type=hidden]), textarea, select')?.focus()
    }
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
      className={`m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] flex-col rounded-lg open:flex bg-white p-0 text-gray-900 shadow-xl backdrop:bg-black/40 dark:bg-gray-800 dark:text-gray-100 ${
        size === 'lg' ? 'max-w-2xl' : 'max-w-md'
      }`}
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-gray-200 px-6 py-4 dark:border-gray-700">
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
      <div className="min-h-0 flex-1 overflow-y-auto p-6">{children}</div>
      {footer ? (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-gray-200 px-6 py-4 dark:border-gray-700">
          {footer}
        </div>
      ) : null}
    </dialog>
  )
}
