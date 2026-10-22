'use client'

import { useId, useRef, useState } from 'react'
import { Icon, type IconName } from '@/components/ui/icons'
import { iconClass } from '@/components/ui/StatusBadge'
import { matchName, nameFromToken } from '@/lib/core/match'

export type PartyOption = {
  /**
   * What is submitted: an id, `person:<id>` / `group:<id>` / `name:<text>`,
   * or `new-person:<name>` / `new-group:<name>` for one to add. A new one's
   * value only keys it; what is submitted carries its `name` as edited.
   */
  value: string
  name: string
  /** `alert` is a name nobody has been matched to yet; `refresh` a series (Report to). */
  icon: 'person' | 'group' | 'alert' | 'refresh'
}

type NewKind = 'person' | 'group'

const NEW_PREFIX: Record<NewKind, string> = { person: 'new-person:', group: 'new-group:' }

/** A new person or group by this name, to be made when the form is saved. */
export function newParty(kind: NewKind, name: string): PartyOption {
  return { value: `${NEW_PREFIX[kind]}${name}`, name, icon: kind }
}

function newKind(option: PartyOption): NewKind | null {
  if (option.value.startsWith(NEW_PREFIX.person)) return 'person'
  if (option.value.startsWith(NEW_PREFIX.group)) return 'group'
  return null
}

/* What goes in the form: a new one by the name it now has. */
function submitted(option: PartyOption): string {
  const kind = newKind(option)
  return kind ? `${NEW_PREFIX[kind]}${option.name.trim()}` : option.value
}

/**
 * Pick people (or people and groups) by typing: a few letters suggest who is
 * meant, Enter or a click takes the suggestion, and each one chosen becomes a
 * chip. Every chip is submitted under `name`; whatever is still in the box
 * goes as `<name>Text`, for the server to resolve the way it resolves a name
 * anywhere else, so typing "sarah, tom" and submitting works too.
 *
 * With `allowNew`, a name that matches nobody is offered as a new person, and
 * with `allowNewGroup` (where a group is accepted) as a new group too. A new
 * one's chip holds its name in a field, to complete or correct before it is
 * made. A name typed and left in the box that matches nobody becomes a new
 * person on the server, the same as picking it (`<name>New` says so). A chip
 * still carrying only a name (`alert`) has its own suggestions under the box,
 * the same way: who it could be, and with `allowNew`, a new one by that name.
 * Picking one replaces the chip, and a new one's name is put in focus to
 * complete. Backspace in an empty box takes the last pick off; ⌘Enter, or Esc
 * once something is picked, submits the form it is in.
 *
 * With `me`, a fixed "Me" chip leads the box: John is at every meeting, so he
 * is never picked, but a roster without him reads as missing him.
 *
 * With `chosen` and `onChosen` the picks are held by the caller, and `move`
 * puts a button on each chip that hands it to another picker.
 */
