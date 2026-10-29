import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { SYNC_DELAY_MS } from '../hooks/paths'
import { INDEX_SCRIPT, SEARCH_SCRIPT } from '../hooks/reader'
import { hashOf } from '../hooks/records'
import { BEFORE, DIR, HOME, RECALL, SESSION, setup, START, SUMMARY, TRANSCRIPT, user, writeFile, writeTranscript } from './kit'
import { APPLIED_SUMMARY, appliedCompactions, boundary, call, prompt, SPAN_ONE_PROMPT, summary, SUMMARY_TWO, twoCompactions } from './rows'

const PRESENTATION = { isFullscreen: true, columns: 120 }
const run = ($: Engine, args: string) => $.command.run({ command: 'compact-lens', args, origin: { kind: 'composer' }, presentation: PRESENTATION })

test('compactions that ran before the mod loaded are counted from the transcript, and the latest summary is ready to edit', async ($, on) => {
  const world = setup(on)
  writeTranscript(world, twoCompactions())

  await $.session.start(START)
  const listed = await run($, 'list')

  expect(world.status).toBe('compact-lens: – · 2 compactions · 0 pinned')
  expect(world.toasts).toContain("found 2 earlier compactions in this session's transcript; /compact-lens shows what each one dropped")
  expect(listed.text).toContain('compactions (2):')
  expect(listed.text).toContain(`  #1 auto 2026-10-20 10:06 UTC: 180k → 20k tokens; from the transcript, not read yet (/compact-lens lost 1 reads it); ${DIR}/01`)
  expect(listed.text).toContain('  #2 manual 2026-10-20 10:13 UTC: 175k → 20k tokens; from the transcript, not read yet')
  expect(world.files.get(`${DIR}/02/summary.md`)).toBe(SUMMARY_TWO)
  expect(world.files.has(`${DIR}/01/summary.md`)).toBe(false)
})

test('the summary written from the transcript gets a mark of its text beside it, so a prune can tell an edit of it', async ($, on) => {
  const world = setup(on)
  writeTranscript(world, twoCompactions())

  await $.session.start(START)

  expect(world.files.get(`${DIR}/02/summary.md`)).toBe(SUMMARY_TWO)
  expect(world.files.get(`${DIR}/02/summary.hash`)).toBe(hashOf(SUMMARY_TWO))
})

test('a compaction whose folder went, as a prune from another session removes it, is read again from the transcript when asked for', async ($, on) => {
  const world = setup(on)
  writeTranscript(world, twoCompactions())
  await $.session.start(START)
  const first = await run($, 'lost 1')
  for (const path of [...world.files.keys()].filter(key => key.startsWith(`${DIR}/01/`))) world.files.delete(path)

  const again = await run($, 'lost 1')

  expect(again.text).toBe(first.text)
  expect(world.files.has(`${DIR}/01/lost.md`)).toBe(true)
})

test('a summary.md already there, as an edit made in an earlier run, is left as it is and gets no mark', async ($, on) => {
  const world = setup(on)
  writeTranscript(world, twoCompactions())
  writeFile(world, `${DIR}/02/summary.md`, 'the summary, as the person rewrote it')

  await $.session.start(START)

  expect(world.files.get(`${DIR}/02/summary.md`)).toBe('the summary, as the person rewrote it')
  expect(world.files.has(`${DIR}/02/summary.hash`)).toBe(false)
})

test("a moment after the start the latest compaction's lost report is read in the background, and nothing is read twice", async ($, on) => {
  const world = setup(on)
  writeTranscript(world, twoCompactions())
  await $.session.start(START)
  const spawnsAtStart = world.spawned.length

  await world.clock.advance(SYNC_DELAY_MS)
  const afterRead = world.spawned.length
  await run($, 'list')

  expect(world.files.get(`${DIR}/02/lost.md`)).toContain('# What compaction #2 (manual) dropped')
  expect(JSON.parse(world.files.get(`${DIR}/02/meta.json`) ?? '{}').hasDetail).toBe(true)
  expect(world.files.has(`${DIR}/01/lost.md`)).toBe(false)
  expect(afterRead).toBeGreaterThan(spawnsAtStart)
  expect(world.spawned.length).toBe(afterRead)
})

