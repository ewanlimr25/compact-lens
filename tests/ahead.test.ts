import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { APPLY, BEFORE, DIR, KEEP, last, setup, START, SUMMARY, watchState } from './kit'
import type { StateWrite } from './kit'
const all = (writes: readonly StateWrite[], key: string): unknown[] => writes.filter(w => w.key === key).map(w => w.value)

const step = async ($: Engine, index: number) => {
  const stream = $.turn.step({ turnId: 't1', index, model: 'm', messageCount: 3 })
  for await (const _chunk of stream) {
    // drained
  }
  return stream.result
}

// The kit's engine keeps no transcript, so `$.session.append` has no bottom there: every append
// fails, and the mod releases the warning again so the next step retries. The warning's text is
// checked in notes.test.ts; here the bookkeeping: armed at 75, released on the failed append, and
// reset with the fill by a compaction.
test('the fill is read at every step; the warning is armed at the line, released when its append fails, and reset by a compaction', async ($, on) => {
  setup(on)
  const writes = watchState(on)
  await $.session.start(START)
  expect(all(writes, 'warnedAt')).toEqual([])

  await step($, 0)
  expect(last(writes, 'fill')).toBe(75)
  expect(all(writes, 'warnedAt')).toEqual([75, null])

  await step($, 1)
  expect(all(writes, 'warnedAt')).toEqual([75, null, 75, null])

  await $.session.compact({ trigger: 'auto', messages: BEFORE })
  expect(last(writes, 'warnedAt')).toBe(null)
  expect(last(writes, 'fill')).toBe(null)
  await step($, 2)
  expect(last(writes, 'fill')).toBe(75)
  expect(all(writes, 'warnedAt').length).toBe(7)
})

test('no warning below the line', { options: { warnAtPercent: 80 } }, async ($, on) => {
  setup(on)
  const writes = watchState(on)
  await $.session.start(START)

  await step($, 0)

  expect(last(writes, 'fill')).toBe(75)
  expect(writes.some(w => w.key === 'warnedAt')).toBe(false)
})

test('no warning at all when the line is 0', { options: { warnAtPercent: 0 } }, async ($, on) => {
  setup(on)
  const writes = watchState(on)
  await $.session.start(START)

  await step($, 0)

  expect(writes.some(w => w.key === 'warnedAt')).toBe(false)
})

test("a subagent's step neither reads the fill nor warns", async ($, on) => {
  setup(on)
  const writes = watchState(on)
  await $.session.start(START)

  const stream = $.turn.step({ turnId: 't2', index: 0, model: 'm', messageCount: 3, agentId: 'agent-1' })
  for await (const _chunk of stream) {
    // drained
  }
  await stream.result

  expect(writes.some(w => w.key === 'fill')).toBe(false)
  expect(writes.some(w => w.key === 'warnedAt')).toBe(false)
})

test('the pane draws the status, the compactions and the pins on each surface', async ($, on) => {
  setup(on)
  await $.session.start(START)
  await $.tool.call({ tool: KEEP, note: 'Deploy only on Fridays' })
  await $.session.compact({ trigger: 'auto', messages: BEFORE })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'compact-lens',
      surface,
      component: 'Pane',
      requestId: 'compact-lens',
      props: { title: 'Compact Lens', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    })
    expect(await ui.find({ type: 'Text', text: /1 compaction/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /#01 auto/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Deploy only on Fridays/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'apply' })).toBeDefined()
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /context 75%/ })).toBeDefined()
    await ui.unmount()
  }
})

const MAIN_END = { answer: 'done', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' } as const

// The engine never shows a plugin's own $.session.compact() to that plugin's session.compact hook,
// so the model's apply asks for no compaction: it readies the edit, and the person's /compact applies it.
test("the model's apply readies the edit and, when its turn ends, puts /compact in the person's box; nothing compacts", async ($, on) => {
  const world = setup(on)
  const writes = watchState(on)
  on('turn.complete', ($, e) => ({ text: e.answer }))
  await $.session.start(START)
  const first = await $.session.compact({ trigger: 'auto', messages: BEFORE })
  world.transcript = [...(first.messages ?? [])]
  world.files.set(`${DIR}/01/summary.md`, `${SUMMARY}\nEdited.`)

  const asked = await $.tool.call({ tool: APPLY })
  expect(asked.deny).toBeUndefined()
  expect(String(asked.result)).toContain(`${DIR}/01/summary.md is ready`)
  expect(String(asked.result)).toContain('press Enter on it')
  expect(last(writes, 'pendingApply')).toBe(true)
  await $.turn.complete({ ...MAIN_END, answer: 'sub', agentId: 'agent-1' })
  expect(world.box).toBe('')
  const done = await $.turn.complete(MAIN_END)

  expect(done.text).toBe('done')
  expect(world.box).toBe('/compact ')
  expect(world.toasts.at(-1)).toContain('Enter applies the edited summary')
  expect(world.compactions).toBe(1)
  world.box = ''
  await $.turn.complete(MAIN_END)
  expect(world.box).toBe('')
})

test("the model's apply is refused before any compaction and while summary.md is the summary in use, and a busy box is left alone", async ($, on) => {
  const world = setup(on)
  const writes = watchState(on)
  on('turn.complete', ($, e) => ({ text: e.answer }))
  await $.session.start(START)

  const nothing = await $.tool.call({ tool: APPLY })
  expect(nothing.deny).toContain('no compaction has run yet')
  const first = await $.session.compact({ trigger: 'auto', messages: BEFORE })
  world.transcript = [...(first.messages ?? [])]
  const unchanged = await $.tool.call({ tool: APPLY })
  expect(unchanged.deny).toContain('is the summary in use')
  expect(writes.some(w => w.key === 'pendingApply' && w.value === true)).toBe(false)

  world.files.set(`${DIR}/01/summary.md`, `${SUMMARY}\nEdited.`)
  await $.tool.call({ tool: APPLY })
  world.box = 'a prompt half typed'
  await $.turn.complete(MAIN_END)
  expect(world.box).toBe('a prompt half typed')
  expect(world.toasts.at(-1)).toContain('run /compact to apply')
})
