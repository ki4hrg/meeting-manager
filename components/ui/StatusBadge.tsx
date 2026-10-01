import { Icon, type IconName } from './icons'

/*
 * The one colour map. Every kind, status and section takes its colour from
 * here, so a colour means the same thing on every screen.
 */

export type Tone = 'blue' | 'green' | 'amber' | 'purple' | 'teal' | 'red' | 'gray'

const PILL: Record<Tone, string> = {
  blue: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  green: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  purple: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
  teal: 'bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300',
  red: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  gray: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
}

const ICON: Record<Tone, string> = {
  blue: 'text-blue-600 dark:text-blue-400',
  green: 'text-green-600 dark:text-green-400',
  amber: 'text-amber-500 dark:text-amber-400',
  purple: 'text-purple-600 dark:text-purple-400',
  teal: 'text-teal-600 dark:text-teal-400',
  red: 'text-red-600 dark:text-red-400',
  gray: 'text-gray-400 dark:text-gray-500',
}

export function Badge({ tone = 'gray', children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 text-xs font-semibold leading-5 ${PILL[tone]}`}
    >
      {children}
    </span>
  )
}

// ─── item kinds ──────────────────────────────────────────────────────────────

export type ItemKind = 'topic' | 'question' | 'action' | 'decision'

export const KIND: Record<ItemKind, { label: string; tone: Tone; icon: IconName }> = {
  topic: { label: 'Topic', tone: 'purple', icon: 'topic' },
  question: { label: 'Question', tone: 'amber', icon: 'question' },
  action: { label: 'Action', tone: 'blue', icon: 'action' },
  decision: { label: 'Decision', tone: 'green', icon: 'decision' },
}

/** The kind as a coloured mark. The name is there for a screen reader, not the eye. */
export function KindIcon({ kind, className = 'w-5 h-5' }: { kind: ItemKind; className?: string }) {
  const { label, tone, icon } = KIND[kind]
  return (
    <span className={`inline-flex shrink-0 ${ICON[tone]}`}>
      <Icon name={icon} className={className} label={label} />
    </span>
  )
}

// ─── item status ─────────────────────────────────────────────────────────────

export type ItemStatus = 'open' | 'needs_answer' | 'done' | 'dropped' | 'decided' | 'superseded'

const STATUS: Record<ItemStatus, { label: string; tone: Tone }> = {
  open: { label: 'Open', tone: 'blue' },
  needs_answer: { label: 'Needs answer', tone: 'amber' },
  done: { label: 'Done', tone: 'green' },
  decided: { label: 'Decided', tone: 'green' },
  dropped: { label: 'Dropped', tone: 'gray' },
  superseded: { label: 'Superseded', tone: 'gray' },
}

export function StatusBadge({ status }: { status: ItemStatus }) {
  const { label, tone } = STATUS[status]
  return <Badge tone={tone}>{label}</Badge>
}
