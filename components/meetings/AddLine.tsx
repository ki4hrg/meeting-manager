'use client'

import { useState, useTransition } from 'react'
import { addLineAction } from '@/app/(app)/meetings/actions'
import { useToast } from '@/components/Toast'
import { Icon } from '@/components/ui/icons'
import { Spinner } from '@/components/ui/Spinner'

/**
 * Type a line, press Enter, type the next. The field is cleared at once and
 * never disabled, so the caret stays put while the line is saved; a refusal
 * puts the text back.
 */
export function AddLine({ meetingId, sectionId }: { meetingId: string; sectionId?: string }) {
  const toast = useToast()
  const [text, setText] = useState('')
  const [pending, startTransition] = useTransition()

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const value = text.trim()
    if (value === '') return
    setText('')

    const data = new FormData()
    data.set('meetingId', meetingId)
    data.set('text', value)
    if (sectionId) data.set('sectionId', sectionId)
    startTransition(async () => {
      const result = await addLineAction(data)
      if (result?.error) {
        toast.error(result.error)
        setText((current) => current || value)
      }
    })
  }

  return (
    <form onSubmit={submit} className="flex items-center gap-2">
      {/* The spinner says the last line is still being saved; typing goes on regardless. */}
      {pending ? (
        <Spinner className="!h-4 !w-4 shrink-0" />
      ) : (
        <Icon name="plus" className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" />
      )}
      <input
        value={text}
        onChange={(event) => setText(event.target.value)}
        aria-label="Add line"
        placeholder="Line"
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
        data-bwignore
        data-form-type="other"
        enterKeyHint="enter"
        className="block w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-sm text-gray-900 placeholder:text-gray-400 hover:border-gray-200 focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 dark:text-gray-100 dark:placeholder:text-gray-500 dark:hover:border-gray-600 dark:focus:bg-gray-700"
      />
    </form>
  )
}
