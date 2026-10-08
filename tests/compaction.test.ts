import { expect, test } from 'claude-code/testing'

import { summaryIn } from '../hooks/records'
import { APPLY, BEFORE, DIR, ENGINE_ANSWER, KEEP, KEPT, last, SESSION, setup, START, SUMMARY, UNSEEN_SUMMARY, user, watchState } from './kit'

const PRESENTATION = { isFullscreen: true, columns: 120 }

test('a compaction is snapshotted, its note inserted after the summary, the kept message untouched', async ($, on) => {
  const world = setup(on)
  await $.session.start(START)

  const result = await $.session.compact({ trigger: 'auto', messages: BEFORE })

  expect(result.skip).toBeUndefined()
  const messages = result.messages ?? []
  expect(messages.length).toBe(3)
  expect(messages[0]?.text).toBe(SUMMARY)
  expect(messages[0]?.handle).toBe('h-sum')
  expect(messages[1]?.role).toBe('user')
  expect(messages[1]?.text).toContain('<compact-lens n="1" trigger="auto">')
  expect(messages[1]?.text).toContain(`${DIR}/01/before.md`)
  expect(messages[1]?.text).toContain(`${DIR}/01/lost.md`)
  expect(messages[1]?.text).toContain(`${DIR}/01/summary.md`)
  expect(messages[1]?.text).toContain('6 messages (90k tokens) went in')
  expect(messages[2]).toEqual(KEPT)
  expect(world.compactions).toBe(1)
})

test('the snapshots hold the transcript, the summary, the record and the lost report', async ($, on) => {
  const world = setup(on)
  await $.session.start(START)

  await $.session.compact({ trigger: 'manual', messages: BEFORE, instructions: 'stress the tests' })

  const before = world.files.get(`${DIR}/01/before.md`) ?? ''
  expect(before).toContain('# before — compaction #1 (manual)')
  expect(before).toContain('## 1 · user')
  expect(before).toContain('### tool Edit (t2)')
  expect(before).toContain('npm test -- --runInBand')
  expect(JSON.parse(world.files.get(`${DIR}/01/before.json`) ?? '[]').length).toBe(6)
  expect(world.files.get(`${DIR}/01/summary.md`)).toBe(SUMMARY)
  const meta = JSON.parse(world.files.get(`${DIR}/01/meta.json`) ?? '{}')
  expect(meta.n).toBe(1)
  expect(meta.trigger).toBe('manual')
  expect(meta.tokensBefore).toBe(90000)
  expect(meta.messagesBefore).toBe(6)
  expect(meta.messagesAfter).toBe(2)
  const lost = world.files.get(`${DIR}/01/lost.md`) ?? ''
  expect(lost).toContain('Please fix the bug in src/app.ts')
  expect(lost).toContain('- /repo/src/app.ts')
  expect(lost).toContain('npm test -- --runInBand')
  expect(lost).toContain('deadbeef1')
  expect(lost).toContain('MAX_RETRIES')
  expect(lost).toContain('https://example.com/pr/42')
  const after = world.files.get(`${DIR}/01/after.md`) ?? ''
  expect(after).toContain('# after — compaction #1 (manual)')
  expect(after).toContain(SUMMARY)
})

