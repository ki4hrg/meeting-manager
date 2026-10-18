'use client'

import { useState } from 'react'
import { Input } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import { matchName } from '@/lib/core/match'

export type TaskOption = { id: string; content: string; deadline: string | null }

/* The best guesses before anything is typed. */
const SUGGESTED = 5

/**
 * Pick one of John's Todoist tasks: the likeliest first, or type to search
 * them all. A pasted task link is submitted as it is.
 */
export function TaskPicker({ name, options }: { name: string; options: TaskOption[] }) {
  const [text, setText] = useState('')
  const [chosen, setChosen] = useState<string | null>(options[0]?.id ?? null)

  const shown = text.trim()
    ? matchName(
        options.map((option) => ({ ...option, name: option.content })),
        text,
      ).slice(0, 8)
    : options.slice(0, SUGGESTED)
  const pasted = /todoist\.com\/|^[A-Za-z0-9]{6,}$/.test(text.trim()) && shown.length === 0
  const value = pasted ? text.trim() : shown.some((option) => option.id === chosen) ? chosen : null

  return (
    <div className="flex flex-col gap-2">
      <input type="hidden" name={name} value={value ?? ''} />
      <Input
        aria-label="Search tasks"
        placeholder="Search"
        value={text}
        onChange={(event) => setText(event.target.value)}
        autoFocus
      />
      <ul className="flex flex-col gap-1">
        {shown.map((option) => (
          <li key={option.id}>
            <label className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm text-gray-900 hover:bg-gray-50 dark:text-gray-100 dark:hover:bg-gray-700/50">
              <input
                type="radio"
                className="mt-0.5"
                checked={value === option.id}
                onChange={() => setChosen(option.id)}
              />
              <span className="min-w-0 flex-1 break-words">{option.content}</span>
              {option.deadline ? (
                <span className="inline-flex shrink-0 items-center gap-1 text-xs tabular-nums text-gray-500 dark:text-gray-400">
                  <Icon name="flag" className="h-3 w-3" />
                  {option.deadline}
                </span>
              ) : null}
            </label>
          </li>
        ))}
      </ul>
    </div>
  )
}
