'use client'

import { useFormStatus } from 'react-dom'
import { Button, type ButtonProps } from './Button'
import { Icon } from './icons'

const CONTROL =
  'mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm ' +
  'focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 sm:text-sm ' +
  'dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100'

export function Label({
  children,
  required,
  htmlFor,
}: {
  children: React.ReactNode
  required?: boolean
  htmlFor?: string
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="block text-sm font-medium text-gray-700 dark:text-gray-300"
    >
      {children}
      {required ? <span className="ml-0.5 text-red-600 dark:text-red-400">*</span> : null}
    </label>
  )
}

/** A label wrapped around its control, so the two cannot come apart. */
export function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <label className="block min-w-0 text-sm font-medium text-gray-700 dark:text-gray-300">
      {label}
      {required ? <span className="ml-0.5 text-red-600 dark:text-red-400">*</span> : null}
      {children}
    </label>
  )
}

/* Told to password managers on every field that is not a credential, or a
   field called "name" gets an identity offered for it. */
const NO_AUTOFILL = {
  autoComplete: 'off',
  'data-1p-ignore': true,
  'data-lpignore': 'true',
  'data-bwignore': true,
  'data-form-type': 'other',
} as const

/** Password managers stay out unless the field says what it holds with `autoComplete`. */
export function Input({ className = '', ...props }: React.ComponentProps<'input'>) {
  const quiet = props.autoComplete === undefined ? NO_AUTOFILL : {}
  return <input className={`${CONTROL} ${className}`} {...quiet} {...props} />
}

/** A box that searches as it is typed in: the magnifier says so. */
export function SearchInput({ className = '', ...props }: React.ComponentProps<'input'>) {
  return (
    <div className="relative mt-1">
      <Icon
        name="search"
        className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-500"
      />
      <Input placeholder="Search" {...props} className={`!mt-0 !pl-8 ${className}`} />
    </div>
  )
}

export function Textarea({
  className = '',
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${CONTROL} ${className}`} {...NO_AUTOFILL} {...props} />
}

export function Select({
  className = '',
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`${CONTROL} ${className}`} {...props} />
}

/** One yes-or-no in a form: a box and its label, submitted as `on` when ticked. */
export function Checkbox({ label, ...props }: { label: React.ReactNode } & React.ComponentProps<'input'>) {
  return (
    <label className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
      <input
        type="checkbox"
        className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
        {...props}
      />
      <span className="min-w-0">{label}</span>
    </label>
  )
}

export function FormError({ children }: { children?: React.ReactNode }) {
  if (!children) return null
  return (
    <p role="alert" className="error-message">
      {children}
    </p>
  )
}

/** Disables itself while its form is submitting. */
export function SubmitButton({ children, ...props }: ButtonProps) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending} {...props}>
      {children}
    </Button>
  )
}
