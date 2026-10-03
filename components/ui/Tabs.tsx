import Link from 'next/link'

/** Two or three views of one list, as links: the current one is filled. */
export function Tabs({ tabs }: { tabs: Array<{ href: string; label: string; active: boolean }> }) {
  return (
    <nav className="mb-6 inline-flex rounded-lg bg-gray-100 p-1 dark:bg-gray-800">
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={tab.active ? 'page' : undefined}
          className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
            tab.active
              ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-gray-100'
              : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  )
}