test('pinned notes reach the summariser and the note verbatim, and the person can pin and list', async ($, on) => {
  const world = setup(on)
  await $.session.start(START)

  const pinned = await $.tool.call({ tool: KEEP, note: 'The release tag is v1.4.2' })
  expect(pinned.deny).toBeUndefined()
  expect(String(pinned.result)).toContain('Pinned note 1')
  const empty = await $.tool.call({ tool: KEEP, note: '   ' })
  expect(empty.deny).toContain('empty')
  const typed = await $.command.run({ command: 'compact-lens', args: 'keep The port is 8080', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(typed.text).toContain('pinned note 2 (2 pinned)')
  expect(world.files.get(`${DIR}/pinned.md`)).toContain('2. The port is 8080')

  const result = await $.session.compact({ trigger: 'auto', messages: BEFORE, instructions: 'keep the branch' })

  const instructions = world.instructions[0] ?? ''
  expect(instructions).toContain('keep the branch')
  expect(instructions).toContain('- The release tag is v1.4.2')
  expect(instructions).toContain('- The port is 8080')
  expect(result.messages?.[1]?.text).toContain('1. The release tag is v1.4.2')
  expect(result.messages?.[1]?.text).toContain('2. The port is 8080')
  const listed = await $.command.run({ command: 'compact-lens', args: 'list', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(listed.text).toContain('#1 auto')
  expect(listed.text).toContain('pinned (2)')
  const removed = await $.command.run({ command: 'compact-lens', args: 'unpin 1', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(removed.text).toContain('note 1 removed')
  expect(world.files.get(`${DIR}/pinned.md`)).not.toContain('v1.4.2')
})

test('pins and records are mirrored to the store under the session id', async ($, on) => {
  setup(on, { store: false })
  const stored = new Map<string, unknown>()
  on('store.get', ($, e) => ({ value: stored.get(e.key) }))
  on('store.set', ($, e) => {
    stored.set(e.key, e.value)
    return { value: undefined }
  })
  await $.session.start(START)

  await $.tool.call({ tool: KEEP, note: 'Keep me' })
  await $.session.compact({ trigger: 'auto', messages: BEFORE })

  const held = stored.get(`session:${SESSION}`) as { pinned: Array<{ text: string }>; compactions: Array<{ n: number }> }
  expect(held.pinned[0]?.text).toBe('Keep me')
  expect(held.compactions[0]?.n).toBe(1)
})

test("the person's /compact with an edit waiting replaces the summary with summary.md and never calls the summariser", async ($, on) => {
  const world = setup(on)
  const writes = watchState(on)
  await $.session.start(START)
  const first = await $.session.compact({ trigger: 'auto', messages: BEFORE })
  const current = (first.messages ?? []).map(m => ({ ...m, handle: m.handle ?? `h-${m.text.length}` }))
  world.transcript = current
  const edited = `${SUMMARY}\n\nEdited by hand: the commit is deadbeef1 and MAX_RETRIES is 5.`
  world.files.set(`${DIR}/01/summary.md`, edited)

  const asked = await $.tool.call({ tool: APPLY })
  expect(asked.deny).toBeUndefined()
  const applied = await $.session.compact({ trigger: 'manual', messages: current })

  expect(applied.skip).toBeUndefined()
  const messages = applied.messages ?? []
  expect(messages[0]?.text).toBe(edited)
  expect(messages[0]?.handle).toBeUndefined()
  expect(messages[1]?.text).toContain('<compact-lens n="2" trigger="apply">')
  expect(messages[2]?.text).toContain('<compact-lens n="1" trigger="auto">')
  expect(messages[3]).toEqual(current[2])
  expect(world.compactions).toBe(1)
  expect(world.files.get(`${DIR}/02/summary.md`)).toBe(edited)
  expect(JSON.parse(world.files.get(`${DIR}/02/meta.json`) ?? '{}').trigger).toBe('apply')
  expect(last(writes, 'pendingApply')).toBe(false)
  expect(world.toasts.at(-1)).toContain('your edited summary is in place (#02)')
})

test('a waiting edit reverted before /compact is skipped, and an automatic or plugin compaction runs over it and drops it', async ($, on) => {
  const world = setup(on)
  const writes = watchState(on)
  await $.session.start(START)
  const first = await $.session.compact({ trigger: 'auto', messages: BEFORE })
  world.transcript = [...(first.messages ?? [])]
  world.files.set(`${DIR}/01/summary.md`, `${SUMMARY}\nEdited.`)
  await $.tool.call({ tool: APPLY })
  world.files.set(`${DIR}/01/summary.md`, SUMMARY)

  const reverted = await $.session.compact({ trigger: 'manual', messages: first.messages ?? [] })
  expect(reverted.skip).toContain('is the summary in use')
  expect(last(writes, 'pendingApply')).toBe(false)
  expect(world.compactions).toBe(1)

  world.files.set(`${DIR}/01/summary.md`, `${SUMMARY}\nEdited again.`)
  await $.tool.call({ tool: APPLY })
  const auto = await $.session.compact({ trigger: 'auto', messages: first.messages ?? [] })
  expect(auto.skip).toBeUndefined()
  expect(world.compactions).toBe(2)
  expect(last(writes, 'pendingApply')).toBe(false)
  expect(world.toasts.at(-1)).toContain('a compaction ran before the edited summary was applied')

  world.files.set(`${DIR}/02/summary.md`, `${SUMMARY}\nA third edit.`)
  world.transcript = [...(auto.messages ?? [])]
  await $.tool.call({ tool: APPLY })
  await $.session.compact({ trigger: 'plugin', messages: auto.messages ?? [] })
  expect(world.compactions).toBe(3)
  expect(last(writes, 'pendingApply')).toBe(false)
})

test('a summary the conversation runs on but the mod never recorded is adopted as an unseen compaction, once', async ($, on) => {
  const world = setup(on)
  await $.session.start(START)
  world.transcript = [user(UNSEEN_SUMMARY, 'h-u'), KEPT, user('and then a prompt', 'h-p')]

  const listed = await $.command.run({ command: 'compact-lens', args: 'list', origin: { kind: 'composer' }, presentation: PRESENTATION })
  const again = await $.command.run({ command: 'compact-lens', args: 'list', origin: { kind: 'composer' }, presentation: PRESENTATION })

  expect(listed.text).toContain('compactions (1):')
  expect(listed.text).toContain('#1 unseen')
  expect(again.text).toContain('compactions (1):')
  expect(world.files.get(`${DIR}/01/summary.md`)).toBe(UNSEEN_SUMMARY)
  expect(world.files.get(`${DIR}/01/before.md`)).toContain('did not see this compaction run')
  expect(world.files.get(`${DIR}/01/after.md`)).toContain('and then a prompt')
  const meta = JSON.parse(world.files.get(`${DIR}/01/meta.json`) ?? '{}')
  expect(meta.trigger).toBe('unseen')
  expect(meta.messagesAfter).toBe(3)

  world.files.set(`${DIR}/01/summary.md`, `${UNSEEN_SUMMARY} Edited.`)
  await $.tool.call({ tool: APPLY })
  const applied = await $.session.compact({ trigger: 'manual', messages: world.transcript })
  expect(applied.messages?.[0]?.text).toBe(`${UNSEEN_SUMMARY} Edited.`)
  expect(world.compactions).toBe(0)
})

test('a recorded summary is never adopted again, and a conversation with no summary adopts nothing', async ($, on) => {
  const world = setup(on)
  await $.session.start(START)
  world.transcript = [...BEFORE]
  const none = await $.command.run({ command: 'compact-lens', args: 'list', origin: { kind: 'composer' }, presentation: PRESENTATION })
  expect(none.text).toContain('compactions (0):')

  const first = await $.session.compact({ trigger: 'auto', messages: BEFORE })
  world.transcript = [...(first.messages ?? [])]
  const one = await $.command.run({ command: 'compact-lens', args: 'list', origin: { kind: 'composer' }, presentation: PRESENTATION })
  expect(one.text).toContain('compactions (1):')
  expect(one.text).not.toContain('unseen')
})

test('a precomputed summary is kept as a draft, and an edited draft becomes the summary when the engine reuses it', async ($, on) => {
  const world = setup(on)
  await $.session.start(START)

  const draft = await $.session.compact({ trigger: 'precompute', messages: BEFORE })
  expect(draft.messages?.[0]?.text).toBe(SUMMARY)
  expect(world.files.get(`${DIR}/draft.md`)).toBe(SUMMARY)
  world.files.set(`${DIR}/draft.md`, `${SUMMARY}\nEdited before it landed.`)

  const real = await $.session.compact({ trigger: 'auto', messages: BEFORE })

  expect(real.messages?.[0]?.text).toBe(`${SUMMARY}\nEdited before it landed.`)
  expect(real.messages?.[0]?.handle).toBeUndefined()
  expect(world.files.get(`${DIR}/01/summary.md`)).toBe(`${SUMMARY}\nEdited before it landed.`)
  expect(world.files.get(`${DIR}/draft.md`)).toBe('')
})

test("an edited draft the engine passed over is kept beside the record, not wiped, and a later precompute leaves an edit alone", async ($, on) => {
  const world = setup(on, { answer: e => (e.trigger === 'precompute' ? ENGINE_ANSWER() : { messages: [user('A newer summary, after more messages.', 'h-new')] }) })
  await $.session.start(START)

  await $.session.compact({ trigger: 'precompute', messages: BEFORE })
  world.files.set(`${DIR}/draft.md`, 'My own wording of the summary.')
  await $.session.compact({ trigger: 'precompute', messages: BEFORE })
  expect(world.files.get(`${DIR}/draft.md`)).toBe('My own wording of the summary.')

  const real = await $.session.compact({ trigger: 'auto', messages: [...BEFORE, { role: 'user', text: 'one more prompt', toolUses: [] }] })

  expect(real.messages?.[0]?.text).toBe('A newer summary, after more messages.')
  expect(real.messages?.[0]?.handle).toBe('h-new')
  expect(world.files.get(`${DIR}/01/draft-unused.md`)).toBe('My own wording of the summary.')
  expect(world.files.get(`${DIR}/draft.md`)).toBe('')
})

test("a subagent's compaction and a skipped one pass through untouched", async ($, on) => {
  const world = setup(on, { answer: e => (e.agentId === undefined ? { skip: 'blocked by a PreCompact hook' } : { messages: [KEPT] }) })
  await $.session.start(START)

  const sub = await $.session.compact({ trigger: 'auto', messages: BEFORE, agentId: 'agent-7' })
  expect(sub.messages).toEqual([KEPT])
  const skipped = await $.session.compact({ trigger: 'auto', messages: BEFORE })
  expect(skipped.skip).toBe('blocked by a PreCompact hook')
  expect(world.files.has(`${DIR}/01/before.md`)).toBe(true)
  expect(world.files.has(`${DIR}/01/summary.md`)).toBe(false)
})

test('the system prompt gets the Compact Lens section only where the keep tool is offered', async ($, on) => {
  setup(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'INTRO', scope: 'shared' as const }] }))
  await $.session.start(START)
  const compose = (tools: string[]) =>
    $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools, outputStyle: null, traits: [] })

  const without = await compose(['Read'])
  expect(without.sections.length).toBe(1)
  const withTool = await compose(['Read', KEEP])
  expect(withTool.sections.length).toBe(2)
  expect(withTool.sections[1]?.id).toBe('compact-lens:lens')
  expect(withTool.sections[1]?.scope).toBe('session')
  expect(withTool.sections[1]?.text).toContain(`${DIR}/<nn>/`)
  expect(withTool.sections[1]?.text).toContain('Compactions so far: 0')

  await $.session.compact({ trigger: 'auto', messages: BEFORE })
  const after = await compose(['Read', KEEP])
  expect(after.sections[1]?.text).toContain(`Compactions so far: 1; latest: ${DIR}/01`)
})

