import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { buildEditDraft, editHeader, fileStamp, judgeEdit, looksLikeEdit, parseEditHeader } from '../hooks/editor'
import { EDIT_CLEAR_DELAY_MS, EDIT_FILL_DELAY_MS } from '../hooks/paths'
import { BEFORE, DIR, KEPT, last, setup, START, SUMMARY, UNSEEN_SUMMARY, user, watchState } from './kit'

const PRESENTATION = { isFullscreen: true, columns: 120 }
const STAMP = '20231114-221320-000'
/** The kit's clock after an edit was opened: EDIT_FILL_DELAY_MS on. */
const STAMP_AFTER_EDIT = '20231114-221320-250'

const runEdit = ($: Engine) => $.command.run({ command: 'compact-lens', args: 'edit', origin: { kind: 'composer' }, presentation: PRESENTATION })

type World = ReturnType<typeof setup>

/** The person's Enter: the engine empties the box first, then the prompt goes through the hooks. */
const submit = ($: Engine, world: World, text: string, turnId?: string) => {
  world.box = ''
  return $.prompt.submit({ text, wait: false, origin: { kind: 'composer' }, ...(turnId === undefined ? {} : { turnId }) })
}

const BOILERPLATE = [
  'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion.',
  'Summary:',
  '1. Primary Request and Intent:',
]
const CLOSING = 'Continue the conversation from where it left off without asking the user any further questions.'

/** A summary shaped like the engine's: shared boilerplate, then lines of its own. */
const longSummary = (topic: string): string =>
  [...BOILERPLATE, ...Array.from({ length: 10 }, (_, i) => `   - ${topic}: decision ${i + 1} was recorded with its reason and its file.`), CLOSING].join('\n')

const LONG = longSummary('the release of compact-lens')

const openEdit = async ($: Engine, world: World): Promise<void> => {
  await runEdit($)
  await world.clock.advance(EDIT_FILL_DELAY_MS)
}

test('the header is found with trailing spaces or wrapped by an editor, and a summary is told from another by its own lines', async () => {
  expect(buildEditDraft(1, `  ${SUMMARY}\n`)).toBe(`${editHeader(1)}\n${SUMMARY}`)
  expect(editHeader(1).length).toBeLessThan(80)
  expect(parseEditHeader(buildEditDraft(1, SUMMARY))).toEqual({ n: 1, body: SUMMARY })
  expect(parseEditHeader(`${editHeader(12)}   \n  edited  \n`)).toEqual({ n: 12, body: 'edited' })
  expect(parseEditHeader(`  [compact-lens edit #03: Enter applies\nthis summary; an empty box cancels]\nwrapped`)).toEqual({ n: 3, body: 'wrapped' })
  expect(parseEditHeader(editHeader(2))).toEqual({ n: 2, body: '' })
  expect(parseEditHeader(`${SUMMARY} more`)).toBeUndefined()
  expect(parseEditHeader('[compact-lens edit #01] what does this line in my box mean?')).toBeUndefined()
  expect(parseEditHeader(`${editHeader(1)} and more on the same line`)).toBeUndefined()

  const edited = LONG.split('\n').filter(line => !line.includes('decision 2 ') && !line.startsWith('This session')).join('\n')
  expect(looksLikeEdit(edited, LONG)).toBe(true)
  expect(looksLikeEdit(longSummary('another session entirely'), LONG)).toBe(false)
  expect(looksLikeEdit(`${SUMMARY} more`, SUMMARY)).toBe(true)
  expect(looksLikeEdit('fix the tests please', SUMMARY)).toBe(false)
  expect(looksLikeEdit('anything', '   ')).toBe(false)

  expect(judgeEdit({ n: 1, body: '' }, 1)).toBe('empty')
  expect(judgeEdit({ n: 1, body: 'x' }, undefined)).toBe('none')
  expect(judgeEdit({ n: 1, body: 'x' }, 2)).toBe('stale')
  expect(judgeEdit({ n: 2, body: 'x' }, 2)).toBe('apply')
  expect(judgeEdit({ n: 2, body: 'x' }, 2, '  x\n')).toBe('unchanged')
  expect(judgeEdit({ n: 2, body: 'x' }, 2, 'y')).toBe('apply')
  expect(fileStamp('2026-10-07T13:53:42.706Z')).toBe('20261007-135342-706')
})

