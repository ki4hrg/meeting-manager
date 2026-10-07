import { ActionSelect } from '@/components/ActionSelect'
import { FormModal } from '@/components/forms'
import { Card, Section } from '@/components/ui/Card'
import { Field, Input } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import { Badge } from '@/components/ui/StatusBadge'
import type { Binding } from '@/lib/connect/connections'
import { listFolders, type GranolaFolder } from '@/lib/connect/granola/client'
import {
  listFolderBindings,
  listGranolaAccounts,
  withGranola,
  type GranolaAccount,
} from '@/lib/connect/granola/connection'
import { db } from '@/lib/db'
import { allContexts } from '@/lib/web/context'
import { connectGranolaAction, disconnectGranolaAction, setFolderContextAction } from './actions'
import { PlaceOptions, placeLabel, placeOf, placesFor, type PlaceGroup } from './places'

type Row = { id: string; name: string; depth: number; inherited: string | null }

/* Folders as a tree, parents before their children, each child knowing the
   place it takes from the nearest bound folder above it. */
function folderRows(
  folders: GranolaFolder[],
  boundTo: Map<string, string>,
  placeName: (value: string) => string | null,
): Row[] {
  const ids = new Set(folders.map((folder) => folder.id))
  const byName = (a: GranolaFolder, b: GranolaFolder) => a.name.localeCompare(b.name)
  const rows: Row[] = []

  const walk = (parentId: string | null, depth: number, inherited: string | null) => {
    const children = folders
      .filter((folder) =>
        parentId === null
          ? !folder.parent_folder_id || !ids.has(folder.parent_folder_id)
          : folder.parent_folder_id === parentId,
      )
      .sort(byName)
    for (const folder of children) {
      // Deep enough for anything real; stops a cycle in what Granola sends.
      if (depth > 10 || rows.some((row) => row.id === folder.id)) continue
      rows.push({ id: folder.id, name: folder.name, depth, inherited })
      const own = boundTo.get(folder.id)
      walk(folder.id, depth + 1, own ? placeName(own) : inherited)
    }
  }
  walk(null, 0, null)
  return rows
}

/* One account: who it is, whether notes arrive as they are made, and which
   context, project, series or group each of its folders feeds. */
async function Account({
  account,
  bindings,
  places,
}: {
  account: GranolaAccount
  bindings: Binding[]
  places: PlaceGroup[]
}) {
  /* Asked of Granola on every load, so it can fail; the page must not. The
     folders already bound are still listed, from what was stored. */
  let folders: GranolaFolder[] = []
  let error: string | null = null
  try {
    folders = await withGranola(db, account.id, listFolders)
  } catch (err) {
    error = err instanceof Error ? err.message : 'Granola could not be reached.'
  }
  /* A bound folder Granola did not list stays on the page, or its binding
     could never be removed. */
  const listed = new Set(folders.map((folder) => folder.id))
  for (const binding of bindings) {
    if (!listed.has(binding.externalId)) {
      folders.push({ id: binding.externalId, name: binding.name, parent_folder_id: null })
    }
  }

  const boundTo = new Map(bindings.map((binding) => [binding.externalId, placeOf(binding)]))
  const rows = folderRows(
    folders,
    boundTo,
    (value) => placeLabel(places, value),
  )

  return (
    <Card>
      <div className="flex items-center gap-3">
        <Icon name="person" className="h-5 w-5 shrink-0 text-gray-400 dark:text-gray-500" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
          {account.account}
        </span>
        {error ? (
          <Badge tone="red">
            <Icon name="alert" className="h-3 w-3" label="Error" />
          </Badge>
        ) : (
          <Badge tone={account.webhook ? 'green' : 'amber'}>
            {account.webhook ? 'Live' : 'Every 15 min'}
          </Badge>
        )}
        <FormModal
          action={disconnectGranolaAction}
          title={`Disconnect ${account.account}?`}
          icon="trash"
          compact
          submit="Disconnect"
          danger
        >
          <input type="hidden" name="connectionId" value={account.id} />
        </FormModal>
      </div>

      {error ? (
        <p role="alert" className="error-message mt-3">
          {error}
        </p>
      ) : null}

      {rows.length > 0 ? (
        <ul className="mt-3 divide-y divide-gray-100 border-t border-gray-100 dark:divide-gray-700 dark:border-gray-700">
          {rows.map((folder) => {
            const place = boundTo.get(folder.id) ?? ''
            return (
              <li key={folder.id} className="flex items-center gap-3 py-2 last:pb-0">
                <span
                  className="flex min-w-0 flex-1 items-center gap-3"
                  style={{ paddingLeft: `${Math.min(folder.depth, 4) * 1.25}rem` }}
                >
                  <Icon
                    name="project"
                    className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500"
                  />
                  <span className="truncate text-sm text-gray-900 dark:text-gray-100">
                    {folder.name}
                  </span>
                </span>
                <ActionSelect
                  key={place}
                  action={setFolderContextAction}
                  fields={{ connectionId: account.id, folderId: folder.id, name: folder.name }}
                  name="contextId"
                  value={place}
                  label={`Context for ${folder.name}`}
                  className="!w-40 shrink-0 !py-1.5 sm:!w-56"
                >
                  {/* Unbound, a folder follows the one above it. */}
                  <option value="">{folder.inherited ? `↳ ${folder.inherited}` : '—'}</option>
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

export async function Granola() {
  const [accounts, bindings, contexts] = await Promise.all([
    listGranolaAccounts(db),
    listFolderBindings(db),
    allContexts(),
  ])
  const places = await placesFor(contexts, bindings)

  return (
    <Section
      title="Granola"
      empty={accounts.length === 0}
      action={
        <FormModal
          action={connectGranolaAction}
          title="Connect Granola"
          label="Connect"
          icon="plus"
          variant="secondary"
          size="sm"
          submit="Connect"
        >
          <Field label="API key" required>
            <Input name="apiKey" type="password" required autoFocus />
          </Field>
        </FormModal>
      }
    >
      <div className="flex flex-col gap-3">
        {accounts.map((account) => (
          <Account
            key={account.id}
            account={account}
            bindings={bindings.filter((binding) => binding.connectionId === account.id)}
            places={places}
          />
        ))}
      </div>
    </Section>
  )
}
