import { AppShell, type NavSection } from '@/components/AppShell'
import { ContextSwitcher } from '@/components/ContextSwitcher'
import { DirectoryProvider, type Directory } from '@/components/Directory'
import { QuickAdd } from '@/components/QuickAdd'
import { db } from '@/lib/db'
import { listGroups } from '@/lib/directory/groups'
import { listPeople } from '@/lib/directory/people'
import { listProjects } from '@/lib/projects/projects'
import { allContexts, currentContext, viewer } from '@/lib/web/context'
import { logoutAction } from '../(auth)/actions'

export const dynamic = 'force-dynamic'

const SECTIONS: NavSection[] = [
  { href: '/inbox', label: 'Inbox' },
  { href: '/projects', label: 'Projects' },
  { href: '/people', label: 'People' },
  { href: '/groups', label: 'Groups' },
]

/* Everything under app/(app)/ is authenticated by sitting under this layout. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user } = await viewer()
  const contexts = await allContexts()
  const context = await currentContext()

  // What quick-add completes against. Names only: ids never reach the client.
  const directory: Directory = context
    ? {
        people: [{ name: 'me' }, ...(await listPeople(db)).map(({ name }) => ({ name }))],
        groups: (await listGroups(db, context.id)).map(({ name }) => ({ name })),
        projects: (await listProjects(db, context.id)).map(({ name }) => ({ name })),
      }
    : { people: [], groups: [], projects: [] }

  return (
    <DirectoryProvider value={directory}>
      <AppShell
        // Every section lists what is in a context, so there are none without one.
        sections={context ? SECTIONS : []}
        email={user.email}
        signOut={logoutAction}
        switcher={
          context ? (
            <ContextSwitcher
              contexts={contexts.map(({ id, name }) => ({ id, name }))}
              current={context.id}
            />
          ) : null
        }
        quickAdd={context ? <QuickAdd variant="bar" /> : null}
      >
        {children}
      </AppShell>
    </DirectoryProvider>
  )
}
