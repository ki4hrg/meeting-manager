'use client'

import { useMemo, useRef, useState } from 'react'
import { copyRich } from '@/components/CopyButton'
import { useToast } from '@/components/Toast'
import { Button, type ButtonProps } from '@/components/ui/Button'
import { Icon, type IconName } from '@/components/ui/icons'
import { Modal } from '@/components/ui/Modal'
import { PRIVATE_TONE, iconClass, pillClass } from '@/components/ui/StatusBadge'
import {
  EXPORTS,
  escapeHtml,
  pick,
  toHtml,
  toMarkdown,
  type ExportKind,
  type OutlinePart,
} from '@/lib/agenda/export'

type Format = 'clipboard' | 'pdf' | 'email' | 'markdown'

const FORMATS: Array<{ format: Format; label: string; icon: IconName }> = [
  { format: 'clipboard', label: 'Copy', icon: 'copy' },
  { format: 'pdf', label: 'PDF', icon: 'printer' },
  { format: 'email', label: 'Email', icon: 'mail' },
  { format: 'markdown', label: 'Markdown', icon: 'download' },
]

const PRESET_ICON: Record<string, IconName> = { Private: 'lock', Shareable: 'group' }

/* The page as it prints: plain type, nothing of the app around it. */
const PRINT_CSS =
  'body{font:14px/1.5 system-ui,sans-serif;color:#111;margin:2rem}' +
  'h1{font-size:1.5rem;margin:0 0 .25rem}h2{font-size:1.1rem;margin:1.5rem 0 .25rem}' +
  'p{margin:.25rem 0}ul{margin:.25rem 0;padding-left:1.25rem}li{margin:.1rem 0}'

type Saved = { parts: string[]; format: Format }

const storageKey = (kind: ExportKind) => `mm-export:${kind}`

function load(kind: ExportKind): Saved | null {
  try {
    const raw = localStorage.getItem(storageKey(kind))
    if (!raw) return null
    const saved = JSON.parse(raw) as Partial<Saved>
    const keys = new Set(EXPORTS[kind].options.map((option) => option.key))
    if (!Array.isArray(saved.parts) || !FORMATS.some((one) => one.format === saved.format)) return null
    return { parts: saved.parts.filter((part) => keys.has(part)), format: saved.format! }
  } catch {
    return null
  }
}

function save(kind: ExportKind, saved: Saved) {
  try {
    localStorage.setItem(storageKey(kind), JSON.stringify(saved))
  } catch {
    // Remembering the choice is a convenience; without storage it starts from the preset.
  }
}

function printHtml(title: string, html: string) {
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
  document.body.appendChild(frame)
  const win = frame.contentWindow
  if (!win) return frame.remove()
  win.document.open()
  win.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${PRINT_CSS}</style></head><body>${html}</body></html>`,
  )
  win.document.close()
  win.addEventListener('afterprint', () => frame.remove())
  win.focus()
  win.print()
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${name.replace(/[\\/:*?"<>|]+/g, '').trim() || 'export'}.md`
  link.click()
  URL.revokeObjectURL(url)
}

/**
 * One Export for an agenda or a recap: which parts it holds, then where it
 * goes. The outline comes built from the server with every optional piece
 * marked (lib/agenda/export.ts); the choice is applied here, so a toggle is
 * instant. The last choice is remembered per kind, in this browser.
 */
