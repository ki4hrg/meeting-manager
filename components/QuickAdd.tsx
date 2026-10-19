'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { captureAction } from '@/app/(app)/actions'
import { useDirectory } from '@/components/Directory'
import { useToast } from '@/components/Toast'
import { Button, buttonClasses } from '@/components/ui/Button'
import { FormError } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import { Modal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import { ContextBadge, KIND, KindIcon, type ItemKind } from '@/components/ui/StatusBadge'
import { matchName, nameFromToken, normalise, tokenFor } from '@/lib/core/match'
import type { NewKind } from '@/lib/directory/create'
import type { CapturePresets, NewMention } from '@/lib/items/capture'

const PREFIX: Record<ItemKind, string> = { topic: 'T', question: 'Q', action: 'A', decision: 'D' }
const KINDS = Object.keys(PREFIX) as ItemKind[]
const KIND_OF_PREFIX = /^([tqad]):\s*/i

/* A whole line of each kind, so the box shows what goes in it, not only the @. */
const EXAMPLE: Record<ItemKind, string> = {
  topic: 'Hall booking for May @name',
  question: 'Who has the hall key? @name',
  action: 'Send the draft @name',
  decision: 'Book the hall for May #project',
}

/* The @, # or > token the caret is at the end of, if any. */
const ACTIVE_TOKEN = /(?:^|\s)([@#>])([\p{L}\p{N}_/-]*)$/u

/* A whole token in the line, as the server reads it. */
const WHOLE_TOKEN = /^([@#>])([\p{L}\p{N}][\p{L}\p{N}_/-]*)[.,;:!?]*$/u

const NEW_FOR: Record<string, NewKind[]> = { '@': ['person', 'group'], '#': ['project'], '>': ['series'] }

type SuggestionIcon = 'person' | 'group' | 'project' | 'refresh'

const ICON_OF: Record<NewKind, SuggestionIcon> = {
  person: 'person',
  group: 'group',
  project: 'project',
  series: 'refresh',
}

/** Something to complete the token with; with `create`, a new one by that name. */
export type Suggestion = { name: string; icon: SuggestionIcon; create?: NewKind }

function newRows(sigil: string, token: string): Suggestion[] {
  return (NEW_FOR[sigil] ?? []).map((kind) => ({ name: nameFromToken(token), icon: ICON_OF[kind], create: kind }))
}

function tokensIn(line: string): string[] {
  return line.split(/\s+/).flatMap((word) => {
    const token = WHOLE_TOKEN.exec(word)
    return token ? [`${token[1]}${token[2]}`] : []
  })
}

function kindOf(line: string, fallback: ItemKind): ItemKind {
  const prefix = KIND_OF_PREFIX.exec(line.trimStart())
  if (!prefix) return fallback
  return KINDS.find((kind) => PREFIX[kind].toLowerCase() === prefix[1]!.toLowerCase())!
}

/**
 * Quick-add: one line, `@` for a person, group, project or series, and an optional
 * kind prefix. In the top bar it captures into the selected context; on a hub
 * page it carries that page's person, group or project as presets.
 */
export function QuickAdd({
  presets,
  variant = 'button',
  label = 'Add',
  title = 'Add',
  primary = false,
  context,
}: {
  presets?: CapturePresets
  /** The modal's title, where the button's label alone would not say what it makes. */
  title?: string
  /** The selected context's name, shown where several exist: it is where the line goes. */
  context?: string
  /** `bar` is the icon in the top bar, which also answers to the N key. */
  variant?: 'bar' | 'button'
  label?: string
  /** The page's one blue action (the Inbox); elsewhere it is a gray section add. */
  primary?: boolean
}) {
  const directory = useDirectory()
  const toast = useToast()
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [line, setLine] = useState('')
  const [caret, setCaret] = useState(0)
  const [highlighted, setHighlighted] = useState(0)
  const [error, setError] = useState<string>()
  /* Tokens picked as new, and the name each is to be made with. */
  const [fresh, setFresh] = useState<NewMention[]>([])
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
  const present = new Set(tokensIn(line))
  const picked = fresh.filter((one) => present.has(one.token))
  const isFresh = (token: string) => picked.some((one) => one.token === token)
  let suggestions: Suggestion[] = []
  /* In the server's order of precedence: who, then projects, then series. */
  const tiers: Suggestion[][] = [
    [
      ...directory.people.map((p) => ({ name: p.name, icon: 'person' as const })),
      ...directory.groups.map((g) => ({ name: g.name, icon: 'group' as const })),
    ],
    directory.projects.map((p) => ({ name: p.name, icon: 'project' as const })),
    directory.series.map((s) => ({ name: s.name, icon: 'refresh' as const })),
  ]
  if (active) {
    // One @ for everything; # and > narrow to projects or series.
    const offered = active[1] === '@' ? tiers : active[1] === '#' ? [tiers[1]!] : [tiers[2]!]
    suggestions = offered
      .flatMap((pool) => (partial === '' ? pool : matchName(pool, partial)))
      .slice(0, 6)
    const exact = offered.some((pool) => pool.some((one) => normalise(one.name) === normalise(partial)))
    // Already typed out in full: nothing left to suggest, so Enter submits.
    if (suggestions.length === 1 && exact) suggestions = []
    if (isFresh(`${active[1]}${partial}`)) suggestions = []
    else if (!exact && WHOLE_TOKEN.test(`${active[1]}${partial}`) && partial.toLowerCase() !== 'me') {
      suggestions = [...suggestions, ...newRows(active[1]!, partial)]
    }
  }

  /* After a refusal, the first token that matches nothing, offered as new in place. */
  const unknown =
    error && suggestions.length === 0
      ? tokensIn(line).find((token) => {
          const name = token.slice(1)
          if (isFresh(token) || name.toLowerCase() === 'me') return false
          const pools = token[0] === '@' ? tiers : token[0] === '#' ? [tiers[1]!] : [tiers[2]!]
          return pools.every((pool) => matchName(pool, name).length === 0)
        })
      : undefined
  if (unknown) suggestions = newRows(unknown[0]!, unknown.slice(1))

  /* While a token is typed, a new one is highlighted only with the arrows: a
     line typed out in full and entered is refused, not filled with new
     people. Once refused, the fix is first. */
  const current =
    highlighted >= 0 && highlighted < suggestions.length
      ? highlighted
      : suggestions[0] && (!suggestions[0].create || unknown)
        ? 0
        : -1

  function edit(next: string, nextCaret: number) {
    setLine(next)
    setCaret(nextCaret)
    setHighlighted(-1)
    setError(undefined)
  }

  function markNew(token: string, suggestion: Suggestion) {
    setFresh((now) => [
      ...now.filter((one) => one.token !== token),
      { token, type: suggestion.create!, name: suggestion.name },
    ])
  }

  function pick(suggestion: Suggestion) {
    if (suggestion.create && unknown) {
      markNew(unknown, suggestion)
      setError(undefined)
      setHighlighted(-1)
      inputRef.current?.focus()
      return
    }
    if (!active) return
    if (suggestion.create) {
      // The token stays as typed; the name it is made with is fixed below the line.
      markNew(`${active[1]}${partial}`, suggestion)
      const rest = line.slice(caret)
      const next = line.slice(0, caret) + (rest.startsWith(' ') ? '' : ' ') + rest
      edit(next, caret + 1)
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.setSelectionRange(caret + 1, caret + 1)
      })
      return
    }
    /* An @ that would reach something else of the same name first (a group
       and a project both called "Retreat") is written as # or > instead. */
    const tier = tiers.findIndex((pool) => pool.some((one) => one.icon === suggestion.icon))
    const shadowed =
      active[1] === '@' &&
      tiers.slice(0, tier).some((pool) => pool.some((one) => normalise(one.name) === normalise(suggestion.name)))
    const sigil = shadowed ? (suggestion.icon === 'project' ? '#' : '>') : active[1]!
    const start = caret - partial.length - 1
    const token = `${sigil}${tokenFor(suggestion.name)} `
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
    const value = line
    if (value.trim() === '') return
    const data = new FormData()
    data.set('line', value)
    data.set('presets', JSON.stringify(presets ?? {}))
    const created = picked
    data.set('create', JSON.stringify(created))

    /* Capture often comes in batches, so the field is cleared at once and
       nothing is disabled while a line is saved: the next can be typed and
       entered before this one has landed. (A disabled submit button would
       swallow Enter.) */
    edit('', 0)
    setFresh([])
    inputRef.current?.focus()
    startTransition(async () => {
      const result = await captureAction(data)
      if (!result?.error) {
        toast.success('Added')
        return
      }
      // Back to be corrected, unless the next line is already being typed.
      if (inputRef.current?.value === '') {
        edit(value, value.length)
        setFresh(created)
        setError(result.error)
      } else {
        toast.error(`${value}: ${result.error}`)
      }
    })
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (suggestions.length === 0) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      const from = current < 0 ? (step === 1 ? -1 : 0) : current
      setHighlighted((from + step + suggestions.length) % suggestions.length)
    } else if ((event.key === 'Enter' || event.key === 'Tab') && current >= 0) {
      event.preventDefault()
      pick(suggestions[current]!)
    }
  }

  function rename(token: string, name: string) {
    setFresh((now) => now.map((one) => (one.token === token ? { ...one, name } : one)))
  }

  return (
    <>
      {variant === 'bar' ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Add"
          title="Add"
          className={buttonClasses('primary', 'md', 'h-9 w-9 !p-0')}
        >
          <Icon name="plus" />
        </button>
      ) : (
        <Button variant={primary ? 'primary' : 'secondary'} size={primary ? 'md' : 'sm'} onClick={() => setOpen(true)}>
          <Icon name="plus" className="h-4 w-4" />
          {label}
        </Button>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title={title} size="lg">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
          className="flex flex-col gap-3"
        >
          {context ? (
            <div className="flex">
              <ContextBadge name={context} />
            </div>
          ) : null}
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
              data-1p-ignore
              data-lpignore="true"
              data-bwignore
              data-form-type="other"
              aria-label="New item"
              placeholder={EXAMPLE[kind]}
              className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            />
          </div>

          <MentionSuggestions suggestions={suggestions} highlighted={current} onPick={pick} />
          <NewNames
            names={picked}
            onRename={rename}
            onRemove={(token) => setFresh((now) => now.filter((one) => one.token !== token))}
          />

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
            <div className="flex items-center gap-3">
              {/* The field is already clear for the next line; this says the last one is still on its way. */}
              {pending ? <Spinner /> : null}
              <Button type="submit" disabled={line.trim() === ''}>
                Add
              </Button>
            </div>
          </div>
        </form>
      </Modal>
    </>
  )
}

/** What the token at the caret could be; a `create` row makes it new. */
export function MentionSuggestions({
  suggestions,
  highlighted,
  onPick,
}: {
  suggestions: Suggestion[]
  highlighted: number
  onPick?: (suggestion: Suggestion) => void
}) {
  if (suggestions.length === 0) return null
  return (
    <ul role="listbox" className="flex flex-wrap gap-2">
      {suggestions.map((suggestion, index) => (
        <li key={`${suggestion.create ?? ''}${suggestion.icon}:${suggestion.name}`}>
          <button
            type="button"
            role="option"
            aria-selected={index === highlighted}
            aria-label={suggestion.create ? `New ${suggestion.create} ${suggestion.name}` : undefined}
            title={suggestion.create ? `New ${suggestion.create}` : undefined}
            onClick={() => onPick?.(suggestion)}
            className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm ${
              index === highlighted
                ? 'border-blue-500 bg-blue-50 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200'
                : `border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700 ${
                    suggestion.create ? 'border-dashed' : ''
                  }`
            }`}
          >
            {suggestion.create ? <Icon name="plus" className="h-3.5 w-3.5" /> : null}
            <Icon name={suggestion.icon} className="h-3.5 w-3.5" />
            {suggestion.name}
          </button>
        </li>
      ))}
    </ul>
  )
}

/** The tokens picked as new, each with the name it will be made with, to fix first. */
export function NewNames({
  names,
  onRename,
  onRemove,
}: {
  names: NewMention[]
  onRename?: (token: string, name: string) => void
  onRemove?: (token: string) => void
}) {
  if (names.length === 0) return null
  return (
    <ul className="flex flex-wrap gap-2">
      {names.map((one) => (
        <li
          key={one.token}
          className="inline-flex max-w-full items-center gap-1 rounded-full bg-gray-100 py-0.5 pl-2.5 pr-0.5 text-xs font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-300"
        >
          <Icon name="plus" className="h-3 w-3 shrink-0" />
          <Icon name={ICON_OF[one.type]} className="h-3.5 w-3.5 shrink-0" label={`New ${one.type}`} />
          <input
            value={one.name}
            onChange={(event) => onRename?.(one.token, event.target.value)}
            readOnly={!onRename}
            aria-label={`Name for ${one.token}`}
            size={Math.max(one.name.length, 4)}
            className="min-w-0 rounded bg-transparent px-0.5 focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 dark:focus:bg-gray-800"
          />
          <button
            type="button"
            onClick={() => onRemove?.(one.token)}
            aria-label="Remove"
            title="Remove"
            className="rounded-full p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-600 dark:hover:text-gray-200"
          >
            <Icon name="close" className="h-3 w-3" />
          </button>
        </li>
      ))}
    </ul>
  )
}
