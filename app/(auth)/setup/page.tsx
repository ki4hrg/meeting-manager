import { redirect } from 'next/navigation'
import { needsSetup } from '@/lib/auth/users'
import { SetupForm } from './setup-form'

/* Closed for good once the account exists. Checked here so the form is never
   rendered, and again inside createFirstUser under a lock. */
export default async function SetupPage() {
  if (!(await needsSetup())) redirect('/login')

  return <SetupForm />
}