test("a compaction the hook records takes the transcript's next number, and gets its lines once the engine writes its boundary", async ($, on) => {
  const world = setup(on)
  writeTranscript(world, twoCompactions())
  await $.session.start(START)

  const result = await $.session.compact({ trigger: 'auto', messages: BEFORE })
  writeTranscript(world, [...twoCompactions(), boundary(16, 'auto', 90000), summary(17, SUMMARY)])
  await world.clock.advance(SYNC_DELAY_MS)
  const listed = await run($, 'list')

  expect(result.messages?.[1]?.text).toContain('<compact-lens n="3" trigger="auto">')
  expect(world.files.get(`${DIR}/03/summary.md`)).toBe(SUMMARY)
  expect(listed.text).toContain('compactions (3):')
  expect(listed.text).toContain('#3 auto')
  expect(listed.text).toContain('seen live')
  expect(JSON.parse(world.files.get(`${DIR}/03/meta.json`) ?? '{}').n).toBe(3)
})

test("a compaction that ran without the mod's hook is recorded from the transcript when the engine reports it, and the person is told", async ($, on) => {
  const world = setup(on)
  writeTranscript(world, twoCompactions())
  await $.session.start(START)

  writeTranscript(world, [...twoCompactions(), prompt(16, 'one more'), boundary(17, 'manual', 60000), summary(18, `${SUMMARY_TWO} Then one more.`)])
  await $.classic.PostCompact({ trigger: 'manual', compact_summary: `${SUMMARY_TWO} Then one more.`, transcript_path: TRANSCRIPT })
  await world.clock.advance(SYNC_DELAY_MS)

  expect(world.toasts).toContain("compaction #3 (manual) ran without the mod's hook; it is recorded from the transcript. /compact-lens lost 3 shows what it dropped")
  expect(world.status).toBe('compact-lens: – · 3 compactions · 0 pinned')
  expect(world.files.get(`${DIR}/03/summary.md`)).toBe(`${SUMMARY_TWO} Then one more.`)
})

test('a /resume moves the mod to the resumed session: its values start over, and its own compactions are read from its transcript', async ($, on) => {
  const world = setup(on)
  writeTranscript(world, twoCompactions())
  await $.session.start(START)
  const other = `${HOME}/.claude/projects/-repo/sess-2.jsonl`
  writeTranscript(world, [prompt(1, 'an older session'), boundary(2, 'auto', 100000), summary(3, SUMMARY)], other)

  world.sessionId = 'sess-2'
  await $.classic.SessionStart({ source: 'resume', transcript_path: other })
  await world.clock.advance(SYNC_DELAY_MS)
  const listed = await run($, 'list')

  expect(listed.text).toContain('compactions (1):')
  expect(listed.text).toContain(`${HOME}/.claude/compact-lens/sess-2/01`)
  expect(world.status).toBe('compact-lens: – · 1 compaction · 0 pinned')
  expect(world.files.get(`${HOME}/.claude/compact-lens/sess-2/01/summary.md`)).toBe(SUMMARY)
})

test('a /clear, with no session.start after it, is noticed at the next command: the new session has no compactions, and no transcript yet is no failure', async ($, on) => {
  const world = setup(on)
  writeTranscript(world, twoCompactions())
  await $.session.start(START)

  world.sessionId = 'sess-cleared'
  const listed = await run($, 'list')
  const status = await run($, 'status')
  const recalled = await $.tool.call({ tool: RECALL, query: 'canary' })

  expect(listed.text).toContain('compactions (0):')
  expect(listed.text).toContain('none yet')
  expect(status.text).not.toContain('could not be read')
  expect(recalled.deny).toContain('no compaction has run yet')
})

test('a new session, whose transcript the engine names before writing it, is no failure, and its compactions are counted once it exists', async ($, on) => {
  const world = setup(on)
  await $.classic.SessionStart({ source: 'startup', transcript_path: TRANSCRIPT })
  await $.session.start(START)

  const before = await run($, 'status')
  writeTranscript(world, twoCompactions())
  const after = await run($, 'list')

  expect(before.text).not.toContain('could not be read')
  expect(world.logs.some(line => line.includes('could not be read'))).toBe(false)
  expect(after.text).toContain('compactions (2):')
})