test('with an edit waiting, a /compact that carries instructions compacts as usual and drops the edit', async ($, on) => {
  const world = setup(on)
  const writes = watchState(on)
  await $.session.start(START)
  const first = await $.session.compact({ trigger: 'auto', messages: BEFORE })
  world.transcript = [...(first.messages ?? [])]
  world.files.set(`${DIR}/01/summary.md`, `${SUMMARY}\nEdited.`)
  await $.tool.call({ tool: APPLY })
  expect(world.status).toContain('/compact applies the edit')

  const result = await $.session.compact({ trigger: 'manual', messages: first.messages ?? [], instructions: 'focus on the tests' })

  expect(result.skip).toBeUndefined()
  expect(world.compactions).toBe(2)
  expect(world.instructions.at(-1)).toBe('focus on the tests')
  expect(last(writes, 'pendingApply')).toBe(false)
  expect(world.status).not.toContain('applies the edit')
})

test('an apply that fails part way skips the compaction and keeps the edit waiting; the summariser never runs', async ($, on) => {
  let isDiskFull = false
  const world = setup(on, { failWrite: path => isDiskFull && path === `${DIR}/02/before.md` })
  const writes = watchState(on)
  await $.session.start(START)
  const first = await $.session.compact({ trigger: 'auto', messages: BEFORE })
  world.transcript = [...(first.messages ?? [])]
  world.files.set(`${DIR}/01/summary.md`, `${SUMMARY}\nEdited.`)
  await $.tool.call({ tool: APPLY })
  isDiskFull = true

  const failed = await $.session.compact({ trigger: 'manual', messages: first.messages ?? [] })

  expect(failed.skip).toContain('the edit could not be applied')
  expect(failed.skip).toContain('it still waits')
  expect(world.compactions).toBe(1)
  expect(last(writes, 'pendingApply')).toBe(true)
  isDiskFull = false
  const retried = await $.session.compact({ trigger: 'manual', messages: first.messages ?? [] })
  expect(retried.messages?.[0]?.text).toBe(`${SUMMARY}\nEdited.`)
  expect(world.compactions).toBe(1)
})

