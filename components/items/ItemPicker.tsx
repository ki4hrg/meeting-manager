'use client'

import { useId, useRef, useState } from 'react'
import { SearchInput } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import { KindIcon, type ItemKind } from '@/components/ui/StatusBadge'
import { matchName } from '@/lib/core/match'

export type ItemOption = { id: string; text: string; kind: ItemKind }

/**
 * Pick one item by typing a few words of it: Enter or a click takes the
 * suggestion, which becomes a chip submitted under `name`.
 */
export function ItemPicker({
  label,
  name,
  options,
  selected = null,
}: {
  label: string
  name: string
  options: ItemOption[]
  selected?: ItemOption | null
}) {
  const id = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [chosen, setChosen] = useState(selected)
  const [text, setText] = useState('')
  const [highlighted, setHighlighted] = useState(0)

  const matches = matchName(
    options.map((option) => ({ ...option, name: option.text })),
    text,
  ).slice(0, 6)

  function pick(option: ItemOption) {
    setChosen(option)
    setText('')
    setHighlighted(0)
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape' && text !== '') {
      event.preventDefault()
      setText('')
      return
    }
    if (matches.length === 0) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setHighlighted((index) => (index + step + matches.length) % matches.length)
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      pick(matches[highlighted] ?? matches[0]!)
    }
  }

  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-sm font-medium text-gray-700 dark:text-gray-300">
        {label}
      </label>
      {chosen ? (
        <div className="mt-1 flex">
          <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-gray-100 py-0.5 pl-2 pr-1 text-sm text-gray-700 dark:bg-gray-600 dark:text-gray-200">
            <input type="hidden" name={name} value={chosen.id} />
            <KindIcon kind={chosen.kind} className="h-3.5 w-3.5" />
            <span className="min-w-0 truncate">{chosen.text}</span>
            <button
              type="button"
              id={id}
              aria-label={`Remove ${chosen.text}`}
              onClick={() => {
                setChosen(null)
                requestAnimationFrame(() => inputRef.current?.focus())
              }}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-gray-400 hover:bg-gray-200 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 dark:hover:bg-gray-500 dark:hover:text-gray-100"
            >
              <Icon name="close" className="h-3 w-3" />
            </button>
          </span>
        </div>
      ) : (
        <SearchInput
          ref={inputRef}
          id={id}
          value={text}
          onChange={(event) => {
            setText(event.target.value)
            setHighlighted(0)
          }}
          onKeyDown={onKeyDown}
        />
      )}

      {!chosen && matches.length > 0 ? (
        <ul role="listbox" aria-label={label} className="mt-2 flex flex-col gap-1">
          {matches.map((option, index) => (
            <li key={option.id}>
              <button
                type="button"
                role="option"
                aria-selected={index === highlighted}
                onClick={() => pick(option)}
                className={`flex w-full min-w-0 items-center gap-2 rounded-md border px-3 py-1.5 text-left text-sm ${
                  index === highlighted
                    ? 'border-blue-500 bg-blue-50 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200'
                    : 'border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700'
                }`}
              >
                <KindIcon kind={option.kind} className="h-4 w-4" />
                <span className="min-w-0 truncate">{option.text}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
