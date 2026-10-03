/*
 * Runs the extraction fixtures through the real model and prints, for each,
 * whether what came back contains what a good extraction must.
 *
 *   ANTHROPIC_API_KEY=… pnpm exec tsx scripts/extraction-eval.ts [fixture-name …]
 *
 * By hand and on its own: it costs money and its answers vary, so it is no
 * part of `pnpm test`. EXTRACTION_MODEL picks the model, as it does in the app.
 * Exits non-zero when any expectation fails.
 */

import { extractorFromEnv } from '../lib/processing/extract'
import { check, loadFixtures } from '../test/fixtures/extraction/check'

async function main() {
  const configured = extractorFromEnv()
  if (!configured) {
    console.error('ANTHROPIC_API_KEY is not set. This script calls the real model and cannot run without it.')
    process.exit(2)
  }

  const wanted = process.argv.slice(2)
  const fixtures = loadFixtures().filter((fixture) => wanted.length === 0 || wanted.includes(fixture.name))
  if (fixtures.length === 0) {
    console.error(`No fixture named ${wanted.join(', ')}.`)
    process.exit(2)
  }

  console.log(`model: ${configured.model}\n`)

  let failed = 0
  for (const fixture of fixtures) {
    console.log(`${fixture.name}: ${fixture.about}`)

    let output
    try {
      output = await configured.extractor(fixture.input)
    } catch (err) {
      failed += fixture.expect.length
      console.log(`  ERROR ${err instanceof Error ? err.message : String(err)}\n`)
      continue
    }

    for (const expectation of fixture.expect) {
      const { pass, found } = check(output, expectation)
      if (!pass) failed += 1
      console.log(`  ${pass ? 'pass' : 'FAIL'}  ${expectation.say}${pass ? '' : `  [${found}]`}`)
    }

    console.log(`  summary: ${output.summary ?? '(none)'}`)
    for (const draft of output.drafts) {
      console.log(`  · ${JSON.stringify(draft.payload)}${draft.ownerGuessed ? '  (owner inferred)' : ''}`)
    }
    console.log('')
  }

  console.log(failed === 0 ? 'All expectations met.' : `${failed} expectation${failed === 1 ? '' : 's'} failed.`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()
