import { FormModal, IconAction } from '@/components/forms'
import { ActionSelect } from '@/components/ActionSelect'
import { ItemCard } from '@/components/items/ItemCard'
import { TaskPicker } from '@/components/todoist/TaskPicker'
import { buttonClasses } from '@/components/ui/Button'
import { Card, Section } from '@/components/ui/Card'
import { Icon } from '@/components/ui/icons'
import { Badge } from '@/components/ui/StatusBadge'
import type { Connection } from '@/lib/connect/connections'
import { listProjects, type TodoistProject } from '@/lib/connect/todoist/client'
import {
  listTodoistBindings,
  todoistConfigured,
  todoistConnection,
  withTodoist,
} from '@/lib/connect/todoist/connection'
import { openTasks, rankTasks, unmatchedItemIds } from '@/lib/connect/todoist/match'
import { db } from '@/lib/db'
import { getItem } from '@/lib/items/items'
import { openHref } from '@/lib/web/open'
import { allContexts, currentContext, viewer } from '@/lib/web/context'
import {
  disconnectTodoistAction,
  linkTodoistAction,
  sendTodoistAction,
  setTodoistProjectAction,
  skipTodoistAction,
} from './actions'
import { PlaceOptions, placeOf, placesFor } from './places'

/* How many tasks each Link offers to search: the likeliest, then the rest. */
const CHOICES = 60

type Row = { project: TodoistProject; depth: number }

/* Projects as Todoist shows them: the Inbox, then each tree in order. */
function projectRows(projects: TodoistProject[]): Row[] {
  const ids = new Set(projects.map((project) => project.id))
  const order = (a: TodoistProject, b: TodoistProject) =>
    Number(!!b.inbox_project) - Number(!!a.inbox_project) || (a.child_order ?? 0) - (b.child_order ?? 0)
  const rows: Row[] = []
  const walk = (parentId: string | null, depth: number) => {
    for (const project of projects
      .filter((one) => (parentId === null ? !one.parent_id || !ids.has(one.parent_id) : one.parent_id === parentId))
      .sort(order)) {
      if (depth > 10 || rows.some((row) => row.project.id === project.id)) continue
      rows.push({ project, depth })
      walk(project.id, depth + 1)
    }
  }
  walk(null, 0)
  return rows
}

async function Account({ connection }: { connection: Connection }) {
  /* Asked of Todoist on every load, so it can fail; the page must not. Bound
     projects are still listed, from what was stored. */
  let projects: TodoistProject[] = []
  let error: string | null = null
  try {
    projects = await withTodoist(db, connection.id, listProjects)
  } catch (err) {
    error = err instanceof Error ? err.message : 'Todoist could not be reached.'
  }
  const bindings = await listTodoistBindings(db, connection.id)
  const listed = new Set(projects.map((project) => project.id))
  for (const binding of bindings) {
    if (!listed.has(binding.externalId)) {
      projects.push({ id: binding.externalId, name: binding.name, parent_id: null })
    }
  }
  const places = await placesFor(await allContexts(), bindings, { projectsOnly: true })
  const boundTo = new Map(bindings.map((binding) => [binding.externalId, placeOf(binding)]))

  return (
    <Card>
      <div className="flex items-center gap-3">
        <Icon name="person" className="h-5 w-5 shrink-0 text-gray-400 dark:text-gray-500" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
          {connection.account}
        </span>
        {error || connection.lastError ? (
          <Badge tone="red">
            <Icon name="alert" className="h-3 w-3" label="Error" />
          </Badge>
        ) : null}
        <FormModal
          action={disconnectTodoistAction}
          title={`Disconnect ${connection.account}?`}
          icon="trash"
          compact
          submit="Disconnect"
          danger
        >
          <input type="hidden" name="connectionId" value={connection.id} />
        </FormModal>
      </div>

      {error || connection.lastError ? (
        <p role="alert" className="error-message mt-3">
          {error ?? connection.lastError}
        </p>
      ) : null}

      {projects.length > 0 ? (
        <ul className="mt-3 divide-y divide-gray-100 border-t border-gray-100 dark:divide-gray-700 dark:border-gray-700">
          {projectRows(projects).map(({ project, depth }) => {
            const place = boundTo.get(project.id) ?? ''
            return (
              <li key={project.id} className="flex items-center gap-3 py-2 last:pb-0">
                <span
                  className="flex min-w-0 flex-1 items-center gap-3"
                  style={{ paddingLeft: `${Math.min(depth, 4) * 1.25}rem` }}
                >
                  <Icon
                    name={project.inbox_project ? 'inbox' : 'project'}
                    className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500"
                  />
                  <span className="truncate text-sm text-gray-900 dark:text-gray-100">{project.name}</span>
                </span>
                <ActionSelect
                  key={place}
                  action={setTodoistProjectAction}
                  fields={{ connectionId: connection.id, todoistProjectId: project.id, name: project.name }}
                  name="place"
                  value={place}
                  label={`Context for ${project.name}`}
                  className="!w-40 shrink-0 !py-1.5 sm:!w-56"
                >
                  <option value="">—</option>
                  <PlaceOptions groups={places} />
                </ActionSelect>
              </li>
            )
          })}
        </ul>
      ) : null}
    </Card>
  )
}

