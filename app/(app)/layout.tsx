import { AppShell, type NavSection } from '@/components/AppShell'
import { ContextSwitcher } from '@/components/ContextSwitcher'
import { DirectoryProvider, type Directory } from '@/components/Directory'
import { QuickAdd } from '@/components/QuickAdd'
import { countUnfiledNotes } from '@/lib/connect/granola/unfiled'
import { pendingByMeeting } from '@/lib/processing/proposals'
import { db } from '@/lib/db'
import { listGroups } from '@/lib/directory/groups'
import { inboxCount } from '@/lib/items/items'
import { listPeople } from '@/lib/directory/people'
import { listSeries } from '@/lib/meetings/series'
import { listProjects } from '@/lib/projects/projects'
import { allContexts, currentContext, viewer } from '@/lib/web/context'
import { logoutAction } from '../(auth)/actions'

export const dynamic = 'force-dynamic'

const SECTIONS: NavSection[] = [
  { href: '/meetings', label: 'Meetings' },
  { href: '/inbox', label: 'Inbox', tone: 'blue' },
  { href: '/projects', label: 'Projects' },
  { href: '/people', label: 'People' },
  { href: '/groups', label: 'Groups' },
  { href: '/series', label: 'Series' },
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
        series: (await listSeries(db, context.id)).map(({ name }) => ({ name })),
      }
    : { people: [], groups: [], projects: [], series: [] }

  // The Inbox's count: open items with nowhere to go, unfiled notes, and meetings to review.
  const waiting = context
    ? (await inboxCount(db, context.id)) +
      (await countUnfiledNotes(db)) +
      (await pendingByMeeting(db, context.id)).size
    : 0
  const sections = SECTIONS.map((section) =>
    section.href === '/inbox' ? { ...section, count: waiting } : section,
  )

  return (
    <DirectoryProvider value={directory}>
      <AppShell
        // Every section lists what is in a context, so there are none without one.
        sections={context ? sections : []}
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
