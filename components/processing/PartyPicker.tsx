'use client'

import { useId, useRef, useState } from 'react'
import { Icon } from '@/components/ui/icons'
import { matchName } from '@/lib/core/match'

export type PartyOption = {
  /** What is submitted: an id, or `person:<id>` / `group:<id>` / `name:<text>`. */
  value: string
  name: string
  /** `alert` is a name nobody has been matched to yet. */
  icon: 'person' | 'group' | 'alert'
}

/**
 * Pick people (or people and groups) by typing: a few letters suggest who is
 * meant, Enter or a click takes the suggestion, and each one chosen becomes a
 * chip. Every chip is submitted under `name`; whatever is still in the box
 * goes as `<name>Text`, for the server to resolve the way it resolves a name
 * anywhere else, so typing "sarah, tom" and submitting works too.
 */
export function PartyPicker({
  label,
  name,
  options,
  selected = [],
  required = false,
}: {
  label: string
  name: string
  options: PartyOption[]
  selected?: PartyOption[]
  required?: boolean
}) {
  const id = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [chosen, setChosen] = useState(selected)
  const [text, setText] = useState('')
  const [highlighted, setHighlighted] = useState(0)

  // Only the last name being typed is completed; the ones before a comma stand.
  const comma = text.lastIndexOf(',')
  const partial = text.slice(comma + 1).trim()
  const taken = new Set(chosen.map((option) => option.value))
  const suggestions =
    partial === ''
      ? []
      : matchName(
          options.filter((option) => !taken.has(option.value)),
          partial,
        ).slice(0, 6)

  function pick(option: PartyOption) {
    setChosen((current) => [...current, option])
    setText(text.slice(0, comma + 1))
    setHighlighted(0)
    inputRef.current?.focus()
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Backspace' && text === '' && chosen.length > 0) {
      setChosen((current) => current.slice(0, -1))
      return
    }
    if (suggestions.length === 0) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setHighlighted((index) => (index + step + suggestions.length) % suggestions.length)
    } else if (event.key === 'Enter' || event.key === 'Tab' || event.key === ',') {
      event.preventDefault()
      pick(suggestions[highlighted] ?? suggestions[0]!)
    }
  }

  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-sm font-medium text-gray-700 dark:text-gray-300">
        {label}
        {required ? <span className="ml-0.5 text-red-600 dark:text-red-400">*</span> : null}
      </label>
      <div
        className="mt-1 flex flex-wrap items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2 py-1.5 shadow-sm focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
        onClick={() => inputRef.current?.focus()}
      >
        {chosen.map((option) => (
          <span
            key={option.value}
            className="inline-flex max-w-full items-center gap-1 rounded-full bg-gray-100 py-0.5 pl-2 pr-1 text-xs font-medium text-gray-700 dark:bg-gray-600 dark:text-gray-200"
          >
            <input type="hidden" name={name} value={option.value} />
            <Icon
              name={option.icon}
              className="h-3.5 w-3.5 shrink-0"
              label={option.icon === 'alert' ? 'Not matched' : undefined}
            />
            <span className="truncate">{option.name}</span>
            <button
              type="button"
              aria-label={`Remove ${option.name}`}
              onClick={() => setChosen((current) => current.filter((one) => one.value !== option.value))}
              className="flex h-4 w-4 items-center justify-center rounded-full text-gray-400 hover:bg-gray-200 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 dark:hover:bg-gray-500 dark:hover:text-gray-100"
            >
              <Icon name="close" className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={id}
          name={`${name}Text`}
          value={text}
          onChange={(event) => {
            setText(event.target.value)
            setHighlighted(0)
          }}
          onKeyDown={onKeyDown}
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          data-form-type="other"
          className="min-w-[6rem] flex-1 border-0 bg-transparent p-0.5 text-gray-900 focus:outline-none focus:ring-0 sm:text-sm dark:text-gray-100"
        />
      </div>

      {suggestions.length > 0 ? (
        <ul role="listbox" aria-label={label} className="mt-2 flex flex-wrap gap-2">
          {suggestions.map((option, index) => (
            <li key={option.value}>
              <button
                type="button"
                role="option"
                aria-selected={index === highlighted}
                onClick={() => pick(option)}
                className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm ${
                  index === highlighted
                    ? 'border-blue-500 bg-blue-50 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200'
                    : 'border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700'
                }`}
              >
                <Icon name={option.icon} className="h-3.5 w-3.5" />
                {option.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