export function Export({
  kind,
  outline,
  title,
  mailto,
  variant = 'primary',
}: {
  kind: ExportKind
  outline: OutlinePart[]
  /** The document's name: the PDF's title, the file's name. */
  title: string
  /** Who it goes to and its subject; the body rides on the clipboard. */
  mailto: string
  variant?: ButtonProps['variant']
}) {
  const { options, presets } = EXPORTS[kind]
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [parts, setParts] = useState<string[]>(presets[0]!.parts)
  const [format, setFormat] = useState<Format>('clipboard')
  const [manual, setManual] = useState<string | null>(null)
  const fallbackRef = useRef<HTMLTextAreaElement>(null)

  /* Read when the modal opens, so the page renders the same on the server and in the browser. */
  function show() {
    const saved = load(kind)
    if (saved) {
      setParts(saved.parts)
      setFormat(saved.format)
    }
    setOpen(true)
  }

  const chosen = useMemo(() => new Set(parts), [parts])
  const isPrivate = options.some((option) => option.private && chosen.has(option.key))
  const same = (preset: string[]) => preset.length === chosen.size && preset.every((part) => chosen.has(part))

  function choose(next: string[]) {
    setParts(next)
    save(kind, { parts: next, format })
  }

  async function run(next: Format) {
    setFormat(next)
    save(kind, { parts, format: next })
    const kept = pick(outline, chosen)
    const text = toMarkdown(kept)
    const html = toHtml(kept)
    const copied = isPrivate ? 'Copied (private)' : 'Copied'

    if (next === 'pdf') return printHtml(title, html)
    if (next === 'markdown') return download(title, text)
    if (next === 'email') {
      // The copy starts on the click; the mail program opens on the same gesture.
      copyRich(text, html).then(
        () => toast.success(copied),
        () => {},
      )
      window.location.assign(mailto)
      return
    }
    try {
      await copyRich(text, html)
      toast.success(copied)
      setOpen(false)
    } catch {
      setManual(text)
      requestAnimationFrame(() => fallbackRef.current?.select())
    }
  }

  return (
    <>
      <Button variant={variant} onClick={show}>
        <Icon name="share" className="h-4 w-4" />
        Export
      </Button>

      {/* Mounted only when open: an export can hold private notes, which should not sit in the page. */}
      {open ? (
        <Modal
          open
          onClose={() => {
            setOpen(false)
            setManual(null)
          }}
          title="Export"
        >
          {manual !== null ? (
            <textarea
              ref={fallbackRef}
              readOnly
              value={manual}
              rows={16}
              aria-label="Export"
              className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-xs text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            />
          ) : (
            <div className="flex flex-col gap-5">
              <div className="flex flex-wrap gap-2">
                {presets.map((preset) => {
                  const on = same(preset.parts)
                  return (
                    <button
                      key={preset.name}
                      type="button"
                      onClick={() => choose(preset.parts)}
                      aria-pressed={on}
                      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                        on ? pillClass('blue') : `${pillClass('gray')} hover:bg-gray-200 dark:hover:bg-gray-600`
                      }`}
                    >
                      <Icon name={PRESET_ICON[preset.name] ?? 'check'} className="h-4 w-4" />
                      {preset.name}
                    </button>
                  )
                })}
              </div>

              <fieldset className="min-w-0">
                <legend className="block text-sm font-medium text-gray-700 dark:text-gray-300">Includes</legend>
                <div className="mt-1 rounded-md border border-gray-300 bg-white py-1 shadow-sm dark:border-gray-600 dark:bg-gray-700">
                  {options.map((option) => (
                    <label
                      key={option.key}
                      className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-gray-900 hover:bg-gray-50 dark:text-gray-100 dark:hover:bg-gray-600"
                    >
                      <input
                        type="checkbox"
                        checked={chosen.has(option.key)}
                        onChange={(event) =>
                          choose(
                            event.target.checked
                              ? [...parts, option.key]
                              : parts.filter((part) => part !== option.key),
                          )
                        }
                        className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-500"
                      />
                      <span className="min-w-0 flex-1 truncate">{option.label}</span>
                      {option.private ? (
                        <Icon name="lock" label="Private" className={`h-4 w-4 shrink-0 ${iconClass(PRIVATE_TONE)}`} />
                      ) : null}
                    </label>
                  ))}
                </div>
              </fieldset>

              {/* The format last used is the blue one. */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {FORMATS.map((one) => (
                  <Button
                    key={one.format}
                    variant={one.format === format ? 'primary' : 'secondary'}
                    onClick={() => run(one.format)}
                  >
                    <Icon name={one.icon} className="h-4 w-4" />
                    {one.label}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </Modal>
      ) : null}
    </>
  )
}
