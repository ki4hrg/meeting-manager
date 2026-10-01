'use client'

import { ThemeProvider } from '@/components/theme-provider'
import { ToastProvider } from '@/components/Toast'

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <ToastProvider>{children}</ToastProvider>
    </ThemeProvider>
  )
}
