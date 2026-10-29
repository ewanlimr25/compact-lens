import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { RECALL, setup, START, writeTranscript } from './kit'
import type { Row } from './rows'
import { boundary, prompt, reply, summary, SUMMARY_ONE, twoCompactions } from './rows'

const PRESENTATION = { isFullscreen: true, columns: 120 }
const run = ($: Engine, args: string) => $.command.run({ command: 'compact-lens', args, origin: { kind: 'composer' }, presentation: PRESENTATION })
const recall = async ($: Engine, query: string): Promise<string> => {
  const answer = await $.tool.call({ tool: RECALL, query })
  return 'result' in answer && typeof answer.result === 'string' ? answer.result : JSON.stringify(answer)
}

test('where no passage holds every word, recall gives back those that hold all but one, each naming the word it lacks', async ($, on) => {
  const world = setup(on)
  writeTranscript(world, twoCompactions())
  await $.session.start(START)

  const block = await recall($, 'retry jitter zeppelin')

  expect(block).toContain('No passage of the 2 compacted spans holds every word of "retry jitter zeppelin". These hold 2 of its 3 words, verbatim, newest first')
  expect(block).toContain('· the person · 2026-10-20 10:01 UTC · lacks "zeppelin"')
  expect(block).toContain('Set the retry limit in src/net/retry.ts to 7 and keep the jitter at 250ms')
  expect(block).not.toContain('Nothing in')
})

test("the person's restore falls back the same way, and says the passages are partial", async ($, on) => {
  const world = setup(on)
  writeTranscript(world, twoCompactions())
  await $.session.start(START)

  const restored = await run($, 'restore retry jitter zeppelin')

  expect(restored.text).toContain('Claude now has 1 passage holding 2 of the 3 words of "retry jitter zeppelin", verbatim')
  expect(restored.context?.[0]).toContain('lacks "zeppelin"')
})

test('a passage that holds every word leaves the partial ones out', async ($, on) => {
  const world = setup(on)
  writeTranscript(world, twoCompactions())
  await $.session.start(START)

  const block = await recall($, 'retry jitter')

  expect(block).toContain('that hold every word of "retry jitter"')
  expect(block).not.toContain('lacks')
})

test('one word that matches nothing has nothing to fall back to, and a partial passage needs a word long enough to search on', async ($, on) => {
  const world = setup(on)
  writeTranscript(world, [...twoCompactions(), reply(30, 'm-late', 'to be continued')])
  await $.session.start(START)

  const single = await recall($, 'zeppelin')
  const short = await recall($, 'to zeppelin')

  expect(single).toContain('Nothing in the 2 compacted spans matches "zeppelin"')
  expect(short).toContain('Nothing in the 2 compacted spans matches "to zeppelin"')
})

test('without perl, grep finds the rows that hold any of the words, and the fallback still names what each lacks', async ($, on) => {
  const world = setup(on, { perl: false })
  writeTranscript(world, twoCompactions())
  await $.session.start(START)

  const block = await recall($, 'retry jitter zeppelin')

  expect(block).toContain('These hold 2 of its 3 words')
  expect(block).toContain('lacks "zeppelin"')
  const greps = world.spawned.filter(argv => argv[0] === 'grep' && argv.includes('-i'))
  expect(greps.length).toBeGreaterThanOrEqual(3)
  for (const argv of greps) expect(argv.filter(word => word === '-e').length).toBe(1)
})

/** One old prompt with a long word, under more rows than a recall reads that hold the query's other words, all compacted. */
const crowded = (oldText: string, newText: (i: number) => string, count: number): Row[] => [
  prompt(1, oldText),
  ...Array.from({ length: count }, (_, i) => reply(2 + i, `m${i}`, newText(i))),
  boundary(count + 2, 'auto', 180000),
  summary(count + 3, SUMMARY_ONE),
  prompt(count + 4, 'What next?'),
]

for (const perl of [true, false]) {
  test(`rows that hold only a short word never crowd out the passage the fallback should find${perl ? '' : ', without perl'}`, async ($, on) => {
    const world = setup(on, { perl })
    writeTranscript(world, crowded('Plan the migration of the orders table', i => `checked db shard ${i}`, 700))
    await $.session.start(START)

    const block = await recall($, 'db migration')

    expect(block).toContain('These hold 1 of its 2 words')
    expect(block).toContain('lacks "db"')
    expect(block).toContain('Plan the migration of the orders table')
    expect(block).not.toContain('were not read')
  })
}

test('without perl, rows holding only the longest word are not taken for rows holding every word: the fallback still runs', async ($, on) => {
  const world = setup(on, { perl: false })
  writeTranscript(world, crowded('Ship the orders export', i => `the migration step ${i} ran`, 700))
  await $.session.start(START)

  const block = await recall($, 'orders migration')

  expect(block).toContain('These hold 1 of its 2 words')
  expect(block).not.toContain('hold every word but were not read')
})

test('without perl, words whose matches overlap in a row are both found: grep looks for each long word apart', async ($, on) => {
  const world = setup(on, { perl: false })
  writeTranscript(world, crowded('the foobarbaz flag', i => `filler ${i}`, 3))
  await $.session.start(START)

  const block = await recall($, 'foobar barbaz')

  expect(block).toContain('the foobarbaz flag')
  expect(block).not.toContain('lacks')
})

test('without perl, a passage holding a short word and a long one is found whole: the short word is checked on the rows read', async ($, on) => {
  const world = setup(on, { perl: false })
  writeTranscript(world, crowded('Plan the db migration of the orders table', i => `the migration step ${i} ran`, 5))
  await $.session.start(START)

  const block = await recall($, 'db migration')

  expect(block).toContain('that hold every word of "db migration"')
  expect(block).toContain('Plan the db migration of the orders table')
  expect(block).not.toContain('lacks')
})

test('without perl, a short word is never searched on its own, so its many matches never fill the output', async ($, on) => {
  const world = setup(on, { perl: false })
  writeTranscript(world, crowded('Plan the migration of the orders table', i => `checked db shard ${i}`, 50))
  await $.session.start(START)

  await recall($, 'db migration')

  expect(world.spawned.filter(argv => argv[0] === 'grep' && argv.includes('db'))).toEqual([])
})
