'use client'

import { useEffect } from 'react'

/* Registers public/sw.js in a production build. In development it would serve
   stale offline pages over hot reloads, so it stays off. */
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Not installable then, and nothing else changes.
    })
  }, [])
  return null
}