test('edit before any compaction says there is nothing to edit and leaves the box alone', async ($, on) => {
  const world = setup(on)
  await $.session.start(START)

  const reply = await runEdit($)
  await world.clock.advance(EDIT_FILL_DELAY_MS)

  expect(reply.text).toContain('no compaction has run yet')
  expect(world.box).toBe('')
  expect(world.fills.length).toBe(0)
})

test('/compact-lens edit puts the summary in the prompt box under its dimmed header and opens the edit', async ($, on) => {
  const world = setup(on)
  const writes = watchState(on)
  await $.session.start(START)
  await $.session.compact({ trigger: 'auto', messages: BEFORE })

  const reply = await runEdit($)

  expect(reply.text).toContain('compaction #01')
  expect(reply.text).toContain('ctrl+g')
  expect(world.fills.length).toBe(0)
  await world.clock.advance(EDIT_FILL_DELAY_MS)
  expect(world.box).toBe(buildEditDraft(1, SUMMARY))
  expect(world.fills.at(-1)?.decorations).toEqual([{ start: 0, end: editHeader(1).length, dimColor: true }])
  expect(last(writes, 'editing')).toBe(1)
})

test('Enter on the edited summary saves it, never reaches the model, puts /compact where the engine refilled the box, and /compact applies it', async ($, on) => {
  const world = setup(on)
  const writes = watchState(on)
  await $.session.start(START)
  const first = await $.session.compact({ trigger: 'auto', messages: BEFORE })
  world.transcript = [...(first.messages ?? [])]
  await openEdit($, world)
  const edited = `${SUMMARY}\nEdited in the box: the port is 8080.`
  const sent = `${editHeader(1)} \n${edited}\n`

  const result = await submit($, world, sent)
  world.box = sent

  expect(result.drop).toContain(`${DIR}/01/summary.md`)
  expect(result.drop).toContain('press Enter on /compact in the prompt box:')
  expect(result.drop).toContain('not sent to the model')
  expect(world.submitted).toEqual([])
  expect(world.files.get(`${DIR}/01/summary.md`)).toBe(edited)
  expect(last(writes, 'pendingApply')).toBe(true)
  expect(last(writes, 'editing')).toBe(null)
  await world.clock.advance(EDIT_CLEAR_DELAY_MS)
  expect(world.box).toBe('/compact ')
  expect(world.toasts.at(-1)).toContain('Enter applies the edited summary')

  const applied = await $.session.compact({ trigger: 'manual', messages: first.messages ?? [] })
  expect(applied.messages?.[0]?.text).toBe(edited)
  expect(world.compactions).toBe(1)
  expect(last(writes, 'pendingApply')).toBe(false)
})

test('an edit left as it was applies nothing and asks for no /compact', async ($, on) => {
  const world = setup(on)
  const writes = watchState(on)
  await $.session.start(START)
  const first = await $.session.compact({ trigger: 'auto', messages: BEFORE })
  world.transcript = [...(first.messages ?? [])]
  await openEdit($, world)

  const result = await submit($, world, world.box)
  await world.clock.advance(EDIT_CLEAR_DELAY_MS)

  expect(result.drop).toContain('is the one in use, so there is nothing to apply.')
  expect(writes.some(w => w.key === 'pendingApply' && w.value === true)).toBe(false)
  expect(world.box).toBe('')
  expect(world.submitted).toEqual([])
})

test('edit offers the summary the conversation runs on when the mod never saw the compaction that wrote it', async ($, on) => {
  const world = setup(on)
  await $.session.start(START)
  world.transcript = [user(UNSEEN_SUMMARY, 'h-u'), KEPT]

  const reply = await runEdit($)
  await world.clock.advance(EDIT_FILL_DELAY_MS)

  expect(reply.text).toContain('compaction #01')
  expect(reply.text?.startsWith("compact-lens:")).toBe(false)
  expect(world.box).toBe(buildEditDraft(1, UNSEEN_SUMMARY))
})

test('the box is emptied only when it holds the caught prompt, and an edit sent during a turn waits for its end', async ($, on) => {
  const world = setup(on)
  await $.session.start(START)
  await $.session.compact({ trigger: 'auto', messages: BEFORE })
  await openEdit($, world)

  const result = await submit($, world, `${editHeader(1)}\n${SUMMARY} changed`, 'turn-7')
  world.box = 'a new prompt typed at once'
  await world.clock.advance(EDIT_CLEAR_DELAY_MS)

  expect(result.drop).toContain('once the running turn has ended')
  expect(world.box).toBe('a new prompt typed at once')
  expect(world.toasts.at(-1)).toContain('run /compact to apply')
})

