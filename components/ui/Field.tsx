'use client'

import { useFormStatus } from 'react-dom'
import { Button, type ButtonProps } from './Button'

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
    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
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
