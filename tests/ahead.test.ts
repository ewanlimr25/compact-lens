import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { APPLY, appendedTexts, BEFORE, BREAKDOWN, DIR, KEEP, last, setup, START, SUMMARY, THRESHOLD, USAGE, watchState } from './kit'
import type { StateWrite } from './kit'
const all = (writes: readonly StateWrite[], key: string): unknown[] => writes.filter(w => w.key === key).map(w => w.value)

const step = async ($: Engine, index: number) => {
  const stream = $.turn.step({ turnId: 't1', index, model: 'm', messageCount: 3 })
  for await (const _chunk of stream) {
    // drained
  }
  return stream.result
}

// The kit's session auto-compacts at 160k tokens and holds 150k: 94% of the way there, past the
// default line of 80. The warning goes once, and a compaction arms it again.
test('the context is read at every step against where auto-compaction runs; the warning goes once, and a compaction arms it again', async ($, on) => {
  const world = setup(on)
  const writes = watchState(on)
  await $.session.start(START)
  expect(all(writes, 'warnedAt')).toEqual([])

  await step($, 0)
  expect(last(writes, 'context')).toEqual({ tokens: 150000, window: 200000, threshold: THRESHOLD })
  expect(all(writes, 'warnedAt')).toEqual([94])
  expect(appendedTexts(world)).toHaveLength(1)
  expect(appendedTexts(world)[0]).toContain('Context is at 150k of 160k before auto-compaction (94%)')
  expect(world.toasts.at(-1)).toContain('150k of 160k before auto-compaction (94%)')
  expect(world.status).toBe('compact-lens: 150k of 160k before auto-compaction (94%) · 0 compactions · 0 pinned')

  await step($, 1)
  expect(all(writes, 'warnedAt')).toEqual([94])
  expect(appendedTexts(world)).toHaveLength(1)

  await $.session.compact({ trigger: 'auto', messages: BEFORE })
  expect(last(writes, 'warnedAt')).toBe(null)
  expect(last(writes, 'context')).toBe(null)
  await step($, 2)
  expect(all(writes, 'warnedAt')).toEqual([94, null, 94])
  expect(appendedTexts(world)).toHaveLength(2)
})

test('no warning below the line', { options: { warnAtPercent: 95 } }, async ($, on) => {
  const world = setup(on)
  const writes = watchState(on)
  await $.session.start(START)

  await step($, 0)

  expect(last(writes, 'context')).toEqual({ tokens: 150000, window: 200000, threshold: THRESHOLD })
  expect(writes.some(w => w.key === 'warnedAt')).toBe(false)
  expect(appendedTexts(world)).toHaveLength(0)
})

test('no warning at all when the line is 0', { options: { warnAtPercent: 0 } }, async ($, on) => {
  setup(on)
  const writes = watchState(on)
  await $.session.start(START)

  await step($, 0)

  expect(writes.some(w => w.key === 'warnedAt')).toBe(false)
})

test('where auto-compaction is off or unknown, the context is measured against the window', async ($, on) => {
  const world = setup(on, { usage: { startedAt: 0, context: { window: 200000, tokens: 150000, percent: 75 }, rateLimits: [] } })
  const writes = watchState(on)
  await $.session.start(START)

  await step($, 0)

  expect(last(writes, 'context')).toEqual({ tokens: 150000, window: 200000, threshold: null })
  expect(writes.some(w => w.key === 'warnedAt')).toBe(false)
  expect(world.status).toBe('compact-lens: 150k of a 200k window (75%) · 0 compactions · 0 pinned')
})

test("a subagent's step neither reads the context nor warns", async ($, on) => {
  setup(on)
  const writes = watchState(on)
  await $.session.start(START)

  const stream = $.turn.step({ turnId: 't2', index: 0, model: 'm', messageCount: 3, agentId: 'agent-1' })
  for await (const _chunk of stream) {
    // drained
  }
  await stream.result

  expect(writes.some(w => w.key === 'context')).toBe(false)
  expect(writes.some(w => w.key === 'warnedAt')).toBe(false)
})

test('the pane draws the context, the compactions, the actions and the pins on each surface', async ($, on) => {
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
    expect(await ui.find({ type: 'Text', text: /1 compaction · 1 pinned/ })).toBeDefined()
    expect(await ui.find({ type: 'Select', key: 'pick' })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /# What compaction #1 \(auto\) dropped/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Deploy only on Fridays/ })).toBeDefined()
    for (const key of ['restore', 'edit', 'apply', 'refresh', 'close']) expect(await ui.find({ type: 'Button', key })).toBeDefined()
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /150k of 160k before auto-compaction \(94%\)/ })).toBeDefined()
    await ui.unmount()
  }
})

test('with no compaction yet the pane says what it will show, and the phone app gets buttons where it has no Select', async ($, on) => {
  setup(on)
  await $.session.start(START)
  const empty = await $.ui.mount({
    plugin: 'compact-lens',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'compact-lens',
    props: { title: 'Compact Lens', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
  expect(await empty.find({ type: 'Text', text: /No compaction yet/ })).toBeDefined()
  await empty.unmount()

  await $.session.compact({ trigger: 'auto', messages: BEFORE })
  const phone = await $.ui.mount({
    plugin: 'compact-lens',
    surface: 'mobile',
    component: 'Pane',
    requestId: 'compact-lens',
    props: { title: 'Compact Lens', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
  expect(await phone.find({ type: 'Button', key: 'pick-1' })).toBeDefined()
  expect(await phone.find({ type: 'Select' })).toBeUndefined()
  await phone.unmount()
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

test('a /model switch moves the line: the threshold is read again once the window changes', async ($, on) => {
  const world = setup(on)
  const writes = watchState(on)
  await $.session.start(START)
  await step($, 0)

  world.usage = { ...USAGE, context: { window: 1000000, tokens: 150000, percent: 15, breakdown: { ...BREAKDOWN, maxTokens: 1000000, autoCompactThreshold: 470000 } } }
  await step($, 1)

  expect(last(writes, 'context')).toEqual({ tokens: 150000, window: 1000000, threshold: 470000 })
})

test('a threshold that could not be read is read again at the next step, not taken as none', async ($, on) => {
  const world = setup(on)
  const writes = watchState(on)
  world.usageFailures = 1
  await $.session.start(START)

  await step($, 0)
  const first = last(writes, 'context')
  await step($, 1)

  expect(first).toEqual({ tokens: 150000, window: 200000, threshold: null })
  expect(last(writes, 'context')).toEqual({ tokens: 150000, window: 200000, threshold: THRESHOLD })
})

test('a settings change moves the line too: the threshold is read again after one, the window unchanged', async ($, on) => {
  const world = setup(on)
  const writes = watchState(on)
  await $.session.start(START)
  await step($, 0)

  world.usage = { ...USAGE, context: { ...USAGE.context, breakdown: { ...BREAKDOWN, autoCompactThreshold: 120000 } } }
  await $.classic.ConfigChange({ source: 'user_settings' })
  await step($, 1)

  expect(last(writes, 'context')).toEqual({ tokens: 150000, window: 200000, threshold: 120000 })
})
