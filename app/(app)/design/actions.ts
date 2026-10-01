'use server'

import { act, type ActionResult } from '@/lib/web/action'

/* For the samples on /design that need an action to call: it does nothing. */
export async function sampleAction(_formData: FormData): Promise<ActionResult> {
  void _formData
  return act(async () => {})
}