test('a deleted header is caught while the edit is open, another session summary is not, and an ordinary prompt closes the edit', async ($, on) => {
  const world = setup(on, { answer: () => ({ messages: [user(LONG, 'h-sum'), KEPT] }) })
  const writes = watchState(on)
  await $.session.start(START)
  await $.session.compact({ trigger: 'auto', messages: BEFORE })
  await openEdit($, world)

  const foreign = await submit($, world, longSummary('another session entirely'))
  expect(foreign.drop).toBeUndefined()
  expect(last(writes, 'editing')).toBe(null)
  const pasted = await submit($, world, `${LONG}\nPasted back after the edit was closed.`)
  expect(pasted.drop).toBeUndefined()

  await openEdit($, world)
  const noHeader = LONG.split('\n').slice(3).join('\n')
  const caught = await submit($, world, noHeader)

  expect(caught.drop).toContain('saved to')
  expect(world.files.get(`${DIR}/01/summary.md`)).toBe(noHeader.trim())
  expect(world.submitted).toEqual([longSummary('another session entirely'), `${LONG}\nPasted back after the edit was closed.`])
})

test("a Remote Control prompt passes and leaves the terminal's open edit open", async ($, on) => {
  const world = setup(on)
  const writes = watchState(on)
  await $.session.start(START)
  await $.session.compact({ trigger: 'auto', messages: BEFORE })
  await openEdit($, world)

  const phone = await $.prompt.submit({ text: 'status?', wait: false, origin: { kind: 'bridge' } })
  const edit = await submit($, world, `${SUMMARY}\nEdited after the phone's prompt.`)

  expect(phone.drop).toBeUndefined()
  expect(writes.filter(w => w.key === 'editing').map(w => w.value)).toEqual([1, null])
  expect(edit.drop).toContain('saved to')
})

test('a prompt from another sender passes even with the header', async ($, on) => {
  const world = setup(on)
  await $.session.start(START)
  await $.session.compact({ trigger: 'auto', messages: BEFORE })

  const relayed = await $.prompt.submit({ text: buildEditDraft(1, 'x'), wait: false, origin: { kind: 'plugin', name: 'other' } })

  expect(relayed.drop).toBeUndefined()
  expect(world.submitted).toEqual([buildEditDraft(1, 'x')])
})

test('an empty edit applies nothing, and an edit of an older compaction, or with none, is kept aside under its own time', async ($, on) => {
  const world = setup(on)
  const writes = watchState(on)
  await $.session.start(START)
  const none = await submit($, world, `${editHeader(1)}\nbefore any compaction`)
  await $.session.compact({ trigger: 'auto', messages: BEFORE })
  await $.session.compact({ trigger: 'auto', messages: BEFORE })

  const empty = await submit($, world, `${editHeader(2)}\n   `)
  const stale = await submit($, world, `${editHeader(1)}\nan old edit`)
  await world.clock.advance(EDIT_CLEAR_DELAY_MS)

  expect(none.drop).toContain('no compaction has run')
  expect(empty.drop).toContain('empty')
  expect(stale.drop).toContain('#02 is the latest now')
  expect(world.files.get(`${DIR}/01/edit-unapplied-${STAMP}.md`)).toBe('before any compaction')
  expect(stale.drop).toContain(`${DIR}/01/edit-unapplied-${STAMP}-2.md`)
  expect(world.files.get(`${DIR}/01/edit-unapplied-${STAMP}-2.md`)).toBe('an old edit')
  expect(world.files.get(`${DIR}/02/summary.md`)).toBe(SUMMARY)
  expect(writes.some(w => w.key === 'pendingApply' && w.value === true)).toBe(false)
  expect(world.compactions).toBe(2)
  expect(world.submitted).toEqual([])
})