test("a row that holds the boundary's text in a tool's input is no boundary: the count stays right", async ($, on) => {
  const world = setup(on)
  const decoy = call(1, 'm0', 't0', 'mcp__notes__save', { subtype: 'compact_boundary', note: 'not a compaction' })
  writeTranscript(world, [decoy, prompt(2, SPAN_ONE_PROMPT), boundary(3, 'auto', 50000), summary(4, SUMMARY)])

  await $.session.start(START)
  const listed = await run($, 'list')

  expect(world.files.get(TRANSCRIPT)?.split('\n')[0]).toContain('"subtype":"compact_boundary"')
  expect(listed.text).toContain('compactions (1):')
  expect(listed.text).toContain('#1 auto 2026-10-20 10:03 UTC')
})

test('the transcript is only ever read, by perl with its fixed scripts and sed, and every command names the transcript file last', async ($, on) => {
  const world = setup(on)
  writeTranscript(world, twoCompactions())
  await $.session.start(START)
  await world.clock.advance(SYNC_DELAY_MS)
  await run($, 'lost 1')
  await run($, 'restore 2')
  await run($, 'restore -canary')

  // Beside the transcript's readers, the start makes the snapshot root private, and nothing else runs.
  const readers = world.spawned.filter(argv => argv[0] !== '/bin/mkdir' && argv[0] !== '/bin/chmod')
  expect(world.spawned.filter(argv => !readers.includes(argv))).toEqual([
    ['/bin/mkdir', '-p', '-m', '700', `${HOME}/.claude/compact-lens`],
    ['/bin/chmod', '700', `${HOME}/.claude/compact-lens`],
  ])
  expect(readers.length).toBeGreaterThan(0)
  for (const argv of readers) {
    expect(['perl', 'sed']).toContain(argv[0])
    expect(argv.at(-1)).toBe(TRANSCRIPT)
    if (argv[0] === 'perl') expect([INDEX_SCRIPT, SEARCH_SCRIPT]).toContain(argv[2])
    if (argv[0] === 'perl') expect(argv[3]).toBe('--')
    if (argv[0] === 'sed') expect(argv.some(arg => arg.startsWith('-i'))).toBe(false)
  }
  expect(world.spawned.some(argv => argv[0] === 'perl' && argv[4] === '-canary')).toBe(true)
})

test('without perl on the host, grep finds the same compactions and passages', async ($, on) => {
  const world = setup(on, { perl: false })
  writeTranscript(world, twoCompactions())
  await $.session.start(START)

  const listed = await run($, 'list')
  const found = await run($, 'restore canary-42')

  expect(listed.text).toContain('compactions (2):')
  expect(found.text).toContain('Claude now has 1 passage mentioning "canary-42"')
  expect(world.spawned.some(argv => argv[0] === 'grep' && argv.includes('-e') && argv.includes('canary-42'))).toBe(true)
  for (const argv of world.spawned.filter(one => one[0] === 'grep')) expect(argv.at(-1)).toBe(TRANSCRIPT)
})

test('where no process can run, the mod counts what its hook saw and adopts the summary in use, as before', async ($, on) => {
  const world = setup(on, { processes: false })
  writeTranscript(world, twoCompactions())
  await $.session.start(START)

  const status = await run($, 'status')
  await $.session.compact({ trigger: 'auto', messages: BEFORE })
  const listed = await run($, 'list')

  expect(status.text).toContain("the session's transcript could not be read here")
  expect(listed.text).toContain('compactions (1):')
  expect(listed.text).toContain('#1 auto')
})

test('back in a session after a /clear, its compactions are read again, though its transcript did not change', async ($, on) => {
  const world = setup(on)
  writeTranscript(world, twoCompactions())
  await $.session.start(START)

  world.sessionId = 'sess-cleared'
  await run($, 'list')
  world.sessionId = SESSION
  await $.classic.SessionStart({ source: 'resume', transcript_path: TRANSCRIPT })
  const listed = await run($, 'list')

  expect(listed.text).toContain('compactions (2):')
})

/** A record as compact-lens 0.3.0 wrote it for a compaction it did not see: the summary in use, numbered one past its last. */
const unseenRecord = (n: number, summaryText: string, dir: string) => ({
  n,
  trigger: 'unseen',
  at: '2026-10-20T10:20:00.000Z',
  dir,
  messagesBefore: 0,
  messagesAfter: 1,
  charsBefore: 0,
  charsAfter: summaryText.length,
  tokensBefore: null,
  tokensAfter: null,
  summaryHead: summaryText.slice(0, 400),
  promptsInSpan: 0,
  filesInSpan: 0,
  identifiersLost: 0,
})