test('the apply replaces the summary itself: not a later prompt that pastes it, and not a newer summary that shares its opening', async ($, on) => {
  const world = setup(on)
  await $.session.start(START)
  const first = await $.session.compact({ trigger: 'auto', messages: BEFORE })
  const pasted = user(`${SUMMARY} And remember port 9999.`, 'h-paste')
  const current = [...(first.messages ?? []), pasted]
  world.transcript = current
  world.files.set(`${DIR}/01/summary.md`, `${SUMMARY}\nEdited.`)
  await $.tool.call({ tool: APPLY })

  const applied = await $.session.compact({ trigger: 'manual', messages: current })
  expect(applied.messages?.[0]?.text).toBe(`${SUMMARY}\nEdited.`)
  expect(applied.messages?.at(-1)).toEqual(pasted)

  const newer = user(`${SUMMARY} A newer summary the mod never saw opens the same way, with other facts.`, 'h-new')
  world.transcript = [newer, KEPT]
  const listed = await $.command.run({ command: 'compact-lens', args: 'list', origin: { kind: 'composer' }, presentation: PRESENTATION })
  expect(listed.text).toContain('#3 unseen')
})

test("a prompt that opens like a summary is never taken for one: the summary is the next request's first message", async ($, on) => {
  const world = setup(on)
  await $.session.start(START)
  const first = await $.session.compact({ trigger: 'auto', messages: BEFORE })
  world.transcript = [...(first.messages ?? []), user(`${UNSEEN_SUMMARY} My own rewrite, sent as a prompt.`, 'h-mine')]

  const listed = await $.command.run({ command: 'compact-lens', args: 'list', origin: { kind: 'composer' }, presentation: PRESENTATION })

  expect(listed.text).toContain('compactions (1):')
  expect(listed.text).not.toContain('unseen')
})

