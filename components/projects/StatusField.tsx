'use client'

import { useState } from 'react'
import { Field, Select } from '@/components/ui/Field'
import { PROJECT_STATUS, type ProjectStatus } from '@/components/ui/StatusBadge'

const STATUSES: ProjectStatus[] = ['active', 'pending', 'proposed', 'paused', 'done']

const ALSO: Record<ProjectStatus, (n: number) => string> = {
  active: (n) => `Also make ${n === 1 ? 'its sub-project' : `${n} sub-projects`} active`,
  pending: (n) => `Also make ${n === 1 ? 'its sub-project' : `${n} sub-projects`} pending`,
  proposed: (n) => `Also make ${n === 1 ? 'its sub-project' : `${n} sub-projects`} proposed`,
  paused: (n) => `Also pause ${n === 1 ? 'its sub-project' : `${n} sub-projects`}`,
  done: (n) => `Also mark ${n === 1 ? 'its sub-project' : `${n} sub-projects`} done`,
}

/**
 * A project's status in its Edit form. Changing it on a project with
 * sub-projects offers to change theirs too; nothing happens to them unless
 * that is ticked.
 */
export function StatusField({ current, below }: { current: ProjectStatus; below: number }) {
  const [status, setStatus] = useState(current)
  return (
    <>
      <Field label="Status">
        <Select name="status" value={status} onChange={(event) => setStatus(event.target.value as ProjectStatus)}>
          {STATUSES.map((one) => (
            <option key={one} value={one}>
              {PROJECT_STATUS[one].label}
            </option>
          ))}
        </Select>
      </Field>
      {below > 0 && status !== current ? (
        <label className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            name="subProjects"
            className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
          />
          {ALSO[status](below)}
        </label>
      ) : null}
    </>
  )
}
