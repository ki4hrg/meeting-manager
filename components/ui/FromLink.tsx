'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { withFrom } from '@/lib/web/from'

/**
 * A link that tells the page it opens where it was followed from, so that
 * page's breadcrumbs lead back here (`lib/web/from.ts`). `plain` is a plain
 * link, for a route that does something on the way (never prefetched).
 */
export function FromLink({
  href,
  plain = false,
  className,
  children,
}: {
  href: string
  plain?: boolean
  className?: string
  children: React.ReactNode
}) {
  const to = withFrom(href, usePathname())
  if (plain) {
    return (
      <a href={to} className={className}>
        {children}
      </a>
    )
  }
  return (
    <Link href={to} className={className}>
      {children}
    </Link>
  )
}
