import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { RECALL_ROWS, RECALL_SCAN_CAP, RESTORE_CAP, SYNC_DELAY_MS } from '../hooks/paths'
import type { World } from './kit'
import { appendedTexts, DIR, RECALL, setup, START, TRANSCRIPT, writeTranscript } from './kit'
import {
  AFTER_APPLY_PROMPT,
  AFTER_ONE_PROMPT,
  appliedCompactions,
  BEFORE_APPLY_PROMPT,
  boundary,
  CANARY_URL,
  copyOf,
  HOOK_KEPT_PROMPT,
  hookedCompactions,
  KEPT_PROMPT,
  partialCompactions,
  prompt,
  QUEUED_PROMPT,
  reply,
  SPAN_ONE_PROMPT,
  SPAN_TWO_PROMPT,
  summary,
  SUMMARY_ONE,
  SUMMARY_TWO,
  twoCompactions,
} from './rows'

const PRESENTATION = { isFullscreen: true, columns: 120 }
const run = ($: Engine, args: string) => $.command.run({ command: 'compact-lens', args, origin: { kind: 'composer' }, presentation: PRESENTATION })
/** The transcript lines the host's sed printed since the `from`-th command. */
const linesRead = (world: World, from: number): number[] =>
  world.spawned.slice(from).filter(argv => argv[0] === 'sed').flatMap(argv => [...(argv[2] ?? '').matchAll(/(\d+)\{=;p;/g)].map(m => Number(m[1])))

/** `count` replies that hold "protocol" in their text and "slippage" only in their working folder, from line `from`. */
const nearMisses = (from: number, count: number, id: string) =>
  Array.from({ length: count }, (_, i) => ({ ...reply(from + i, `${id}${i}`, `protocol run ${i}`), cwd: '/home/tester/slippage-notes' }))

const fillers = (from: number, count: number) => Array.from({ length: count }, (_, i) => reply(from + i, `f${i}`, `filler ${i}`))

const PANE = { title: 'Compact Lens', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const

test('lost n reads a compaction the mod did not see from the transcript: your prompts verbatim, the files, the details', async ($, on) => {
  const world = setup(on)
  writeTranscript(world, twoCompactions())
  await $.session.start(START)

  const lost = await run($, 'lost 1')

  const text = lost.text ?? ''
  expect(text.startsWith(`${DIR}/01/lost.md\n\n# What compaction #1 (auto) dropped`)).toBe(true)
  expect(text).toContain('auto · 2026-10-20 10:06 UTC · 180k tokens in → 20k out · transcript lines 1–5')
  expect(text).toContain('- Your prompts: 1;')
  expect(text).toContain(`2026-10-20 10:01 UTC — ${SPAN_ONE_PROMPT}`)
  expect(text).toContain('## Files never named after the compaction (1)\n- /repo/src/net/retry.ts (edited)')
  expect(text).toContain('`c0ffee12`')
  expect(text).not.toContain('a background job ended')
  expect(world.files.get(`${DIR}/01/before.md`)).toContain('read the span from the session\'s transcript afterwards')
  expect(world.files.get(`${DIR}/01/summary.md`)).toBe(SUMMARY_ONE)
  const meta = JSON.parse(world.files.get(`${DIR}/01/meta.json`) ?? '{}')
  expect(meta.hasDetail).toBe(true)
  expect(meta.promptsInSpan).toBe(1)
  expect(meta.filesUnnamed).toBe(1)
  expect(meta.span).toEqual({ from: 1, to: 5, boundary: 6, summary: 7 })
})

test('restore n gives Claude your prompts from that span verbatim, queued ones too, as context the model alone reads', async ($, on) => {
  const world = setup(on)
  writeTranscript(world, twoCompactions())
  await $.session.start(START)

  const restored = await run($, 'restore 2')
  const latest = await run($, 'restore')

  const block = restored.context?.[0] ?? ''
  expect(restored.text).toContain('Claude now has your 2 prompts from compaction #2, verbatim')
  expect(block).toContain('<compact-lens-restore n="2" kind="prompts">')
  expect(block).toContain('The person asked for these back')
  expect(block).toContain(`1. [2026-10-20 10:08 UTC] ${SPAN_TWO_PROMPT}`)
  expect(block).toContain(`2. [2026-10-20 10:11 UTC] ${QUEUED_PROMPT}`)
  expect(block).not.toContain('This session is being continued')
  expect(block.endsWith('</compact-lens-restore>')).toBe(true)
  expect(latest.context?.[0]).toBe(block)
  expect(world.files.size).toBeGreaterThan(0)
})

test('restore with words gives Claude the compacted passages that hold them all, newest first, each named by the compaction that dropped it and its line', async ($, on) => {
  const world = setup(on)
  writeTranscript(world, twoCompactions())
  await $.session.start(START)

  const found = await run($, 'restore retry.ts')
  const kept = await run($, 'restore canary-42')
  const quoted = await run($, 'restore 1 "retry limit"')
  const nothing = await run($, 'restore zeppelin')

  const block = found.context?.[0] ?? ''
  expect(found.text).toContain('Claude now has 3 passages mentioning "retry.ts", verbatim')
  expect(block).toContain('<compact-lens-recall query="retry.ts">')
  expect(block.indexOf('--- #1 · line 3 · a tool result')).toBeLessThan(block.indexOf("--- #1 · line 2 · Claude's Edit call"))
  expect(block.indexOf("--- #1 · line 2 · Claude's Edit call")).toBeLessThan(block.indexOf('--- #1 · line 1 · the person'))
  expect(kept.text).toContain('Claude now has 1 passage mentioning "canary-42"')
  expect(kept.context?.[0]).toContain('--- #2 · line 10 · a tool result')
  expect(kept.context?.[0]).toContain(CANARY_URL)
  expect(kept.context?.[0]).not.toContain('line 12')
  expect(kept.context?.[0]).not.toContain('What is left to do?')
  expect(quoted.context?.[0]).toContain('--- #1 · line 1 · the person')
  expect(nothing.context?.[0]).toContain('Nothing in the 2 compacted spans matches "zeppelin"')
  expect(world.spawned.length).toBeGreaterThan(0)
})

test('the messages a compaction kept go with the one after it: restore, recall and the lost report find them there', async ($, on) => {
  const world = setup(on)
  writeTranscript(world, partialCompactions())
  await $.session.start(START)

  const first = await run($, 'restore 1')
  const second = await run($, 'restore 2')
  const recalled = await $.tool.call({ tool: RECALL, query: 'canary-only alias' })
  const lost = await run($, 'lost 2')

  expect(first.context?.[0]).toContain(SPAN_ONE_PROMPT)
  expect(first.context?.[0]).not.toContain(KEPT_PROMPT)
  expect(second.text).toContain('Claude now has your 2 prompts from compaction #2')
  expect(second.context?.[0]).toContain(`1. [2026-10-20 10:03 UTC] ${KEPT_PROMPT}`)
  expect(second.context?.[0]).toContain(`2. [2026-10-20 10:07 UTC] ${AFTER_ONE_PROMPT}`)
  expect(String(recalled.result)).toContain('--- #2 · line 3 · the person')
  expect(String(recalled.result)).not.toContain('--- #1')
  expect(lost.text).toContain(KEPT_PROMPT)
  expect(world.files.get(`${DIR}/02/before.md`)).toContain(KEPT_PROMPT)
})

test("an apply keeps every message, written again after its boundary: its prompts go with the compaction after it, and its summary is no prompt", async ($, on) => {
  const world = setup(on)
  writeTranscript(world, appliedCompactions())
  await $.session.start(START)

  const apply = await run($, 'restore 2')
  const after = await run($, 'restore 3')
  const recalled = await $.tool.call({ tool: RECALL, query: 'changelog' })

  expect(apply.text).toContain('compaction #2 kept every prompt you typed in its span (1)')
  expect(after.text).toContain('Claude now has your 2 prompts from compaction #3')
  expect(after.context?.[0]).toContain(BEFORE_APPLY_PROMPT)
  expect(after.context?.[0]).toContain(AFTER_APPLY_PROMPT)
  expect(after.context?.[0]).not.toContain('as edited')
  expect(String(recalled.result)).toContain('--- #3 · line 11 · the person')
  expect(String(recalled.result)).toContain('--- #3 · line 12 · Claude')
  expect(String(recalled.result)).not.toContain('--- #2')
  expect(world.files.size).toBeGreaterThan(0)
})

test('a recall asks the host for rows holding every word, and reads on past rows whose words only meet outside the text', async ($, on) => {
  const world = setup(on)
  const noise = Array.from({ length: RECALL_ROWS + 5 }, (_, i) => ({ ...reply(i + 2, `n${i}`, `protocol run ${i}`), cwd: '/home/tester/slippage-notes' }))
  const end = RECALL_ROWS + 7
  writeTranscript(world, [prompt(1, 'protocol 7 slippage was a cent a share'), ...noise, boundary(end, 'auto', 100000), summary(end + 1, SUMMARY_ONE)])
  await $.session.start(START)

  const found = await $.tool.call({ tool: RECALL, query: 'protocol slippage' })
  const short = await $.tool.call({ tool: RECALL, query: 'a b' })

  expect(String(found.result)).toContain('--- #1 · line 1 · the person')
  expect(world.spawned.some(argv => argv[0] === 'perl' && argv.includes('protocol') && argv.includes('slippage'))).toBe(true)
  expect(short.deny).toContain('a word of 3 or more characters')
})

test("the messages the mod's own hook kept, which the engine writes again after the note, go with the compaction after it, once", async ($, on) => {
  const world = setup(on)
  writeTranscript(world, hookedCompactions())
  await $.session.start(START)

  const first = await run($, 'restore 1')
  const second = await run($, 'restore 2')
  const recalled = await $.tool.call({ tool: RECALL, query: 'canary percent' })

  expect(first.text).toContain('Claude now has your 1 prompt from compaction #1')
  expect(first.context?.[0]).not.toContain(HOOK_KEPT_PROMPT)
  expect(second.text).toContain('Claude now has your 2 prompts from compaction #2')
  expect(second.context?.[0]).toContain(HOOK_KEPT_PROMPT)
  expect(String(recalled.result)).toContain('--- #2 · line 8 · the person')
  expect(String(recalled.result)).not.toContain('line 3 ·')
  expect(world.files.size).toBeGreaterThan(0)
})

test('a message the latest compaction wrote again is still in the context, so recall does not hand it back', async ($, on) => {
  const world = setup(on)
  writeTranscript(world, hookedCompactions().slice(0, 11))
  await $.session.start(START)

  const recalled = await $.tool.call({ tool: RECALL, query: 'canary percent' })

  expect(String(recalled.result)).toContain('Nothing in the 1 compacted span matches "canary percent"')
  expect(world.files.size).toBeGreaterThan(0)
})

test('a recall that stops before reading every matching row says how many it left unread', async ($, on) => {
  const world = setup(on)
  const noise = Array.from({ length: RECALL_SCAN_CAP + 5 }, (_, i) => ({ ...reply(i + 2, `n${i}`, `protocol run ${i}`), cwd: '/home/tester/slippage-notes' }))
  const end = RECALL_SCAN_CAP + 7
  writeTranscript(world, [prompt(1, 'protocol 7 slippage was a cent a share'), ...noise, boundary(end, 'auto', 100000), summary(end + 1, SUMMARY_ONE)])
  await $.session.start(START)

  const found = await $.tool.call({ tool: RECALL, query: 'protocol slippage' })

  expect(String(found.result)).toContain('6 more rows hold every word but were not read')
  expect(String(found.result)).not.toContain('Nothing in')
  expect(world.files.size).toBeGreaterThan(0)
})

test('one matching row left unread is named in the singular', async ($, on) => {
  const world = setup(on)
  const end = RECALL_SCAN_CAP + 2
  writeTranscript(world, [prompt(1, 'protocol 7 slippage was a cent a share'), ...nearMisses(2, RECALL_SCAN_CAP, 'n'), boundary(end, 'auto', 100000), summary(end + 1, SUMMARY_ONE)])
  await $.session.start(START)

  const found = await $.tool.call({ tool: RECALL, query: 'protocol slippage' })

  expect(String(found.result)).toContain('1 more row holds every word but was not read: add a word, or name a compaction, to reach it.')
})

test('rows still in the context after the latest compaction neither use up a recall nor count as unread', async ($, on) => {
  const world = setup(on)
  const end = RECALL_SCAN_CAP + 7
  const rows = [prompt(1, 'protocol 7 slippage was a cent a share'), ...fillers(2, end - 2), boundary(end, 'auto', 100000), summary(end + 1, SUMMARY_ONE), ...nearMisses(end + 2, RECALL_SCAN_CAP + 5, 'c')]
  writeTranscript(world, rows)
  await $.session.start(START)
  const before = world.spawned.length

  const found = await $.tool.call({ tool: RECALL, query: 'protocol slippage' })

  expect(String(found.result)).toContain('--- #1 · line 1 · the person')
  expect(String(found.result)).not.toContain('not read')
  expect(linesRead(world, before).filter(line => line > end + 1).length).toBeLessThanOrEqual(RECALL_ROWS)
})

test("a recall in one compaction's span reads that span: the next one's many matching rows do not crowd it out", async ($, on) => {
  const world = setup(on)
  const first = RECALL_SCAN_CAP + 6
  const second = first + 2 + RECALL_SCAN_CAP + 5
  const rows = [
    prompt(1, 'protocol 7 slippage was a cent a share'),
    ...fillers(2, first - 2),
    boundary(first, 'auto', 100000, [`u${first - 1}`]),
    summary(first + 1, SUMMARY_ONE),
    ...nearMisses(first + 2, RECALL_SCAN_CAP + 5, 'c'),
    boundary(second, 'manual', 100000),
    summary(second + 1, SUMMARY_TWO),
  ]
  writeTranscript(world, rows)
  await $.session.start(START)
  const before = world.spawned.length

  const found = await $.tool.call({ tool: RECALL, query: 'protocol slippage', compaction: 1 })

  expect(String(found.result)).toContain('--- #1 · line 1 · the person')
  expect(String(found.result)).not.toContain('not read')
  expect(linesRead(world, before).filter(line => line > first + 1 && line < second)).toEqual([])
})

/** An apply that keeps `count` matching replies, written again after its boundary, which is returned apart. */
const applyKeeping = (count: number) => {
  const asks = Array.from({ length: count }, (_, i) => reply(4 + i, `a${i}`, `protocol run ${i} with slippage`))
  const applied = 4 + count + 1
  const rows = [
    prompt(1, SPAN_ONE_PROMPT),
    boundary(2, 'manual', 150000),
    summary(3, SUMMARY_ONE),
    ...asks,
    prompt(4 + count, '/compact'),
    boundary(applied, 'manual', 140000),
    reply(applied + 1, 'm-sum', 'The summary above was replaced.'),
    ...asks.map((ask, i) => copyOf(ask, applied + 2 + i)),
  ]
  return { rows, applied }
}

test("an apply's messages written again, more than a batch of them, all still count as in the context", async ($, on) => {
  const world = setup(on)
  writeTranscript(world, applyKeeping(RECALL_ROWS + 10).rows)
  await $.session.start(START)

  const found = await $.tool.call({ tool: RECALL, query: 'protocol slippage' })

  expect(String(found.result)).toContain('Nothing in the 2 compacted spans matches "protocol slippage"')
})

test('a compaction whose boundary row has no time is read to the end of where it may have written messages again', async ($, on) => {
  const world = setup(on)
  const { rows, applied } = applyKeeping(RECALL_ROWS + 10)
  const untimed = rows.map((row, i) => {
    if (i !== applied - 1) return row
    const { timestamp: _, ...rest } = row
    return rest
  })
  writeTranscript(world, untimed)
  await $.session.start(START)

  const found = await $.tool.call({ tool: RECALL, query: 'protocol slippage' })

  expect(String(found.result)).toContain('Nothing in the 2 compacted spans matches "protocol slippage"')
})

test('the recall tool hands the model the passages verbatim, one span when named, and says why when there is nothing to search', async ($, on) => {
  const world = setup(on)
  writeTranscript(world, twoCompactions())
  await $.session.start(START)

  const all = await $.tool.call({ tool: RECALL, query: 'c0ffee12' })
  const second = await $.tool.call({ tool: RECALL, query: 'c0ffee12', compaction: 2 })
  const empty = await $.tool.call({ tool: RECALL, query: '  ' })
  const missing = await $.tool.call({ tool: RECALL, query: 'xyz', compaction: 9 })

  expect(all.deny).toBeUndefined()
  expect(String(all.result)).toContain('--- #1 · line 4 · Claude')
  expect(String(all.result)).toContain('commit c0ffee12')
  expect(String(second.result)).toContain('Nothing in the span compaction #2 summarised matches "c0ffee12"')
  expect(empty.deny).toContain('say what to search for')
  expect(missing.deny).toContain('there is no compaction #9 in the transcript')
  expect(world.files.size).toBeGreaterThan(0)
})

test('where the transcript cannot be read, restore and recall say so plainly', async ($, on) => {
  const world = setup(on, { processes: false })
  writeTranscript(world, twoCompactions())
  await $.session.start(START)

  const recalled = await $.tool.call({ tool: RECALL, query: 'canary' })
  const restored = await run($, 'restore')

  expect(recalled.deny).toContain("the session's transcript cannot be read here")
  expect(restored.text).toContain('nothing restored:')
})

test('a long restore keeps the newest prompts within its cap and says how many older ones it left out', async ($, on) => {
  const world = setup(on)
  const long = Array.from({ length: 40 }, (_, i) => prompt(i + 1, `prompt ${i + 1}: ${'words '.repeat(120)}`))
  writeTranscript(world, [...long, boundary(41, 'auto', 300000), summary(42, SUMMARY_ONE)])
  await $.session.start(START)

  const restored = await run($, 'restore 1')

  const block = restored.context?.[0] ?? ''
  expect(block.length).toBeLessThanOrEqual(RESTORE_CAP)
  expect(block).toContain('prompt 40:')
  expect(block).not.toContain('prompt 1: ')
  expect(block).toMatch(/\(the \d+ oldest not shown, past 16000 characters\)/)
})

test('the pane picks any compaction, reads it from the transcript, and gives its prompts back to Claude with one button', async ($, on) => {
  const world = setup(on)
  writeTranscript(world, twoCompactions())
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'compact-lens', surface: 'terminal', component: 'Pane', requestId: 'compact-lens', props: PANE })

  expect(await ui.find({ type: 'Markdown', text: /ran while compact-lens was not watching/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'read' })).toBeDefined()
  await ui.select({ key: 'pick', value: '1' })
  const report = await ui.find({ type: 'Markdown', text: /# What compaction #1 \(auto\) dropped/ })
  await ui.press({ key: 'restore' })

  expect(report).toBeDefined()
  expect(appendedTexts(world)).toHaveLength(1)
  expect(appendedTexts(world)[0]).toContain('<compact-lens-restore n="1" kind="prompts">')
  expect(appendedTexts(world)[0]).toContain(SPAN_ONE_PROMPT)
  expect(world.toasts.at(-1)).toBe('Claude now has your 1 prompt from compaction #1, and reads them with your next message')
  await ui.unmount()
})

test('a compaction on show that was never read gets a button that reads it, and the button goes once it is read', async ($, on) => {
  const world = setup(on)
  writeTranscript(world, twoCompactions())
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'compact-lens', surface: 'terminal', component: 'Pane', requestId: 'compact-lens', props: PANE })

  expect(await ui.find({ type: 'Markdown', text: /press Read what it dropped/ })).toBeDefined()
  await ui.press({ key: 'read' })

  expect(await ui.find({ type: 'Markdown', text: /# What compaction #2 \(manual\) dropped/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'read' })).toBeUndefined()
  expect(world.files.get(`${DIR}/02/lost.md`)).toContain('# What compaction #2 (manual) dropped')
  await ui.unmount()
})

test("the pane's Edit works on the summary in use alone, and says so for an older one", async ($, on) => {
  const world = setup(on)
  writeTranscript(world, twoCompactions())
  await $.session.start(START)
  await world.clock.advance(SYNC_DELAY_MS)
  const ui = await $.ui.mount({ plugin: 'compact-lens', surface: 'terminal', component: 'Pane', requestId: 'compact-lens', props: PANE })

  await ui.select({ key: 'pick', value: '1' })
  await ui.press({ key: 'edit' })
  expect(world.toasts.at(-1)).toBe('only the summary in use (#2) can be edited; #1 is an older one')
  expect(world.box).toBe('')

  await ui.select({ key: 'pick', value: '2' })
  await ui.press({ key: 'edit' })
  expect(world.box).toContain('[compact-lens edit #02:')
  expect(world.box).toContain('Staging was deployed.')
  expect(world.files.get(TRANSCRIPT)).toBeDefined()
  await ui.unmount()
})
