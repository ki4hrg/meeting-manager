'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { captureAction } from '@/app/(app)/actions'
import { useDirectory } from '@/components/Directory'
import { useToast } from '@/components/Toast'
import { Button } from '@/components/ui/Button'
import { FormError } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import { Modal } from '@/components/ui/Modal'
import { KIND, KindIcon, type ItemKind } from '@/components/ui/StatusBadge'
import { matchName, normalise, tokenFor } from '@/lib/core/match'
import type { CapturePresets } from '@/lib/items/capture'

const PREFIX: Record<ItemKind, string> = { topic: 'T', question: 'Q', action: 'A', decision: 'D' }
const KINDS = Object.keys(PREFIX) as ItemKind[]
const KIND_OF_PREFIX = /^([tqad]):\s*/i

/* The @ or # token the caret is at the end of, if any. */
const ACTIVE_TOKEN = /(?:^|\s)([@#])([\p{L}\p{N}_-]*)$/u

type Suggestion = { name: string; icon: 'person' | 'group' | 'project' }

function kindOf(line: string, fallback: ItemKind): ItemKind {
  const prefix = KIND_OF_PREFIX.exec(line.trimStart())
  if (!prefix) return fallback
  return KINDS.find((kind) => PREFIX[kind].toLowerCase() === prefix[1]!.toLowerCase())!
}

/**
 * Quick-add: one line, `@person` or `@group`, `#project`, and an optional
 * kind prefix. In the top bar it captures into the selected context; on a hub
 * page it carries that page's person, group or project as presets.
 */
export function QuickAdd({
  presets,
  variant = 'button',
  label = 'Add',
}: {
  presets?: CapturePresets
  /** `bar` is the icon in the top bar, which also answers to the N key. */
  variant?: 'bar' | 'button'
  label?: string
}) {
  const directory = useDirectory()
  const toast = useToast()
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [line, setLine] = useState('')
  const [caret, setCaret] = useState(0)
  const [highlighted, setHighlighted] = useState(0)
  const [error, setError] = useState<string>()
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    if (variant !== 'bar') return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'n' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable], dialog[open]')) return
      event.preventDefault()
      setOpen(true)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [variant])

  const kind = kindOf(line, presets?.kind ?? 'topic')

  const active = ACTIVE_TOKEN.exec(line.slice(0, caret))
  const partial = active?.[2] ?? ''
  let suggestions: Suggestion[] = []
  if (active) {
    const pool: Suggestion[] =
      active[1] === '@'
        ? [
            ...directory.people.map((p) => ({ name: p.name, icon: 'person' as const })),
            ...directory.groups.map((g) => ({ name: g.name, icon: 'group' as const })),
          ]
        : directory.projects.map((p) => ({ name: p.name, icon: 'project' as const }))
    suggestions = (partial === '' ? pool : matchName(pool, partial)).slice(0, 6)
    // Already typed out in full: nothing left to suggest, so Enter submits.
    if (suggestions.length === 1 && normalise(suggestions[0]!.name) === normalise(partial)) {
      suggestions = []
    }
  }

  function edit(next: string, nextCaret: number) {
    setLine(next)
    setCaret(nextCaret)
    setHighlighted(0)
    setError(undefined)
  }

  function pick(suggestion: Suggestion) {
    if (!active) return
    const start = caret - partial.length
    const token = `${tokenFor(suggestion.name)} `
    edit(line.slice(0, start) + token + line.slice(caret), start + token.length)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(start + token.length, start + token.length)
    })
  }

  function setKind(next: ItemKind) {
    const body = line.trimStart().replace(KIND_OF_PREFIX, '')
    const value = `${PREFIX[next]}: ${body}`
    edit(value, value.length)
    inputRef.current?.focus()
  }

  function submit() {
    if (line.trim() === '') return
    const data = new FormData()
    data.set('line', line)
    data.set('presets', JSON.stringify(presets ?? {}))

    startTransition(async () => {
      const result = await captureAction(data)
      if (result?.error) {
        setError(result.error)
        return
      }
      // Stays open: capture often comes in batches.
      toast.success('Added')
      edit('', 0)
      inputRef.current?.focus()
    })
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (suggestions.length === 0) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setHighlighted((index) => (index + step + suggestions.length) % suggestions.length)
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      pick(suggestions[highlighted] ?? suggestions[0]!)
    }
  }

  return (
    <>
      {variant === 'bar' ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Add"
          className="flex h-9 w-9 items-center justify-center rounded-md bg-blue-600 text-white hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800"
        >
          <Icon name="plus" />
        </button>
      ) : (
        <Button size="sm" onClick={() => setOpen(true)}>
          {label}
        </Button>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Add" size="lg">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
          className="flex flex-col gap-3"
        >
          <div className="flex items-center gap-2">
            <KindIcon kind={kind} className="h-6 w-6" />
            <input
              ref={inputRef}
              value={line}
              onChange={(event) => edit(event.target.value, event.target.selectionStart ?? 0)}
              onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
              onKeyDown={onKeyDown}
              autoFocus
              autoComplete="off"
              aria-label="New item"
              placeholder="@person  #project"
              className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            />
          </div>

          {suggestions.length > 0 ? (
            <ul role="listbox" className="flex flex-wrap gap-2">
              {suggestions.map((suggestion, index) => (
                <li key={`${suggestion.icon}:${suggestion.name}`}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === highlighted}
                    onClick={() => pick(suggestion)}
                    className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm ${
                      index === highlighted
                        ? 'border-blue-500 bg-blue-50 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200'
                        : 'border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700'
                    }`}
                  >
                    <Icon name={suggestion.icon} className="h-3.5 w-3.5" />
                    {suggestion.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          <FormError>{error}</FormError>

          <div className="flex items-center justify-between gap-3">
            <div className="flex gap-1">
              {KINDS.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setKind(option)}
                  aria-label={KIND[option].label}
                  aria-pressed={option === kind}
                  className={`flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-semibold text-gray-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 ${
                    option === kind
                      ? 'bg-gray-100 dark:bg-gray-700'
                      : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'
                  }`}
                >
                  <KindIcon kind={option} className="h-4 w-4" />
                  {PREFIX[option]}:
                </button>
              ))}
            </div>
            <Button type="submit" disabled={pending || line.trim() === ''}>
              Add
            </Button>
          </div>
        </form>
      </Modal>
    </>
  )
}
