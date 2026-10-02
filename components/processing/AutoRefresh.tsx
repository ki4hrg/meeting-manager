'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Asks the server for the page again while something on it is still under
 * way. Rendered only while a run is queued or running, so it stops by no
 * longer being there. It starts quick, because a run with no model is over in
 * a moment, and slows down so a stuck run is not polled hard for ever.
 */
export function AutoRefresh() {
  const router = useRouter()

  useEffect(() => {
    let ticks = 0
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      ticks += 1
      if (!document.hidden) router.refresh()
      timer = setTimeout(tick, ticks < 10 ? 2000 : 10_000)
    }
    timer = setTimeout(tick, 1000)
    return () => clearTimeout(timer)
  }, [router])

  return null
}
