'use client'

import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from 'react'

export type Theme = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'theme'
const CHANGE_EVENT = 'mm-theme-change'
const DARK_QUERY = '(prefers-color-scheme: dark)'

interface ThemeContextValue {
  /** The preference: "system", "light", or "dark". */
  theme: Theme
  /** The theme actually applied. */
  resolvedTheme: ResolvedTheme
  setTheme: (theme: Theme) => void
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)

/* The preference lives in localStorage and the OS setting in a media query.
   Both are external stores, read through useSyncExternalStore so the server
   render and the first client render agree and then settle on the real value. */

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia(DARK_QUERY)
  media.addEventListener('change', onChange)
  window.addEventListener('storage', onChange)
  window.addEventListener(CHANGE_EVENT, onChange)
  return () => {
    media.removeEventListener('change', onChange)
    window.removeEventListener('storage', onChange)
    window.removeEventListener(CHANGE_EVENT, onChange)
  }
}

function readTheme(): Theme {
  try {
    return (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? 'system'
  } catch {
    return 'system'
  }
}

function readSystem(): ResolvedTheme {
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useSyncExternalStore<Theme>(subscribe, readTheme, () => 'system')
  const system = useSyncExternalStore<ResolvedTheme>(subscribe, readSystem, () => 'light')
  const resolvedTheme = theme === 'system' ? system : theme

  // The inline script in <head> applied this before paint; this keeps it in step.
  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', resolvedTheme === 'dark')
    root.style.colorScheme = resolvedTheme
  }, [resolvedTheme])

  const setTheme = useCallback((next: Theme) => {
    localStorage.setItem(STORAGE_KEY, next)
    window.dispatchEvent(new Event(CHANGE_EVENT))
  }, [])

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider')
  return ctx
}

/** Inline script for <head>: sets the theme class before first paint. */
export const themeInitScript = `(function(){try{var t=localStorage.getItem('${STORAGE_KEY}')||'system';var d=t==='dark'||(t==='system'&&window.matchMedia('${DARK_QUERY}').matches);var e=document.documentElement;e.classList.toggle('dark',d);e.style.colorScheme=d?'dark':'light';}catch(e){}})();`
