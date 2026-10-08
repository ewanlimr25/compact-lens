import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { EDIT_FILL_DELAY_MS } from '../hooks/paths'
import { APPLY, BEFORE, DIR, last, setup, START, SUMMARY, watchState } from './kit'

const PRESENTATION = { isFullscreen: true, columns: 120 }
const run = ($: Engine, args: string) => $.command.run({ command: 'compact-lens', args, origin: { kind: 'composer' }, presentation: PRESENTATION })

test('show prints the lost report by default, any snapshot file by name and number, and says plainly what it cannot show', async ($, on) => {
  const world = setup(on)
  await $.session.start(START)
  const nothing = await run($, 'show')
  await $.session.compact({ trigger: 'auto', messages: BEFORE })

  const lost = await run($, 'show')
  const summary = await run($, 'show summary 1')
  const reversed = await run($, 'show #1 after')
  const missing = await run($, 'show before 7')
  const pinned = await run($, 'show pinned')
  const wrong = await run($, 'show everything')

  expect(nothing.text).toContain('no compaction has run yet')
  expect(lost.text?.startsWith(`${DIR}/01/lost.md\n\n# lost — compaction #1 (auto)`)).toBe(true)
  expect(summary.text).toBe(`${DIR}/01/summary.md\n\n${SUMMARY}`)
  expect(reversed.text?.startsWith(`${DIR}/01/after.md`)).toBe(true)
  expect(missing.text).toBe(`${DIR}/07/before.md does not exist`)
  expect(pinned.text).toBe(`${DIR}/pinned.md does not exist`)
  expect(wrong.text).toContain('show takes one of lost, after, summary, before, pinned')
  expect(world.files.size).toBeGreaterThan(0)
})

test('show cuts a long file and says how much is left in it', async ($, on) => {
  const world = setup(on)
  await $.session.start(START)
  await $.session.compact({ trigger: 'auto', messages: BEFORE })
  world.files.set(`${DIR}/01/before.md`, 'x'.repeat(20005))

  const shown = await run($, 'show before')

  expect(shown.text).toContain('… [cut: 5 more characters]')
})

test('cancel drops a waiting apply, so the next /compact compacts as usual', async ($, on) => {
  const world = setup(on)
  const writes = watchState(on)
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  await $.session.start(START)
  const first = await $.session.compact({ trigger: 'auto', messages: BEFORE })
  world.transcript = [...(first.messages ?? [])]
  world.files.set(`${DIR}/01/summary.md`, `${SUMMARY}\nEdited.`)

  const nothing = await run($, 'cancel')
  await $.tool.call({ tool: APPLY })
  expect(world.status).toContain('/compact applies the edit')
  const status = await run($, 'status')
  const dropped = await run($, 'cancel')
  const compacted = await $.session.compact({ trigger: 'manual', messages: first.messages ?? [] })

  expect(nothing.text).toBe('no apply is waiting.')
  expect(status.text).toContain('an edited summary waits: /compact with nothing after it applies it')
  expect(world.status).not.toContain('/compact applies the edit')
  expect(dropped.text).toContain('the waiting apply is dropped')
  expect(last(writes, 'pendingApply')).toBe(false)
  expect(compacted.skip).toBeUndefined()
  expect(world.compactions).toBe(2)
})

test('apply readies an edited summary.md and offers /compact; with nothing edited it says so and readies nothing', async ($, on) => {
  const world = setup(on)
  const writes = watchState(on)
  await $.session.start(START)
  const first = await $.session.compact({ trigger: 'auto', messages: BEFORE })
  world.transcript = [...(first.messages ?? [])]

  const unchanged = await run($, 'apply')
  expect(unchanged.text).toContain('nothing to apply:')
  expect(writes.some(w => w.key === 'pendingApply' && w.value === true)).toBe(false)

  world.files.set(`${DIR}/01/summary.md`, `${SUMMARY}\nEdited.`)
  const ready = await run($, 'apply')
  await world.clock.advance(EDIT_FILL_DELAY_MS)

  expect(ready.text).toContain(`${DIR}/01/summary.md is ready. Press Enter on /compact`)
  expect(ready.text?.startsWith('compact-lens:')).toBe(false)
  expect(world.box).toBe('/compact ')
  expect(world.compactions).toBe(1)
})