test('when saving fails, the edit is kept out of the model and in a file of its own, the reason reads plainly, and the next prompt passes', async ($, on) => {
  let isDiskFull = false
  const world = setup(on, { failWrite: path => isDiskFull && path === `${DIR}/01/summary.md` })
  await $.session.start(START)
  await $.session.compact({ trigger: 'auto', messages: BEFORE })
  await openEdit($, world)
  isDiskFull = true

  const result = await submit($, world, `${SUMMARY}\nThe header line was deleted.`)

  // The kit reports a test hook's throw as a missing implementation; the reason is the engine's text either way.
  expect(result.drop).toMatch(/could not be saved \(.+\), so nothing was applied/)
  expect(result.drop).not.toContain('[object Object]')
  expect(result.drop).toContain(`${DIR}/edit-unsaved-${STAMP_AFTER_EDIT}.md`)
  expect(world.files.get(`${DIR}/edit-unsaved-${STAMP_AFTER_EDIT}.md`)).toBe(`${SUMMARY}\nThe header line was deleted.`)
  expect(world.submitted).toEqual([])

  const again = await submit($, world, `${editHeader(1)}\nA second try in the same millisecond.`)
  const hello = await submit($, world, 'hello?')

  expect(again.drop).toContain(`${DIR}/edit-unsaved-${STAMP_AFTER_EDIT}-2.md`)
  expect(world.files.get(`${DIR}/edit-unsaved-${STAMP_AFTER_EDIT}.md`)).toBe(`${SUMMARY}\nThe header line was deleted.`)
  expect(world.files.get(`${DIR}/edit-unsaved-${STAMP_AFTER_EDIT}-2.md`)).toBe(`${editHeader(1)}\nA second try in the same millisecond.`)
  expect(hello.drop).toBeUndefined()
  expect(world.submitted).toEqual(['hello?'])
})

test("the box is never overwritten: a draft of the person's own, or an edit in progress, stays", async ($, on) => {
  const world = setup(on)
  await $.session.start(START)
  await $.session.compact({ trigger: 'auto', messages: BEFORE })
  world.box = 'half a prompt'

  await openEdit($, world)
  expect(world.box).toBe('half a prompt')
  expect(world.toasts.at(-1)).toContain('holds a draft of yours')

  world.box = `${editHeader(1)}\nhalfway through an edit`
  await openEdit($, world)
  expect(world.box).toBe(`${editHeader(1)}\nhalfway through an edit`)
  expect(world.toasts.at(-1)).toContain('an edit is already in the prompt box')
})

test('a box that refuses the fill opens no edit and says to edit the file instead', async ($, on) => {
  const world = setup(on, { fillRefusal: 'dialog' })
  const writes = watchState(on)
  await $.session.start(START)
  await $.session.compact({ trigger: 'auto', messages: BEFORE })

  await openEdit($, world)

  // The engine strips the cause a hook gives for a refusal (PromptFillResult); only its own refusals carry one.
  expect(world.toasts.at(-1)).toContain('did not take the summary;')
  expect(world.toasts.at(-1)).toContain(`${DIR}/01/summary.md`)
  expect(writes.some(w => w.key === 'editing')).toBe(false)
})

test("the pane's Edit summary button puts the summary in the box at once", async ($, on) => {
  const world = setup(on)
  await $.session.start(START)
  await $.session.compact({ trigger: 'auto', messages: BEFORE })
  const ui = await $.ui.mount({
    plugin: 'compact-lens',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'compact-lens',
    props: { title: 'Compact Lens', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })

  await ui.press({ key: 'edit' })
  await world.clock.settle()

  expect(world.box).toBe(buildEditDraft(1, SUMMARY))
  expect(world.toasts.at(-1)).toContain('the summary is in the prompt box')
  await ui.unmount()
})

test('an edit put back to the summary in use drops an apply that waited with other text, and restores summary.md', async ($, on) => {
  const world = setup(on)
  const writes = watchState(on)
  await $.session.start(START)
  const first = await $.session.compact({ trigger: 'auto', messages: BEFORE })
  world.transcript = [...(first.messages ?? [])]
  world.files.set(`${DIR}/01/summary.md`, `${SUMMARY}\nThe model's edit.`)
  await $.tool.call({ tool: 'mcp__compact-lens__apply' })
  expect(last(writes, 'pendingApply')).toBe(true)

  const result = await submit($, world, `${editHeader(1)}\n${SUMMARY}`)
  const compacted = await $.session.compact({ trigger: 'manual', messages: first.messages ?? [] })

  expect(result.drop).toContain('the apply that waited with other text is dropped')
  expect(world.files.get(`${DIR}/01/summary.md`)).toBe(SUMMARY)
  expect(last(writes, 'pendingApply')).toBe(false)
  expect(compacted.messages?.[0]?.text).toBe(SUMMARY)
  expect(world.compactions).toBe(2)
})