export function PartyPicker({
  label,
  name,
  options,
  selected = [],
  required = false,
  allowNew = false,
  allowNewGroup = false,
  me = false,
  chosen: held,
  onChosen,
  move,
}: {
  label: string
  name: string
  options: PartyOption[]
  selected?: PartyOption[]
  required?: boolean
  allowNew?: boolean
  /** With `allowNew`: a new name may be a group as well. Only where a group is accepted. */
  allowNewGroup?: boolean
  me?: boolean
  chosen?: PartyOption[]
  onChosen?: (chosen: PartyOption[]) => void
  move?: { label: string; icon: IconName; to: (option: PartyOption) => void }
}) {
  const id = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [own, setOwn] = useState(selected)
  const chosen = held ?? own
  const setChosen = (next: (current: PartyOption[]) => PartyOption[]) =>
    onChosen ? onChosen(next(chosen)) : setOwn(next)
  const [text, setText] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  /* The new one just put in from a name's suggestions, whose name is focused to complete. */
  const [editing, setEditing] = useState<string | null>(null)

  // Only the last name being typed is completed; the ones before a comma stand.
  const comma = text.lastIndexOf(',')
  const partial = text.slice(comma + 1).trim()
  const taken = new Set(chosen.map((option) => option.value))
  const kinds: NewKind[] = allowNew ? (allowNewGroup ? ['person', 'group'] : ['person']) : []
  const fresh = (named: string) =>
    kinds.map((kind) => newParty(kind, named)).filter((option) => !taken.has(option.value))
  const matches =
    partial === ''
      ? []
      : matchName(
          options.filter((option) => !taken.has(option.value)),
          partial,
        ).slice(0, 6)
  const known = partial !== '' && options.some((option) => option.name.toLowerCase() === partial.toLowerCase())
  const suggestions: PartyOption[] = partial !== '' && !known ? [...matches, ...fresh(partial)] : matches

  /* A name still to settle: who it could be, by the whole name and failing
     that by its first word, then a new one by it. */
  const settle = chosen
    .filter((option) => option.icon === 'alert')
    .map((option) => {
      const free = options.filter((one) => !taken.has(one.value))
      const name = nameFromToken(option.name)
      const first = name.split(/\s+/)[0] ?? ''
      let found = matchName(free, name)
      if (found.length === 0 && first !== name) found = matchName(free, first)
      const exact = options.some((one) => one.name.toLowerCase() === name.toLowerCase())
      return { option, candidates: [...found.slice(0, 5), ...(exact ? [] : fresh(name))] }
    })
    .filter((one) => one.candidates.length > 0)

  function replace(option: PartyOption, by: PartyOption) {
    setChosen((current) => current.map((one) => (one.value === option.value ? by : one)))
    if (newKind(by)) setEditing(by.value)
  }

  function rename(option: PartyOption, to: string) {
    setChosen((current) => current.map((one) => (one.value === option.value ? { ...one, name: to } : one)))
  }

  function pick(option: PartyOption) {
    setChosen((current) => [...current, option])
    setText(text.slice(0, comma + 1))
    setHighlighted(0)
    inputRef.current?.focus()
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    const finish =
      (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) ||
      (event.key === 'Escape' && chosen.length > 0 && text === '')
    if (finish) {
      event.preventDefault()
      event.currentTarget.form?.requestSubmit()
      return
    }
    if (event.key === 'Escape' && text !== '') {
      // The first Esc clears what is being typed; the dialog stays open.
      event.preventDefault()
      setText(text.slice(0, comma + 1))
      return
    }
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
        {/* The magnifier marks a box that searches, as `SearchInput` does. */}
        <Icon name="search" className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" />
        {me ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900/40 dark:text-blue-200">
            <Icon name="person" className="h-3.5 w-3.5 shrink-0" />
            Me
          </span>
        ) : null}
        {chosen.map((option) => {
          const kind = newKind(option)
          return (
            <span
              key={option.value}
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-gray-100 py-0.5 pl-2 pr-1 text-xs font-medium text-gray-700 dark:bg-gray-600 dark:text-gray-200"
            >
              <input type="hidden" name={name} value={submitted(option)} />
              {kind ? <Icon name="plus" className="h-3 w-3 shrink-0" /> : null}
              <Icon
                name={option.icon}
                className="h-3.5 w-3.5 shrink-0"
                label={option.icon === 'alert' ? 'Not matched' : kind ? `New ${kind}` : undefined}
              />
              {kind ? (
                <input
                  value={option.name}
                  onChange={(event) => rename(option, event.target.value)}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    // Enter settles the name and goes back to the box; it never submits.
                    if (event.key === 'Enter' || event.key === 'Escape') {
                      event.preventDefault()
                      inputRef.current?.focus()
                    }
                  }}
                  onBlur={() => setEditing(null)}
                  ref={(input) => {
                    if (input && editing === option.value && document.activeElement !== input) input.focus()
                  }}
                  aria-label={`New ${kind}'s name`}
                  size={Math.max(option.name.length, 4)}
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  data-bwignore
                  data-form-type="other"
                  className="min-w-0 rounded border-0 bg-transparent px-0.5 py-0 text-xs font-medium focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 dark:focus:bg-gray-800"
                />
              ) : (
                <span className="truncate">{option.name}</span>
              )}
              {move ? (
                <button
                  type="button"
                  aria-label={`${option.name}: ${move.label}`}
                  title={move.label}
                  onClick={() => move.to(option)}
                  className="flex h-4 w-4 items-center justify-center rounded-full text-gray-400 hover:bg-gray-200 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 dark:hover:bg-gray-500 dark:hover:text-gray-100"
                >
                  <Icon name={move.icon} className="h-3 w-3" />
                </button>
              ) : null}
              <button
                type="button"
                aria-label={`Remove ${option.name}`}
                onClick={() => setChosen((current) => current.filter((one) => one.value !== option.value))}
                className="flex h-4 w-4 items-center justify-center rounded-full text-gray-400 hover:bg-gray-200 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 dark:hover:bg-gray-500 dark:hover:text-gray-100"
              >
                <Icon name="close" className="h-3 w-3" />
              </button>
            </span>
          )
        })}
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
          placeholder={chosen.length === 0 && !me ? 'Search' : undefined}
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          data-form-type="other"
          className="min-w-[6rem] flex-1 border-0 bg-transparent p-0.5 text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-0 sm:text-sm dark:text-gray-100 dark:placeholder:text-gray-500"
        />
      </div>
      {allowNew ? <input type="hidden" name={`${name}New`} value={kinds.join(',')} /> : null}

      {settle.map(({ option, candidates }) => (
        <ul
          key={option.value}
          role="listbox"
          aria-label={`Who is ${option.name}?`}
          className="mt-2 flex flex-wrap items-center gap-2"
        >
          <Icon name="alert" className={`h-3.5 w-3.5 shrink-0 ${iconClass('amber')}`} />
          {candidates.map((candidate) => (
            <li key={candidate.value}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => replace(option, candidate)}
                {...newLabel(candidate)}
                className={`flex items-center gap-1.5 rounded-full border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700 ${
                  newKind(candidate) ? 'border-dashed' : ''
                }`}
              >
                {newKind(candidate) ? <Icon name="plus" className="h-3.5 w-3.5" /> : null}
                <Icon name={candidate.icon} className="h-3.5 w-3.5" />
                {candidate.name}
              </button>
            </li>
          ))}
        </ul>
      ))}

      {suggestions.length > 0 ? (
        <ul role="listbox" aria-label={label} className="mt-2 flex flex-wrap gap-2">
          {suggestions.map((option, index) => (
            <li key={option.value}>
              <button
                type="button"
                role="option"
                aria-selected={index === highlighted}
                onClick={() => pick(option)}
                {...newLabel(option)}
                className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm ${
                  index === highlighted
                    ? 'border-blue-500 bg-blue-50 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200'
                    : `border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700 ${
                        newKind(option) ? 'border-dashed' : ''
                      }`
                }`}
              >
                {newKind(option) ? <Icon name="plus" className="h-3.5 w-3.5" /> : null}
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

/* A new one reads as what it makes, "New person Sarah", the way quick-add's do. */
function newLabel(option: PartyOption): { 'aria-label'?: string; title?: string } {
  const kind = newKind(option)
  return kind ? { 'aria-label': `New ${kind} ${option.name}`, title: `New ${kind}` } : {}
}