const api = (role: 'user' | 'assistant', ...texts: string[]) => ({ role, content: texts.map(text => ({ type: 'text', text })) })

test("the summary in use is the first opening block that opens as one: after a reminder or a context message, and without the mod's note merged into it", async () => {
  const rows = [user(UNSEEN_SUMMARY, 'h-s'), user('<compact-lens n="1">note</compact-lens>', 'h-n'), KEPT]

  expect(summaryIn([api('user', '<system-reminder>context</system-reminder>', UNSEEN_SUMMARY), api('assistant', 'x')], rows, [])).toBe(UNSEEN_SUMMARY)
  expect(summaryIn([api('user', 'a context message'), api('user', UNSEEN_SUMMARY), api('assistant', 'x')], rows, [])).toBe(UNSEEN_SUMMARY)
  expect(summaryIn([api('user', `${UNSEEN_SUMMARY}\n\n<compact-lens n="1">note</compact-lens>`)], rows, [])).toBe(UNSEEN_SUMMARY)
  expect(summaryIn([api('user', UNSEEN_SUMMARY, `${UNSEEN_SUMMARY} sent again as a prompt`)], rows, [])).toBe(UNSEEN_SUMMARY)
  expect(summaryIn([api('user', 'hello'), api('assistant', 'hi'), api('user', UNSEEN_SUMMARY)], rows, [])).toBeUndefined()
  expect(summaryIn([api('user', 'Edited opening.\nmore')], [], ['Edited opening.'])).toBe('Edited opening.\nmore')
  expect(summaryIn([], rows, [])).toBeUndefined()
})
