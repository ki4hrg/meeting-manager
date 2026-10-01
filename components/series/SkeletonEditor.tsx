'use client'

import { useState, useTransition } from 'react'
import {
  pasteSkeletonAction,
  saveSkeletonAction,
} from '@/app/(app)/series/actions'
import { FormModal } from '@/components/forms'
import { useToast } from '@/components/Toast'
import { Card, Section } from '@/components/ui/Card'
import { Field, Input, Textarea } from '@/components/ui/Field'
import { IconButton } from '@/components/ui/IconButton'
import { Icon } from '@/components/ui/icons'
import { Spinner } from '@/components/ui/Spinner'
import type { SkeletonSection } from '@/lib/db/schema'

/* What is on screen: the skeleton, plus a key per row so a row keeps its input
   (and its focus) when it moves, and minutes as typed. */
type Line = { key: string; text: string; minutes: string }
type Block = { key: string; title: string; lines: Line[] }

let nextKey = 0
const newKey = () => `k${nextKey++}`

function toBlocks(skeleton: SkeletonSection[]): Block[] {
  return skeleton.map((section) => ({
    key: newKey(),
    title: section.title,
    lines: section.lines.map((line) => ({
      key: newKey(),
      text: line.text,
      minutes: line.minutes ? String(line.minutes) : '',
    })),
  }))
}

function minutesOf(value: string): number | undefined {
  const minutes = Number(value)
  return Number.isInteger(minutes) && minutes > 0 ? minutes : undefined
}

/* What is stored: untitled sections and blank lines are not part of it. */
function toSkeleton(blocks: Block[]): SkeletonSection[] {
  return blocks
    .filter((block) => block.title.trim() !== '')
    .map((block) => ({
      title: block.title.trim(),
      lines: block.lines
        .filter((line) => line.text.trim() !== '')
        .map((line) => {
          const minutes = minutesOf(line.minutes)
          return minutes ? { text: line.text.trim(), minutes } : { text: line.text.trim() }
        }),
    }))
}

const total = (block: Block) =>
  block.lines.reduce((sum, line) => sum + (minutesOf(line.minutes) ?? 0), 0)

const ROW_INPUT = '!mt-0 !py-1.5'

/**
 * The standing agenda of a series: sections, and the lines under each.
 *
 * Typing changes only what is on screen; leaving a field, pressing Enter, or
 * adding, removing or moving a row saves the whole skeleton.
 */
