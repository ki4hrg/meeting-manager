import { redirect } from 'next/navigation'

/* Review is part of the meeting's page now; an old link lands on it there. */
export default async function ReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ from?: string | string[] }>
}) {
  const { id } = await params
  const from = (await searchParams).from
  const query = typeof from === 'string' ? `?${new URLSearchParams({ from })}` : ''
  redirect(`/meetings/${encodeURIComponent(id)}${query}#review`)
}
