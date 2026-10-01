'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useToast } from '@/components/Toast'

/**
 * What a redirect back to this page had to say, shown once as a toast. The
 * query is then dropped, so a reload does not say it again.
 */
export function Notice({ error, success }: { error?: string; success?: string }) {
  const toast = useToast()
  const router = useRouter()
  const shown = useRef(false)

  useEffect(() => {
    if (shown.current || (!error && !success)) return
    shown.current = true
    if (error) toast.error(error)
    else if (success) toast.success(success)
    router.replace('/settings', { scroll: false })
  }, [error, success, toast, router])

  return null
}
