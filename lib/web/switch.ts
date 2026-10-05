/* Pages that read the selected context whatever their path: switching keeps you
   on them. A person is in every context, so their page stays too. */
const STAYS =
  /^\/(?:projects|groups|series|meetings(?:\/past)?|people(?:\/[0-9a-f-]{36})?|inbox|contexts|settings|design)?$/

/**
 * Where switching context from the page at `from` lands: the same page, or,
 * for a record that belongs to the context being left (a project, a meeting),
 * the list it sits in. Only ever one of the app's own paths.
 */
export function switchTarget(from: string): string {
  const path = (from.split(/[?#]/)[0] ?? '').replace(/\/+$/, '') || '/'
  if (STAYS.test(path)) return path
  const list = `/${path.split('/')[1] ?? ''}`
  return STAYS.test(list) ? list : '/'
}