export function SkeletonEditor({
  seriesId,
  skeleton,
}: {
  seriesId: string
  skeleton: SkeletonSection[]
}) {
  const toast = useToast()
  const [blocks, setBlocks] = useState(() => toBlocks(skeleton))
  /* What the server last had from here, so leaving a field that did not change
     saves nothing. Saves made in quick succession still land in the order
     made: server actions are sent one at a time. */
  const [saved, setSaved] = useState(() => JSON.stringify(skeleton))
  const [saving, startSaving] = useTransition()

  function save(next: Block[]) {
    const payload = JSON.stringify(toSkeleton(next))
    if (payload === saved) return
    setSaved(payload)

    const data = new FormData()
    data.set('id', seriesId)
    data.set('skeleton', payload)
    startSaving(async () => {
      const result = await saveSkeletonAction(data)
      if (result?.error) toast.error(result.error)
    })
  }

  /** A change that is saved as it is made. */
  function commit(next: Block[]) {
    setBlocks(next)
    save(next)
  }

  const editBlock = (key: string, patch: Partial<Block>) =>
    blocks.map((block) => (block.key === key ? { ...block, ...patch } : block))

  const editLine = (blockKey: string, lineKey: string, patch: Partial<Line>) =>
    blocks.map((block) =>
      block.key === blockKey
        ? {
            ...block,
            lines: block.lines.map((line) => (line.key === lineKey ? { ...line, ...patch } : line)),
          }
        : block,
    )

  /* Leaving a field: an emptied line goes, and an emptied title comes back,
     since a section without one would take its lines with it. */
  function settle() {
    const stored = JSON.parse(saved) as SkeletonSection[]
    let titled = 0
    const next = blocks.map((block) => {
      const title = block.title.trim() === '' ? (stored[titled]?.title ?? 'Section') : block.title
      titled++
      return { ...block, title, lines: block.lines.filter((line) => line.text.trim() !== '') }
    })
    commit(next)
  }

  function moveBlock(index: number, by: -1 | 1) {
    const next = [...blocks]
    const [block] = next.splice(index, 1)
    next.splice(index + by, 0, block!)
    commit(next)
  }

  /* Past the end of its section, a line carries on into the neighbouring one. */
  function moveLine(blockIndex: number, lineIndex: number, by: -1 | 1) {
    const next = blocks.map((block) => ({ ...block, lines: [...block.lines] }))
    const lines = next[blockIndex]!.lines
    const [line] = lines.splice(lineIndex, 1)
    const target = lineIndex + by

    if (target >= 0 && target <= lines.length) lines.splice(target, 0, line!)
    else if (by === -1) next[blockIndex - 1]!.lines.push(line!)
    else next[blockIndex + 1]!.lines.unshift(line!)
    commit(next)
  }

  /* An "add" field: Enter, or leaving it, adds what was typed and leaves the
     field ready for the next. */
  function adding(add: (text: string) => void) {
    const take = (input: HTMLInputElement) => {
      const text = input.value.trim()
      if (text === '') return
      input.value = ''
      add(text)
    }
    return {
      onBlur: (event: React.FocusEvent<HTMLInputElement>) => take(event.currentTarget),
      onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        take(event.currentTarget)
      },
    }
  }

  const blurOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') event.currentTarget.blur()
  }

  async function paste(formData: FormData) {
    const result = await pasteSkeletonAction(formData)
    if (!result.error && result.skeleton) {
      setSaved(JSON.stringify(result.skeleton))
      setBlocks(toBlocks(result.skeleton))
    }
    return result
  }

  return (
    <Section
      title="Skeleton"
      action={
        <span className="flex items-center gap-2">
          {saving ? <Spinner /> : null}
          <FormModal
            action={paste}
            title="Paste outline"
            label="Paste"
            icon="clipboard"
            variant="secondary"
            size="sm"
            submit="Replace"
          >
            <input type="hidden" name="id" value={seriesId} />
            <Field label="Outline" required>
              <Textarea
                name="outline"
                rows={10}
                required
                placeholder={'# Opening\n- Prayer 5\n# Business\n- Budget 15'}
                className="font-mono"
              />
            </Field>
          </FormModal>
        </span>
      }
    >
      <div className="flex flex-col gap-3">
        {blocks.map((block, blockIndex) => {
          const minutes = total(block)
          return (
            <Card key={block.key}>
              <div className="flex items-center gap-1">
                <Input
                  aria-label="Section"
                  value={block.title}
                  onChange={(event) => setBlocks(editBlock(block.key, { title: event.target.value }))}
                  onBlur={settle}
                  onKeyDown={blurOnEnter}
                  className={`${ROW_INPUT} min-w-0 flex-1 !border-transparent !bg-transparent !px-1 !font-semibold !shadow-none hover:!border-gray-300 focus:!border-blue-500 dark:hover:!border-gray-600`}
                />
                {minutes > 0 ? (
                  <span className="flex shrink-0 items-center gap-1 px-1 text-xs tabular-nums text-gray-500 dark:text-gray-400">
                    <Icon name="clock" className="h-3.5 w-3.5" label="Minutes" />
                    {minutes}
                  </span>
                ) : null}
                <IconButton
                  icon="chevronUp"
                  label="Move section up"
                  disabled={blockIndex === 0}
                  onClick={() => moveBlock(blockIndex, -1)}
                />
                <IconButton
                  icon="chevronDown"
                  label="Move section down"
                  disabled={blockIndex === blocks.length - 1}
                  onClick={() => moveBlock(blockIndex, 1)}
                />
                <IconButton
                  icon="trash"
                  label="Remove section"
                  onClick={() => commit(blocks.filter((other) => other.key !== block.key))}
                />
              </div>

              <ul className="mt-2 flex flex-col gap-1.5">
                {block.lines.map((line, lineIndex) => (
                  <li key={line.key} className="flex items-center gap-1">
                    <Input
                      aria-label="Line"
                      value={line.text}
                      onChange={(event) =>
                        setBlocks(editLine(block.key, line.key, { text: event.target.value }))
                      }
                      onBlur={settle}
                      onKeyDown={blurOnEnter}
                      className={`${ROW_INPUT} min-w-0 flex-1`}
                    />
                    <Input
                      aria-label="Minutes"
                      title="Minutes"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      placeholder="min"
                      value={line.minutes}
                      onChange={(event) =>
                        setBlocks(editLine(block.key, line.key, { minutes: event.target.value }))
                      }
                      onBlur={settle}
                      onKeyDown={blurOnEnter}
                      className={`${ROW_INPUT} !w-16 shrink-0 !px-2 text-right tabular-nums`}
                    />
                    <IconButton
                      icon="chevronUp"
                      label="Move line up"
                      disabled={blockIndex === 0 && lineIndex === 0}
                      onClick={() => moveLine(blockIndex, lineIndex, -1)}
                    />
                    <IconButton
                      icon="chevronDown"
                      label="Move line down"
                      disabled={
                        blockIndex === blocks.length - 1 && lineIndex === block.lines.length - 1
                      }
                      onClick={() => moveLine(blockIndex, lineIndex, 1)}
                    />
                    <IconButton
                      icon="close"
                      label="Remove line"
                      onClick={() =>
                        commit(
                          editBlock(block.key, {
                            lines: block.lines.filter((other) => other.key !== line.key),
                          }),
                        )
                      }
                    />
                  </li>
                ))}
                <li className="flex items-center gap-1">
                  <Icon name="plus" className="mx-1.5 h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" />
                  <Input
                    aria-label="Add line"
                    placeholder="Line"
                    enterKeyHint="done"
                    {...adding((text) =>
                      commit(
                        editBlock(block.key, {
                          lines: [...block.lines, { key: newKey(), text, minutes: '' }],
                        }),
                      ),
                    )}
                    className={`${ROW_INPUT} min-w-0 flex-1 !border-dashed !shadow-none`}
                  />
                </li>
              </ul>
            </Card>
          )
        })}

        <div className="flex items-center gap-2 rounded-lg border border-dashed border-gray-300 p-3 dark:border-gray-700">
          <Icon name="section" className="ml-1 h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" />
          <Input
            aria-label="Add section"
            placeholder="Section"
            enterKeyHint="done"
            {...adding((title) => commit([...blocks, { key: newKey(), title, lines: [] }]))}
            className={`${ROW_INPUT} min-w-0 flex-1`}
          />
        </div>
      </div>
    </Section>
  )
}
