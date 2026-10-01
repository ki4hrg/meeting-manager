'use client'

import { createContext, useContext } from 'react'

/* The names quick-add completes against: everyone, and the groups and projects
   of the selected context. Provided once by the layout so a quick-add button
   can sit anywhere. */
export type Directory = {
  people: Array<{ name: string }>
  groups: Array<{ name: string }>
  projects: Array<{ name: string }>
}

const EMPTY: Directory = { people: [], groups: [], projects: [] }

const DirectoryContext = createContext<Directory>(EMPTY)

export function DirectoryProvider({
  value,
  children,
}: {
  value: Directory
  children: React.ReactNode
}) {
  return <DirectoryContext.Provider value={value}>{children}</DirectoryContext.Provider>
}

export function useDirectory(): Directory {
  return useContext(DirectoryContext)
}
