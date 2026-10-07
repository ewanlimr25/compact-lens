import { expect, test } from 'claude-code/testing'

import { APPLY, BEFORE, DIR, ENGINE_ANSWER, KEEP, KEPT, SESSION, setup, START, SUMMARY, user } from './kit'

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

test('apply replaces the summary with the edited summary.md and never calls the summariser', async ($, on) => {
  const world = setup(on)
  await $.session.start(START)
  const first = await $.session.compact({ trigger: 'auto', messages: BEFORE })
  const current = (first.messages ?? []).map(m => ({ ...m, handle: m.handle ?? `h-${m.text.length}` }))
  const edited = `${SUMMARY}\n\nEdited by hand: the commit is deadbeef1 and MAX_RETRIES is 5.`
  world.files.set(`${DIR}/01/summary.md`, edited)

  const asked = await $.tool.call({ tool: APPLY })
  expect(asked.deny).toBeUndefined()
  expect(String(asked.result)).toContain(`${DIR}/01/summary.md`)
  const applied = await $.session.compact({ trigger: 'plugin', messages: current })

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
})

test('apply with nothing to apply, or an unchanged file, skips and says why', async ($, on) => {
  const world = setup(on)
  await $.session.start(START)

  const nothing = await $.tool.call({ tool: APPLY })
  expect(nothing.deny).toContain('no compaction has run yet')

  const first = await $.session.compact({ trigger: 'auto', messages: BEFORE })
  await $.tool.call({ tool: APPLY })
  const unchanged = await $.session.compact({ trigger: 'plugin', messages: first.messages ?? [] })
  expect(unchanged.skip).toContain('unchanged')
  expect(world.compactions).toBe(1)

  const plain = await $.session.compact({ trigger: 'plugin', messages: BEFORE })
  expect(plain.skip).toBeUndefined()
  expect(world.compactions).toBe(2)
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
