'use client'

import { useRef, useState } from 'react'
import { useToast } from '@/components/Toast'
import { Button, type ButtonProps } from '@/components/ui/Button'
import { Icon } from '@/components/ui/icons'
import { Modal } from '@/components/ui/Modal'

/**
 * Copies text to the clipboard, as plain text and, when `html` is given, as
 * rich text too, so a paste into a notepad keeps its headings and nesting.
 *
 * `navigator.clipboard` does not exist on a plain-http origin. There the text
 * is shown selected instead, so a manual copy is one keystroke.
 */
export function CopyButton({
  text,
  html,
  label,
  variant = 'secondary',
  size = 'md',
}: {
  text: string
  html?: string
  label: string
  variant?: ButtonProps['variant']
  size?: ButtonProps['size']
}) {
  const toast = useToast()
  const [manual, setManual] = useState(false)
  const fallbackRef = useRef<HTMLTextAreaElement>(null)

  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard')
      if (html && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/plain': new Blob([text], { type: 'text/plain' }),
            'text/html': new Blob([html], { type: 'text/html' }),
          }),
        ])
      } else {
        await navigator.clipboard.writeText(text)
      }
      toast.success('Copied')
    } catch {
      setManual(true)
      requestAnimationFrame(() => fallbackRef.current?.select())
    }
  }

  return (
    <>
      <Button variant={variant} size={size} onClick={copy}>
        <Icon name="copy" className="h-4 w-4" />
        {label}
      </Button>

      {/* Mounted only when needed: the text is private and should not sit in the page. */}
      {manual ? (
        <Modal open onClose={() => setManual(false)} title={label} size="lg">
          <textarea
            ref={fallbackRef}
            readOnly
            value={text}
            rows={16}
            aria-label={label}
            className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-xs text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
          />
        </Modal>
      ) : null}
    </>
  )
}
