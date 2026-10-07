'use client'

import Link from 'next/link'
import { useMemo, useState, useSyncExternalStore } from 'react'
import { Card, CardGrid } from '@/components/ui/Card'
import { IconButton } from '@/components/ui/IconButton'
import { Icon } from '@/components/ui/icons'
import { DueBadge, ProjectStatusBadge, type ProjectStatus } from '@/components/ui/StatusBadge'

export type ProjectTreeNode = {
  id: string
  name: string
  status: ProjectStatus
  /** Archived, and here only because a live sub-project sits within it. */
  archived: boolean
  open: number
  /** Open across it and everything below it. */
  subtree: number
  next: { title: string; label: string; dueOn: string } | null
  children: ProjectTreeNode[]
}

const STORAGE_KEY = 'mm-projects-collapsed'
const CHANGE_EVENT = 'mm-projects-collapsed'

function subscribe(onChange: () => void): () => void {
  window.addEventListener('storage', onChange)
  window.addEventListener(CHANGE_EVENT, onChange)
  return () => {
    window.removeEventListener('storage', onChange)
    window.removeEventListener(CHANGE_EVENT, onChange)
  }
}

function readStored(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? '[]'
  } catch {
    return '[]'
  }
}

function parse(raw: string): Set<string> {
  try {
    const ids: unknown = JSON.parse(raw)
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeStored(ids: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]))
    window.dispatchEvent(new Event(CHANGE_EVENT))
  } catch {
    // Not remembered; the page still works.
  }
}

/**
 * The project tree: one card per top-level project, its sub-projects nested
 * inside as rows, indented with a guide line per level. Every parent starts
 * open; `remember` keeps what this viewer collapsed.
 */
export function ProjectTree({
  roots,
  today,
  remember = false,
}: {
  roots: ProjectTreeNode[]
  today: string
  remember?: boolean
}) {
  const stored = useSyncExternalStore(subscribe, readStored, () => '[]')
  const remembered = useMemo(() => parse(stored), [stored])
  const [local, setLocal] = useState<Set<string>>(() => new Set())
  const collapsed = remember ? remembered : local

  const toggle = (id: string) => {
    const after = new Set(collapsed)
    if (!after.delete(id)) after.add(id)
    if (remember) writeStored(after)
    else setLocal(after)
  }

  return (
    <CardGrid>
      {roots.map((root) => (
        <ProjectBlock key={root.id} root={root} today={today} collapsed={collapsed} toggle={toggle} />
      ))}
    </CardGrid>
  )
}

type Folding = { collapsed: Set<string>; toggle: (id: string) => void }

function Chevron({ node, collapsed, toggle }: { node: ProjectTreeNode } & Folding) {
  const closed = collapsed.has(node.id)
  return (
    <IconButton
      icon={closed ? 'chevronDown' : 'chevronUp'}
      label={closed ? 'Expand' : 'Collapse'}
      aria-expanded={!closed}
      onClick={() => toggle(node.id)}
    />
  )
}

function OpenCount({ node }: { node: ProjectTreeNode }) {
  return (
    <span className="flex shrink-0 items-center gap-1 tabular-nums">
      <Icon name="action" className="h-3.5 w-3.5" label="Open" />
      {node.open}
      {node.subtree > node.open ? (
        <span className="text-gray-400 dark:text-gray-500" title="With sub-projects">
          · {node.subtree}
        </span>
      ) : null}
    </span>
  )
}

function Marker({ node }: { node: ProjectTreeNode }) {
  return node.archived ? (
    <Icon name="archive" className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" label="Archived" />
  ) : (
    <ProjectStatusBadge status={node.status} />
  )
}

function ProjectBlock({ root, today, ...folding }: { root: ProjectTreeNode; today: string } & Folding) {
  const open = root.children.length > 0 && !folding.collapsed.has(root.id)
  return (
    <Card className="self-start">
      <div className="flex items-start gap-1">
        <Link
          href={`/projects/${root.id}`}
          className={`-m-1 block min-w-0 flex-1 rounded-md p-1 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-gray-700/50 ${root.archived ? 'opacity-60' : ''}`}
        >
          <div className="mb-2 flex items-start justify-between gap-3">
            <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
              {root.name}
            </h3>
            <Marker node={root} />
          </div>
          <div className="flex items-center justify-between gap-3 text-xs text-gray-500 dark:text-gray-400">
            {root.archived ? <span /> : <OpenCount node={root} />}
            {root.next && !root.archived ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <Icon name="flag" className="h-3.5 w-3.5 shrink-0" label="Next milestone" />
                <span className="truncate">{root.next.title}</span>
                <DueBadge label={root.next.label} dueOn={root.next.dueOn} today={today} />
              </span>
            ) : null}
          </div>
        </Link>
        {root.children.length > 0 ? <Chevron node={root} {...folding} /> : null}
      </div>
      {open ? (
        <div className="mt-3 border-t border-gray-100 pt-2 dark:border-gray-700">
          <Rows nodes={root.children} today={today} {...folding} />
        </div>
      ) : null}
    </Card>
  )
}

function Rows({ nodes, today, ...folding }: { nodes: ProjectTreeNode[]; today: string } & Folding) {
  return (
    <ul className="ml-1 border-l border-gray-200 pl-2 dark:border-gray-700">
      {nodes.map((node) => (
        <li key={node.id}>
          <div className="flex items-center gap-1">
            <Link
              href={`/projects/${node.id}`}
              className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-xs text-gray-500 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 dark:hover:bg-gray-700/50 ${node.archived ? 'opacity-60' : ''}`}
            >
              <span className="min-w-0 flex-1 truncate text-sm text-gray-900 dark:text-gray-100">{node.name}</span>
              {node.next && !node.archived ? (
                <span className="flex shrink-0 items-center gap-1" title={node.next.title}>
                  <Icon name="flag" className="hidden h-3.5 w-3.5 sm:block" label="Next milestone" />
                  <DueBadge label={node.next.label} dueOn={node.next.dueOn} today={today} />
                </span>
              ) : null}
              {node.archived ? null : <OpenCount node={node} />}
              <Marker node={node} />
            </Link>
            {node.children.length > 0 ? <Chevron node={node} {...folding} /> : <span className="w-7 shrink-0" />}
          </div>
          {node.children.length > 0 && !folding.collapsed.has(node.id) ? (
            <div className="ml-1">
              <Rows nodes={node.children} today={today} {...folding} />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
