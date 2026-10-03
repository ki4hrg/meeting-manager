import { ActionSelect } from '@/components/ActionSelect'
import { FormModal } from '@/components/forms'
import { buttonClasses } from '@/components/ui/Button'
import { Card, Section } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Icon } from '@/components/ui/icons'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/StatusBadge'
import {
  googleConfigured,
  listBindings,
  listCalendars,
  listConnections,
  type Binding,
  type CalendarInfo,
  type Connection,
} from '@/lib/connect/connections'
import { db } from '@/lib/db'
import type { Context } from '@/lib/directory/contexts'
import { allContexts, viewer } from '@/lib/web/context'
import { disconnectAction, setCalendarContextAction } from './actions'
import { Deleted } from './Deleted'
import { Granola } from './Granola'
import { Notice } from './Notice'

/* One account: who it is, whether Google still honours it, and which context
   each of its calendars feeds. */
async function GoogleAccount({
  connection,
  bindings,
  contexts,
}: {
  connection: Connection
  bindings: Binding[]
  contexts: Context[]
}) {
  /* Asked of Google on every load, so it can fail; the page must not. The
     calendars already bound are still listed, from what was stored. */
  let calendars: CalendarInfo[] = []
  let error: string | null = null
  try {
    calendars = await listCalendars(db, connection.id)
  } catch (err) {
    error = err instanceof Error ? err.message : 'Google could not be reached.'
  }
  /* A bound calendar Google did not list (it failed, or the calendar is gone)
     stays on the page, or its binding could never be removed. */
  const listed = new Set(calendars.map((calendar) => calendar.id))
  for (const binding of bindings) {
    if (!listed.has(binding.externalId)) {
      calendars.push({ id: binding.externalId, name: binding.name, primary: false })
    }
  }
  const boundTo = new Map(bindings.map((binding) => [binding.externalId, binding.contextId]))

  return (
    <Card>
      <div className="flex items-center gap-3">
        <Icon name="person" className="h-5 w-5 shrink-0 text-gray-400 dark:text-gray-500" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
          {connection.account}
        </span>
        {error ? (
          <Badge tone="red">
            <Icon name="alert" className="h-3 w-3" label="Error" />
          </Badge>
        ) : null}
        <FormModal
          action={disconnectAction}
          title={`Disconnect ${connection.account}?`}
          icon="trash"
          variant="ghost"
          size="sm"
          submit="Disconnect"
          danger
        >
          <input type="hidden" name="connectionId" value={connection.id} />
        </FormModal>
      </div>

      {error ? (
        <p role="alert" className="error-message mt-3">
          {error}
        </p>
      ) : null}

      {calendars.length > 0 ? (
        <ul className="mt-3 divide-y divide-gray-100 border-t border-gray-100 dark:divide-gray-700 dark:border-gray-700">
          {calendars.map((calendar) => {
            const contextId = boundTo.get(calendar.id) ?? ''
            return (
              <li key={calendar.id} className="flex items-center gap-3 py-2 last:pb-0">
                <Icon name="meeting" className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" />
                <span className="flex min-w-0 flex-1 items-center gap-2 text-sm text-gray-900 dark:text-gray-100">
                  <span className="truncate">{calendar.name}</span>
                  {calendar.primary ? <Badge tone="blue">Primary</Badge> : null}
                </span>
                <ActionSelect
                  key={contextId}
                  action={setCalendarContextAction}
                  fields={{
                    connectionId: connection.id,
                    calendarId: calendar.id,
                    name: calendar.name,
                  }}
                  name="contextId"
                  value={contextId}
                  label={`Context for ${calendar.name}`}
                  className="!w-36 shrink-0 !py-1.5 sm:!w-44"
                >
                  <option value="">—</option>
                  {contexts.map((context) => (
                    <option key={context.id} value={context.id}>
                      {context.name}
                    </option>
                  ))}
                </ActionSelect>
              </li>
            )
          })}
        </ul>
      ) : null}
    </Card>
  )
}

async function GoogleCalendar() {
  if (!googleConfigured()) {
    return (
      <Section title="Google Calendar">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set.
        </p>
      </Section>
    )
  }

  const connections = (await listConnections(db)).filter(
    (connection) => connection.provider === 'google',
  )
  const contexts = await allContexts()
  const bindings = await listBindings(db)

  return (
    <Section
      title="Google Calendar"
      action={
        /* A plain link, not next/link: this is a route that redirects off the
           site and sets a cookie, and must not be prefetched. */
        <a href="/api/connect/google/start" className={buttonClasses('primary', 'sm')}>
          Connect
        </a>
      }
    >
      {connections.length === 0 ? (
        <EmptyState icon="meeting" />
      ) : (
        <div className="flex flex-col gap-3">
          {connections.map((connection) => (
            <GoogleAccount
              key={connection.id}
              connection={connection}
              bindings={bindings.filter((binding) => binding.connectionId === connection.id)}
              contexts={contexts}
            />
          ))}
        </div>
      )}
    </Section>
  )
}

/* One section per integration; the next ones slot in below. */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[]; connected?: string | string[] }>
}) {
  const { error, connected } = await searchParams
  const { user } = await viewer()
  const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)

  return (
    <>
      <PageHeader title="Settings" crumbs={[{ href: '/', label: 'Home' }]} />
      <Notice
        error={one(error)}
        success={one(connected) === 'google' ? 'Google Calendar connected' : undefined}
      />
      <GoogleCalendar />
      <Granola />
      <Deleted timeZone={user.timeZone} />
    </>
  )
}
