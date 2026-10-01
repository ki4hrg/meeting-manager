import { AppShell, type NavSection } from '@/components/AppShell'
import { requireUser } from '@/lib/auth/guards'
import { logoutAction } from '../(auth)/actions'

export const dynamic = 'force-dynamic'

/* Sections are added here as each one is built, so the bar never links to a
   page that does not exist. */
const SECTIONS: NavSection[] = []

/* Everything under app/(app)/ is authenticated by sitting under this layout. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser()

  return (
    <AppShell sections={SECTIONS} email={user.email} signOut={logoutAction}>
      {children}
    </AppShell>
  )
}