/* Items open when Todoist was connected: each linked to a task John has, sent
   as a new one, or kept out. */
async function Match() {
  const ids = await unmatchedItemIds(db)
  const { today } = await viewer()
  const selected = (await currentContext())?.id ?? ''
  const contexts = new Map((await allContexts()).map((context) => [context.id, context.name]))
  const items = await Promise.all(ids.map((id) => getItem(db, id)))
  const tasks = items.length > 0 ? await openTasks(db) : []

  return (
    <Section title="Match" count={items.length}>
      <div className="flex flex-col gap-3">
        {items.map((item) => (
          <div key={item.id} className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <ItemCard
                item={item}
                today={today}
                href={openHref(`/items/${item.id}`, item.contextId, selected)}
                context={contexts.size > 1 ? contexts.get(item.contextId) : undefined}
              />
            </div>
            <span className="pt-2">
              <MatchActions itemId={item.id} choices={rankTasks(item.text, tasks).slice(0, CHOICES)} />
            </span>
          </div>
        ))}
      </div>
    </Section>
  )
}

/**
 * What becomes of an item with no Todoist task: link it to one John has, send
 * it as a new one, or keep it out. On a Match card and on an item page with no
 * task, grouped under Todoist's name so the three read as its.
 */
export function MatchActions({
  itemId,
  choices,
  skip = true,
}: {
  itemId: string
  choices: { id: string; content: string; deadline: string | null }[]
  skip?: boolean
}) {
  return (
    <span
      role="group"
      aria-label="Todoist"
      className="flex shrink-0 items-center gap-0.5 rounded-lg border border-gray-200 py-0.5 pl-2 pr-0.5 dark:border-gray-700"
    >
      <span aria-hidden className="pr-1 text-xs font-medium text-gray-500 dark:text-gray-400">
        Todoist
      </span>
      {choices.length > 0 ? (
        <FormModal
          action={linkTodoistAction}
          title="Link to a Todoist task"
          icon="link"
          compact
          tone="blue"
          submit="Link"
        >
          <input type="hidden" name="itemId" value={itemId} />
          <TaskPicker name="task" options={choices} />
        </FormModal>
      ) : null}
      <IconAction action={sendTodoistAction} fields={{ itemId }} icon="plus" label="New Todoist task" />
      {skip ? (
        <IconAction action={skipTodoistAction} fields={{ itemId }} icon="close" label="Don't send to Todoist" />
      ) : null}
    </span>
  )
}

export async function Todoist() {
  const connection = await todoistConnection(db)
  if (!connection && !todoistConfigured()) {
    return (
      <Section title="Todoist">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          TODOIST_CLIENT_ID and TODOIST_CLIENT_SECRET are not set.
        </p>
      </Section>
    )
  }

  return (
    <>
      <Section
        title="Todoist"
        empty={!connection}
        action={
          connection ? undefined : (
            /* A plain link, not next/link: a route that redirects off the site
               and sets a cookie must not be prefetched. */
            <a href="/api/connect/todoist/start" className={buttonClasses('secondary', 'sm')}>
              <Icon name="plus" className="h-4 w-4" />
              Connect
            </a>
          )
        }
      >
        {connection ? <Account connection={connection} /> : null}
      </Section>
      {connection ? <Match /> : null}
    </>
  )
}