test("an unseen compaction an earlier version numbered apart from the transcript keeps its files: they are never written over from another compaction's lines", async ($, on) => {
  const world = setup(on)
  writeTranscript(world, twoCompactions())
  // An earlier build of 0.4.0 gave every held record the lines of its number; the host keeps values across a reload.
  const spanned = { ...unseenRecord(1, SUMMARY_TWO, `${DIR}/01`), span: { from: 1, to: 5, boundary: 6, summary: 7 } }
  writeFile(world, `${DIR}/01/meta.json`, JSON.stringify(spanned))
  writeFile(world, `${DIR}/01/summary.md`, SUMMARY_TWO)
  writeFile(world, `${DIR}/01/before.md`, 'what 0.3.0 wrote')
  await $.session.start(START)

  const lost = await run($, 'lost 1')
  writeTranscript(world, [...twoCompactions(), prompt(16, 'one more prompt')])
  const listed = await run($, 'list')

  expect(lost.text).toContain('numbered apart from the transcript')
  expect(world.files.get(`${DIR}/01/before.md`)).toBe('what 0.3.0 wrote')
  expect(world.files.get(`${DIR}/01/summary.md`)).toBe(SUMMARY_TWO)
  expect(listed.text).toContain('compactions (2):')
  expect(world.logs.filter(line => line.includes('under another number')).length).toBe(1)
})

test("records an earlier version left in the session's values for another session are not taken for this one's", async ($, on) => {
  const world = setup(on)
  writeTranscript(world, twoCompactions())
  const foreign = unseenRecord(1, SUMMARY_TWO, `${HOME}/.claude/compact-lens/another-session/01`)
  let isSeeded = true
  on('state.get', ($, e, next) => (isSeeded && e.key === 'compactions' ? { value: { value: [foreign], version: 1 } } : next(e)))
  on('state.set', ($, e, next) => {
    if (e.key === 'compactions') isSeeded = false
    return next(e)
  })
  await $.session.start(START)

  const listed = await run($, 'list')

  expect(listed.text).toContain('#1 auto 2026-10-20 10:06 UTC: 180k → 20k tokens; from the transcript')
  expect(listed.text).not.toContain('another-session')
})

test('a write that fails while the transcript is read neither loses the count nor numbers the summary in use apart from it', async ($, on) => {
  let isDiskFull = true
  const world = setup(on, { failWrite: path => isDiskFull && path === `${DIR}/02/summary.md` })
  writeTranscript(world, twoCompactions())
  world.transcript = [user(SUMMARY_TWO, 'h-sum')]
  await $.session.start(START)

  const listed = await run($, 'list')
  isDiskFull = false
  writeTranscript(world, [...twoCompactions(), prompt(16, 'one more prompt')])
  await run($, 'list')

  expect(listed.text).toContain('compactions (2):')
  expect(listed.text).not.toContain('unseen')
  expect(world.files.get(`${DIR}/02/summary.md`)).toBe(SUMMARY_TWO)
})

test("a tool's input that holds the summary's mark is no summary row: an apply's own summary is still read", async ($, on) => {
  const world = setup(on)
  const rows = appliedCompactions()
  const decoy = call(11, 'm9', 't9', 'mcp__notes__save', { isCompactSummary: true, note: 'not a summary' })
  writeTranscript(world, [...rows.slice(0, 10), decoy, ...rows.slice(10, 12)])
  await $.session.start(START)

  await run($, 'list')

  expect(world.files.get(`${DIR}/02/summary.md`)).toBe(APPLIED_SUMMARY)
})

test('a read that breaks part way leaves the count to the next look, and never numbers the summary in use apart from the transcript', async ($, on) => {
  let isSedBroken = true
  const world = setup(on, { sedFails: () => isSedBroken })
  writeTranscript(world, twoCompactions())
  world.transcript = [user(SUMMARY_TWO, 'h-sum')]
  await $.session.start(START)

  const broken = await run($, 'list')
  isSedBroken = false
  const fixed = await run($, 'list')

  expect(broken.text).not.toContain('unseen')
  expect(fixed.text).toContain('compactions (2):')
  expect(world.logs.some(line => line.includes('the next look tries again'))).toBe(true)
})
