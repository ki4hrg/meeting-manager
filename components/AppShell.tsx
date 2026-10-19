'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import ThemeToggle from '@/components/ThemeToggle'
import { Icon, type IconName } from '@/components/ui/icons'
import { Badge, type Tone } from '@/components/ui/StatusBadge'

export type NavSection = { href: string; label: string; count?: number; tone?: Tone }

const ICON_BUTTON =
  'flex h-9 w-9 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-700 ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ' +
  'dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200'

const MENU_ITEM =
  'flex w-full items-center px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700'

const ACCOUNT_LINKS: Array<{ href: string; label: string; icon: IconName }> = [
  { href: '/contexts', label: 'Contexts', icon: 'context' },
  { href: '/settings', label: 'Settings', icon: 'cog' },
]

/** A section's count, hidden at zero. */
function NavCount({ section }: { section: NavSection }) {
  if (!section.count) return null
  return <Badge tone={section.tone}>{section.count}</Badge>
}

function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false
  return pathname === href || pathname.startsWith(`${href}/`)
}

/**
 * The signed-in frame: top bar, then the page on a grey ground.
 *
 * `switcher` and `quickAdd` are slots, filled by the layout once contexts and
 * items exist, so the bar does not need to know about either.
 */
export function AppShell({
  sections,
  email,
  signOut,
  switcher,
  quickAdd,
  children,
}: {
  sections: NavSection[]
  email: string
  signOut: () => Promise<void>
  switcher?: React.ReactNode
  quickAdd?: React.ReactNode
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const [menuOpen, setMenuOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onMouseDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [])

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <nav className="bg-white shadow dark:bg-gray-800 dark:shadow-gray-900/40">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2 sm:gap-4">
              {sections.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setDrawerOpen((open) => !open)}
                  aria-label="Main menu"
                  aria-expanded={drawerOpen}
                  className={`${ICON_BUTTON} relative -ml-2 md:hidden`}
                >
                  <Icon name={drawerOpen ? 'close' : 'menu'} />
                  {drawerOpen
                    ? null
                    : sections
                        .filter((section) => section.count)
                        .slice(0, 1)
                        .map((section) => (
                          <span key={section.href} className="absolute -right-1.5 -top-1">
                            <NavCount section={section} />
                          </span>
                        ))}
                </button>
              ) : null}

              <Link
                href="/"
                className="shrink-0 whitespace-nowrap text-lg font-semibold text-gray-900 sm:text-xl dark:text-gray-100"
              >
                Meetings
              </Link>

              {switcher}

              <div className="hidden items-center gap-1 md:flex">
                {sections.map((section) => (
                  <Link
                    key={section.href}
                    href={section.href}
                    aria-current={isActive(pathname, section.href) ? 'page' : undefined}
                    className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                      isActive(pathname, section.href)
                        ? 'bg-gray-100 text-gray-900 dark:bg-gray-700 dark:text-gray-100'
                        : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-700/50 dark:hover:text-gray-100'
                    }`}
                  >
                    {section.label}
                    <NavCount section={section} />
                  </Link>
                ))}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1 sm:gap-2">
              {quickAdd}
              <ThemeToggle />

              <div className="relative" ref={menuRef}>
                <button
                  type="button"
                  onClick={() => setMenuOpen((open) => !open)}
                  aria-label="Account menu"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  className={ICON_BUTTON}
                >
                  <Icon name="person" />
                </button>

                {menuOpen ? (
                  <div
                    role="menu"
                    className="absolute right-0 z-50 mt-2 w-56 rounded-md border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-800"
                  >
                    <p className="truncate border-b border-gray-100 px-4 py-2 text-sm text-gray-900 dark:border-gray-700 dark:text-gray-100">
                      {email}
                    </p>
                    {ACCOUNT_LINKS.map((link) => (
                      <Link
                        key={link.href}
                        href={link.href}
                        role="menuitem"
                        onClick={() => setMenuOpen(false)}
                        className={MENU_ITEM}
                      >
                        <Icon name={link.icon} className="mr-3 h-4 w-4 shrink-0" />
                        {link.label}
                      </Link>
                    ))}
                    <form action={signOut}>
                      <button type="submit" role="menuitem" className={MENU_ITEM}>
                        <Icon name="signOut" className="mr-3 h-4 w-4 shrink-0" />
                        Sign out
                      </button>
                    </form>
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {drawerOpen ? (
            <div className="border-t border-gray-200 py-2 md:hidden dark:border-gray-700">
              {sections.map((section) => (
                <Link
                  key={section.href}
                  href={section.href}
                  onClick={() => setDrawerOpen(false)}
                  aria-current={isActive(pathname, section.href) ? 'page' : undefined}
                  className={`flex items-center justify-between rounded-md px-3 py-3 text-base font-medium ${
                    isActive(pathname, section.href)
                      ? 'bg-gray-100 text-gray-900 dark:bg-gray-700 dark:text-gray-100'
                      : 'text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700/50'
                  }`}
                >
                  {section.label}
                  <NavCount section={section} />
                </Link>
              ))}
            </div>
          ) : null}
        </div>
      </nav>

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">{children}</main>
    </div>
  )
}
