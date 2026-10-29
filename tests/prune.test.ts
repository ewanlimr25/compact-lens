import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { PromptOrigin } from 'claude-code'

import { PRUNE_DELAY_MS, SUMMARY_HEAD_CHARS } from '../hooks/paths'
import { hashOf } from '../hooks/records'
import type { SetupOptions, World } from './kit'
import { HOME, setup, START } from './kit'

const PRESENTATION = { isFullscreen: true, columns: 120 }
const run = ($: Engine, args: string, origin: PromptOrigin = { kind: 'composer' }) => $.command.run({ command: 'compact-lens', args, origin, presentation: PRESENTATION })

const LENS = `${HOME}/.claude/compact-lens`
const PROJECTS = `${HOME}/.claude/projects`
/** The kit's clock starts here. */
const NOW = 1_700_000_000_000
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
/** Snapshots and a transcript untouched for 40 days. */
const OLD = '0b6f2c1e-1111-4222-8333-944445555666'
/** Snapshots from 5 days ago. */
const YOUNG = '1c7e3d2f-2222-4333-9444-a55556666777'
/** Old snapshots, but its transcript changed yesterday: a session still in use. */
const BUSY = '2d8f4e30-3333-4444-a555-b66667777888'
/** Old snapshots whose transcript is nowhere to be found: they may be the only copy. */
const ORPHAN = '3e905f41-4444-4555-b666-c77778888999'
/** A session id for a name, but nothing of the mod's in it. */
const STRANGER = '4fa16052-5555-4666-c777-d8888999aaaa'
/** A session id for a name and the mod's pinned.md, but a folder of someone else's beside it. */
const MIXED = '6bc38274-7777-4888-e999-faaaabbbbccc'
/** Old snapshots whose latest summary.md was edited and not applied yet. */
const EDITED = '7cd49385-8888-4999-faaa-0bbbbccccddd'
/** Old snapshots with a draft waiting in draft.md. */
const DRAFTED = '8de5a496-9999-4aaa-8bbb-1ccccddddeee'
/** Old snapshots and transcript, but its status-line script ran an hour ago: a session on screen. */
const SHOWN = '9ef6b5a7-aaaa-4bbb-9ccc-2ddddeeeefff'
/** An old pinned.md, but a compaction written yesterday. */
const FRESH = 'a0f7c6b8-bbbb-4ccc-addd-3eeeeffff000'

/** Claude Code's transcripts kept a year, so a transcript of a few weeks is still there; a test of cleanupPeriodDays sets its own. */
const setupPrune = (on: Parameters<typeof setup>[0], options?: SetupOptions): World => {
  const world = setup(on, options)
  world.settings = { cleanupPeriodDays: 365 }
  return world
}

const place = (world: World, path: string, text: string, ageDays: number): void => {
  world.files.set(path, text)
  world.mtimes.set(path, NOW - ageDays * DAY_MS)
}

/** A session folder of the mod's, its files `ageDays` old, and the session's transcript `transcriptAge` days old (none when undefined). */
const session = (world: World, id: string, ageDays: number, transcriptAge: number | undefined, projects = PROJECTS): void => {
  place(world, `${LENS}/${id}/01/meta.json`, '{}'.padEnd(1024, ' '), ageDays)
  place(world, `${LENS}/${id}/01/before.md`, 'b'.repeat(2048), ageDays)
  place(world, `${LENS}/${id}/pinned.md`, 'p'.repeat(1024), ageDays)
  if (transcriptAge !== undefined) place(world, `${projects}/-work/${id}.jsonl`, '{}\n', transcriptAge)
}

/** A record as compact-lens 0.1.0 and 0.2.0 wrote meta.json: its summary named by its opening alone, with no hash. */
const recordWithoutHash = (summary: string, n = 1): string =>
  JSON.stringify({ n, trigger: 'auto', at: '2023-10-01T00:00:00.000Z', dir: 'x', summaryHead: summary.slice(0, SUMMARY_HEAD_CHARS) })

/** A compaction's record whose summary is `summary`, as the mod writes meta.json. */
const record = (summary: string, n = 1, trigger = 'auto'): string =>
  JSON.stringify({ n, trigger, at: '2023-10-01T00:00:00.000Z', dir: 'x', summaryHead: summary.slice(0, SUMMARY_HEAD_CHARS), summaryHash: hashOf(summary) })

/** The confirm code in a preview, and the preview with it taken out. */
const codeIn = (text: string | undefined): string => /confirm ([0-9a-f]{6}) removes/.exec(text ?? '')?.[1] ?? 'no code'
const withoutCode = (text: string | undefined): string => (text ?? '').replace(/confirm [0-9a-f]{6} removes/, 'confirm CODE removes')
/** The ids a preview lists, in its order. */
const listedIds = (text: string | undefined): string[] => [...(text ?? '').matchAll(/^ {2}([0-9a-f-]{36}) ·/gm)].map(match => match[1] ?? '')

const arrange = (world: World): void => {
  session(world, OLD, 40, 41)
  session(world, YOUNG, 5, 5)
  session(world, BUSY, 40, 1)
  session(world, ORPHAN, 45, undefined)
  place(world, `${LENS}/${STRANGER}/photo.jpg`, 'x', 90)
  place(world, `${LENS}/notes/01/meta.json`, '{}', 90)
  place(world, `${LENS}/.statusline/${OLD}.count`, '1 2 3 4', 40)
  place(world, `${LENS}/.statusline/${OLD}.count.4242`, '1 2 3 4', 40)
  place(world, `${LENS}/.statusline/${YOUNG}.count`, '1 2 3 4', 5)
}

/** Old folders a prune must leave: not the mod's alone, holding an edit, on screen, or written to yesterday. */
const arrangeKept = (world: World): void => {
  place(world, `${LENS}/${MIXED}/pinned.md`, 'p', 90)
  place(world, `${LENS}/${MIXED}/2024/photo.jpg`, 'x', 90)
  session(world, EDITED, 40, 41)
  place(world, `${LENS}/${EDITED}/01/meta.json`, record('The engine summary.'), 40)
  place(world, `${LENS}/${EDITED}/01/summary.md`, 'The engine summary, as the person rewrote it.', 40)
  session(world, DRAFTED, 40, 41)
  place(world, `${LENS}/${DRAFTED}/draft.md`, 'a draft', 40)
  session(world, SHOWN, 40, 41)
  world.files.set(`${LENS}/.statusline/${SHOWN}.count`, '1 2 3 4')
  world.mtimes.set(`${LENS}/.statusline/${SHOWN}.count`, NOW - HOUR_MS)
  session(world, FRESH, 40, 41)
  place(world, `${LENS}/${FRESH}/02/meta.json`, '{}', 1)
}

const removed = (world: World): string[] => world.spawned.filter(argv => argv[0] === '/bin/rm').map(argv => argv.at(-1) ?? '')

const HEADING = 'Sessions untouched for more than 30 days:'
const COPIES = 'transcript still there, so compact-lens can read these compactions again (4.0 KB):'
const ONLY_COPIES =
  'transcript gone or older than cleanupPeriodDays (365 days), so these snapshots may be the only copy (4.0 KB); Claude Code deletes a transcript that old, and a session run with a CLAUDE_CONFIG_DIR other than a ~/.claude* folder keeps its transcript there:'
const KEPT_EDIT = 'kept, as each may hold an edit not applied yet (a changed summary.md, a draft.md, or an edit set aside); remove one by hand once you no longer need it:'
const KEPT_FOREIGN = 'kept, holding files compact-lens did not write; remove one by hand if it should go:'
const OLD_LINE = `  ${OLD} · last written 2023-10-05 22:13 UTC · 4.0 KB`
const ORPHAN_LINE = `  ${ORPHAN} · last written 2023-09-30 22:13 UTC · 4.0 KB`

test('prune <days> lists the old sessions, those whose transcript is gone apart as the only copy, and removes nothing', async ($, on) => {
  const world = setupPrune(on)
  arrange(world)
  await $.session.start(START)

  const listed = await run($, 'prune 30')

  expect(withoutCode(listed.text)).toBe([HEADING, COPIES, OLD_LINE, ONLY_COPIES, ORPHAN_LINE, '/compact-lens prune 30 confirm CODE removes the snapshots of those 2 sessions; nothing brings them back.'].join('\n'))
  expect(removed(world)).toEqual([])
})

test('prune <days> confirm <code> removes the listed folders and their status files, and keeps everything else', async ($, on) => {
  const world = setupPrune(on)
  arrange(world)
  await $.session.start(START)

  const done = await run($, `prune 30 confirm ${codeIn((await run($, 'prune 30')).text)}`)

  expect(done.text).toBe(`removed the snapshots of 2 sessions (8.0 KB): ${OLD}, ${ORPHAN}`)
  expect(removed(world).sort()).toEqual([`${LENS}/${OLD}`, `${LENS}/${ORPHAN}`, `${LENS}/.statusline/${OLD}.count`, `${LENS}/.statusline/${OLD}.count.4242`].sort())
  expect([...world.files.keys()].some(path => path.startsWith(`${LENS}/${OLD}/`))).toBe(false)
  for (const kept of [`${YOUNG}/01/meta.json`, `${BUSY}/01/meta.json`, `${STRANGER}/photo.jpg`, 'notes/01/meta.json', `.statusline/${YOUNG}.count`]) expect(world.files.has(`${LENS}/${kept}`)).toBe(true)
  expect(world.files.has(`${PROJECTS}/-work/${OLD}.jsonl`)).toBe(true)
})

test('a folder holding an edit, files of someone else, a status-line script on screen or a fresh compaction stays, the first two listed as kept', async ($, on) => {
  const world = setupPrune(on)
  arrangeKept(world)
  await $.session.start(START)

  const listed = await run($, 'prune 30')
  const done = await run($, 'prune 30 confirm 000000')

  const lines = (listed.text ?? '').split('\n')
  expect(lines[0]).toBe(HEADING)
  expect(lines[1]).toBe(KEPT_EDIT)
  expect(lines[4]).toBe(KEPT_FOREIGN)
  expect(listedIds(listed.text)).toEqual([EDITED, DRAFTED, MIXED])
  expect(listed.text).not.toContain('confirm')
  expect(done.text).toBe("no session's snapshots can go: the 3 older than 30 days are kept, as /compact-lens prune 30 lists")
  expect(removed(world)).toEqual([])
})

test('an edit in any compaction folder keeps its session, unless a later apply used it; an edit set aside keeps it too', async ($, on) => {
  const world = setupPrune(on)
  const ids = {
    applied: 'b1a8d7c9-0001-4ddd-8eee-4ffff0000111',
    earlier: 'c2b9e8da-0002-4ddd-8eee-4ffff0000222',
    unapplied: 'd3caf9eb-0003-4ddd-8eee-4ffff0000333',
    unused: 'e4db0afc-0004-4ddd-8eee-4ffff0000444',
    unsaved: 'f5ec1b0d-0005-4ddd-8eee-4ffff0000555',
  }
  for (const id of Object.values(ids)) session(world, id, 40, 41)
  // An edit applied: 02 is the apply, its summary the edit, trimmed.
  place(world, `${LENS}/${ids.applied}/01/meta.json`, record('First summary.'), 40)
  place(world, `${LENS}/${ids.applied}/01/summary.md`, 'First summary, rewritten.\n', 40)
  place(world, `${LENS}/${ids.applied}/02/meta.json`, record('First summary, rewritten.', 2, 'apply'), 40)
  place(world, `${LENS}/${ids.applied}/02/summary.md`, 'First summary, rewritten.', 40)
  // An edit an automatic compaction passed over: it stays in 01, and 02 holds the engine's next summary.
  place(world, `${LENS}/${ids.earlier}/01/meta.json`, record('First summary.'), 40)
  place(world, `${LENS}/${ids.earlier}/01/summary.md`, 'First summary, rewritten.', 40)
  place(world, `${LENS}/${ids.earlier}/02/meta.json`, record('Second summary.', 2), 40)
  place(world, `${LENS}/${ids.earlier}/02/summary.md`, 'Second summary.', 40)
  place(world, `${LENS}/${ids.unapplied}/01/edit-unapplied-20231001-101500-123.md`, 'my edit', 40)
  place(world, `${LENS}/${ids.unused}/01/draft-unused.md`, 'my draft', 40)
  place(world, `${LENS}/${ids.unsaved}/edit-unsaved-20231001-101500-123.md`, 'my text', 40)
  await $.session.start(START)

  const listed = await run($, 'prune 30')

  const lines = (listed.text ?? '').split('\n')
  expect(listedIds(listed.text)).toEqual([ids.applied, ids.earlier, ids.unapplied, ids.unused, ids.unsaved])
  expect(lines[1]?.startsWith('transcript still there')).toBe(true)
  expect(lines[3]).toBe(KEPT_EDIT)
  expect(listed.text).not.toContain(KEPT_FOREIGN)
})

test('a summary written from the transcript is checked against the mark written beside it: as written it may go, edited or unmarked it stays', async ($, on) => {
  const world = setupPrune(on)
  const ids = { marked: '16fd2c1e-0006-4ddd-8eee-4ffff0000666', edited: '27fe3d2f-0007-4ddd-8eee-4ffff0000777', unmarked: '38ff4e30-0008-4ddd-8eee-4ffff0000888' }
  for (const id of Object.values(ids)) {
    place(world, `${LENS}/${id}/03/summary.md`, 'The summary as the transcript holds it.', 40)
    place(world, `${PROJECTS}/-work/${id}.jsonl`, '{}\n', 41)
  }
  place(world, `${LENS}/${ids.marked}/03/summary.hash`, hashOf('The summary as the transcript holds it.'), 40)
  place(world, `${LENS}/${ids.edited}/03/summary.hash`, hashOf('The summary before the person changed it.'), 40)
  await $.session.start(START)

  const listed = await run($, 'prune 30')

  expect(listedIds(listed.text)).toEqual([ids.marked, ids.edited, ids.unmarked])
  expect((listed.text ?? '').split('\n')[3]).toBe(KEPT_EDIT)
})

test('a record from before 0.3.0 names its summary by its opening alone: an edit past it keeps the folder, and a summary after.md holds whole may go', async ($, on) => {
  const world = setupPrune(on)
  const long = `${'An engine summary opens with what it is for, then the work. '.repeat(8)}The retry limit stays at 7.\n\n## Decisions\n\nShip on Friday.`
  /** after.md as 0.1.0 and 0.2.0 wrote it: a heading, then each message under `## <k> · <role>`, its text trimmed. */
  const afterOf = (summary: string): string => `# Compaction 01\n\nthe header\n\n## 1 · user\n\n${summary}\n\n## 2 · assistant\n\nOK\n`
  const short = 'A short summary.'
  const ids = {
    asWritten: '01a8d7c9-0011-4ddd-8eee-4ffff0001111',
    editedLate: '12b9e8da-0012-4ddd-8eee-4ffff0001222',
    appended: '23caf9eb-0013-4ddd-8eee-4ffff0001333',
    cut: '34db0afc-0014-4ddd-8eee-4ffff0001444',
    unknown: '45ec1b0d-0015-4ddd-8eee-4ffff0001555',
    laterHead: '56fd2c1e-0016-4ddd-8eee-4ffff0001666',
    endCut: '67fe3d2f-0017-4ddd-8eee-4ffff0001777',
    quotedWhole: '02b9e8da-0018-4ddd-8eee-4ffff0001888',
    quotedCut: '78ff4e30-0019-4ddd-8eee-4ffff0001999',
    quotedFirst: '03ca1b0d-0020-4ddd-8eee-4ffff0002000',
  }
  // A summary that quotes an after.md, its next heading and all: whole, it is as written; cut at the quote, it is an edit.
  const quoting = `${long}\n\nHow after.md reads:\n\n## 2 · assistant\n\nOK\n\nThe end.`
  for (const id of Object.values(ids)) session(world, id, 40, 41)
  place(world, `${LENS}/${ids.asWritten}/01/meta.json`, recordWithoutHash(long), 40)
  place(world, `${LENS}/${ids.asWritten}/01/summary.md`, long, 40)
  place(world, `${LENS}/${ids.asWritten}/01/after.md`, afterOf(long), 40)
  place(world, `${LENS}/${ids.editedLate}/01/meta.json`, recordWithoutHash(long), 40)
  place(world, `${LENS}/${ids.editedLate}/01/summary.md`, long.replace('at 7', 'at 9'), 40)
  place(world, `${LENS}/${ids.editedLate}/01/after.md`, afterOf(long), 40)
  // Its last section cut: what is left stands in after.md, but not as the whole message.
  place(world, `${LENS}/${ids.endCut}/01/meta.json`, recordWithoutHash(long), 40)
  place(world, `${LENS}/${ids.endCut}/01/summary.md`, long.slice(0, long.indexOf('\n\n## Decisions')), 40)
  place(world, `${LENS}/${ids.endCut}/01/after.md`, afterOf(long), 40)
  place(world, `${LENS}/${ids.quotedWhole}/01/meta.json`, recordWithoutHash(quoting), 40)
  place(world, `${LENS}/${ids.quotedWhole}/01/summary.md`, quoting, 40)
  place(world, `${LENS}/${ids.quotedWhole}/01/after.md`, afterOf(quoting), 40)
  place(world, `${LENS}/${ids.quotedCut}/01/meta.json`, recordWithoutHash(quoting), 40)
  place(world, `${LENS}/${ids.quotedCut}/01/summary.md`, quoting.slice(0, quoting.indexOf('\n\n## 2 · assistant')), 40)
  place(world, `${LENS}/${ids.quotedCut}/01/after.md`, afterOf(quoting), 40)
  // The summary quoted in a reply before its own message: only the copy under a user heading counts.
  place(world, `${LENS}/${ids.quotedFirst}/01/meta.json`, recordWithoutHash(long), 40)
  place(world, `${LENS}/${ids.quotedFirst}/01/summary.md`, long, 40)
  place(world, `${LENS}/${ids.quotedFirst}/01/after.md`, `# Compaction 01\n\nthe header\n\n## 1 · assistant\n\n${long}\n\n## 2 · user\n\n${long}\n\n## 3 · assistant\n\nOK\n`, 40)
  place(world, `${LENS}/${ids.appended}/01/meta.json`, recordWithoutHash(short), 40)
  place(world, `${LENS}/${ids.appended}/01/summary.md`, `${short}\nAnd a line the person added.`, 40)
  // Cut to its first 400 characters: the opening the record names, and still an edit.
  place(world, `${LENS}/${ids.cut}/01/meta.json`, recordWithoutHash(long), 40)
  place(world, `${LENS}/${ids.cut}/01/summary.md`, long.slice(0, SUMMARY_HEAD_CHARS), 40)
  place(world, `${LENS}/${ids.unknown}/01/meta.json`, recordWithoutHash(long), 40)
  place(world, `${LENS}/${ids.unknown}/01/summary.md`, long, 40)
  // A later record without a hash whose opening the edit shares: no proof an apply used it.
  place(world, `${LENS}/${ids.laterHead}/01/meta.json`, record('First summary.'), 40)
  place(world, `${LENS}/${ids.laterHead}/01/summary.md`, `${long} And the person's line.`, 40)
  place(world, `${LENS}/${ids.laterHead}/02/meta.json`, recordWithoutHash(long, 2), 40)
  await $.session.start(START)

  const listed = await run($, 'prune 30')

  const kept = [ids.editedLate, ids.appended, ids.cut, ids.unknown, ids.laterHead, ids.endCut, ids.quotedCut].sort()
  expect(listedIds(listed.text)).toEqual([ids.asWritten, ids.quotedWhole, ids.quotedFirst, ...kept])
  expect((listed.text ?? '').split('\n')[5]).toBe(KEPT_EDIT)
})

test('a summary.md that cannot be read keeps its folder: it may hold an edit', async ($, on) => {
  const world = setupPrune(on, { readFails: path => path === `${LENS}/${EDITED}/01/summary.md` })
  session(world, EDITED, 40, 41)
  place(world, `${LENS}/${EDITED}/01/meta.json`, record('The engine summary.'), 40)
  place(world, `${LENS}/${EDITED}/01/summary.md`, 'The engine summary, as the person rewrote it.', 40)
  await $.session.start(START)

  const listed = await run($, 'prune 30')

  expect((listed.text ?? '').split('\n')[1]).toBe(KEPT_EDIT)
  expect(listedIds(listed.text)).toEqual([EDITED])
  expect(listed.text).not.toContain('confirm')
})

test('a transcript older than cleanupPeriodDays counts as gone, as Claude Code deletes it: listed as the only copy, and keepDays keeps it', { options: { keepDays: 30 } }, async ($, on) => {
  const world = setup(on)
  session(world, OLD, 40, 35)
  await $.session.start(START)
  await world.clock.advance(PRUNE_DELAY_MS)

  const listed = await run($, 'prune 30')

  expect(removed(world)).toEqual([])
  expect((listed.text ?? '').split('\n')[1]).toBe(
    'transcript gone or older than cleanupPeriodDays (30 days), so these snapshots may be the only copy (4.0 KB); Claude Code deletes a transcript that old, and a session run with a CLAUDE_CONFIG_DIR other than a ~/.claude* folder keeps its transcript there:',
  )
})

test('where no program can run, keepDays says nothing, and a confirm says why nothing was removed', { options: { keepDays: 30 } }, async ($, on) => {
  const world = setupPrune(on, { processes: false })
  arrange(world)
  await $.session.start(START)
  await world.clock.advance(PRUNE_DELAY_MS)

  const done = await run($, `prune 30 confirm ${codeIn((await run($, 'prune 30')).text)}`)

  expect(world.logs.filter(line => line.includes('could not remove'))).toEqual([])
  expect(done.text).toBe('nothing was removed: this session runs no programs, so rm could not start; run the prune in a session in a terminal')
})

test("a compaction folder holding only files the mod writes is its own, and Finder's .DS_Store, beside the compaction folders or in one, is no stranger", async ($, on) => {
  const world = setupPrune(on)
  place(world, `${LENS}/${OLD}/04/before.json`, 'j'.repeat(2048), 40)
  place(world, `${LENS}/${OLD}/04/lost.md`, 'l'.repeat(1024), 40)
  place(world, `${LENS}/${OLD}/04/.DS_Store`, 'd'.repeat(512), 40)
  place(world, `${LENS}/${OLD}/.DS_Store`, 'd'.repeat(512), 40)
  place(world, `${PROJECTS}/-work/${OLD}.jsonl`, '{}\n', 41)
  place(world, `${LENS}/${ORPHAN}/01/summary.md`, 's', 45)
  place(world, `${LENS}/${ORPHAN}/01/notes.txt`, 'mine', 45)
  await $.session.start(START)

  const listed = await run($, 'prune 30')

  expect(withoutCode(listed.text)).toBe(
    [
      HEADING,
      COPIES,
      OLD_LINE,
      KEPT_FOREIGN,
      `  ${ORPHAN} · last written 2023-09-30 22:13 UTC · 5 B`,
      '/compact-lens prune 30 confirm CODE removes the snapshots of that session (the kept ones stay); nothing brings them back.',
    ].join('\n'),
  )
})

test('confirm needs the code the list gave: without it, or once the list changed, nothing goes, even with as many sessions', async ($, on) => {
  const world = setupPrune(on)
  arrange(world)
  await $.session.start(START)
  const code = codeIn((await run($, 'prune 30')).text)

  const bare = await run($, 'prune 30 confirm')
  // The old session is resumed, and another ages past the line: two sessions still, but not the two listed.
  place(world, `${PROJECTS}/-work/${OLD}.jsonl`, '{}\n', 0)
  session(world, '5ab27163-6666-4777-d888-e9999aaaabbb', 50, 50)
  const stale = await run($, `prune 30 confirm ${code}`)

  expect(bare.text?.split('\n')[0]).toBe(`nothing was removed: confirm takes the code the list gives, as in /compact-lens prune 30 confirm ${code}`)
  expect(stale.text?.split('\n')[0]).toBe('nothing was removed: the list changed since that code; here it is now')
  expect(listedIds(stale.text)).toEqual(['5ab27163-6666-4777-d888-e9999aaaabbb', ORPHAN])
  expect(removed(world)).toEqual([])
})

test('a code stands for each folder and the group it was listed in: a transcript deleted since the list makes the code stale', async ($, on) => {
  const world = setupPrune(on)
  session(world, OLD, 40, 41)
  await $.session.start(START)
  const listed = await run($, 'prune 30')
  world.files.delete(`${PROJECTS}/-work/${OLD}.jsonl`)

  const stale = await run($, `prune 30 confirm ${codeIn(listed.text)}`)

  expect((listed.text ?? '').split('\n')[1]).toBe(COPIES)
  expect(stale.text?.split('\n')[0]).toBe('nothing was removed: the list changed since that code; here it is now')
  expect(stale.text).toContain(ONLY_COPIES)
  expect(removed(world)).toEqual([])
})

for (const [kind, from] of [
  ['peer', 'another Claude session'],
  ['plugin', 'a plugin'],
  ['sdk', 'claude -p or the Agent SDK'],
] as const) {
  test(`only the person confirms a prune, at the prompt or over Remote Control: one from ${kind} removes nothing`, async ($, on) => {
    const world = setupPrune(on)
    arrange(world)
    await $.session.start(START)
    const code = codeIn((await run($, 'prune 30')).text)

    const refused = await run($, `prune 30 confirm ${code}`, { kind } as PromptOrigin)
    const fromPhone = await run($, `prune 30 confirm ${code}`, { kind: 'bridge' } as PromptOrigin)

    expect(refused.text).toBe(`nothing was removed: a prune is confirmed by you, at the prompt or over Remote Control; this one came from ${from}`)
    expect(fromPhone.text).toBe(`removed the snapshots of 2 sessions (8.0 KB): ${OLD}, ${ORPHAN}`)
  })
}

test("prune never removes this session's own folder, however old", async ($, on) => {
  const world = setupPrune(on)
  const ownId = '5ab27163-6666-4777-d888-e9999aaaabbb'
  world.sessionId = ownId
  session(world, ownId, 60, 60)
  await $.session.start(START)

  const listed = await run($, 'prune 30')

  expect(listed.text).toBe(
    "no session's snapshots can go: none older than 30 days is compact-lens's alone and idle (this session's folder, and one whose transcript or status-line script changed since, are kept too)",
  )
  expect(removed(world)).toEqual([])
})

test('prune asks for a number of days, and says so when there is no snapshot folder yet', async ($, on) => {
  const world = setupPrune(on)
  await $.session.start(START)

  const bare = await run($, 'prune')
  const word = await run($, 'prune soon')
  const count = await run($, 'prune 30 confirm 2')
  const empty = await run($, 'prune 30')

  expect(bare.text).toBe('prune takes a number of days, as in /compact-lens prune 30: it lists what would go, and the confirm that removes it')
  expect(word.text).toBe(bare.text)
  expect(count.text).toBe(bare.text)
  expect(empty.text).toBe(`there are no snapshots yet: ${LENS} is not there`)
  expect(removed(world)).toEqual([])
})

test('a project folder that cannot be listed stops the prune: a session in use would look old', async ($, on) => {
  const world = setupPrune(on, { listFails: path => path === `${PROJECTS}/-work` })
  arrange(world)
  await $.session.start(START)

  const listed = await run($, 'prune 30')

  expect(listed.text).toBe(`nothing was removed: ${PROJECTS}/-work could not be listed, so a session still in use there would look old`)
  expect(removed(world)).toEqual([])
})

test('a session under any config folder in the home folder counts as in use, whichever one this session runs under', async ($, on) => {
  const work = `${HOME}/.claude-work/projects`
  const world = setupPrune(on)
  session(world, BUSY, 40, 0, work)
  session(world, OLD, 40, 41, PROJECTS)
  await $.session.start(START)

  const listed = await run($, 'prune 30')

  expect(listedIds(listed.text)).toEqual([OLD])
  expect((listed.text ?? '').split('\n')[1]).toBe(COPIES)
})

test('a session run under the default config folder counts as in use from a session under another CLAUDE_CONFIG_DIR', async ($, on) => {
  const work = `${HOME}/.claude-work/projects`
  const world = setupPrune(on, { env: { CLAUDE_CONFIG_DIR: `${HOME}/.claude-work` } })
  session(world, BUSY, 40, 0, PROJECTS)
  session(world, OLD, 40, 41, work)
  await $.session.start(START)

  const listed = await run($, 'prune 30')

  expect(listedIds(listed.text)).toEqual([OLD])
})

test('a folder that cannot be removed is named with the reason, and the others still go', async ($, on) => {
  const world = setupPrune(on, { removeFails: path => path.endsWith(ORPHAN) })
  arrange(world)
  await $.session.start(START)

  const done = await run($, `prune 30 confirm ${codeIn((await run($, 'prune 30')).text)}`)

  expect(done.text).toContain(`removed the snapshots of 1 session (4.0 KB): ${OLD}`)
  expect(done.text).toContain(`could not remove ${LENS}/${ORPHAN}: rm ended with code 1`)
  expect(world.files.has(`${LENS}/${ORPHAN}/01/meta.json`)).toBe(true)
})

test('where /bin holds no rm, the one on the PATH removes the folders', async ($, on) => {
  const world = setupPrune(on, { binMissing: true })
  arrange(world)
  await $.session.start(START)

  const done = await run($, `prune 30 confirm ${codeIn((await run($, 'prune 30')).text)}`)

  expect(done.text).toBe(`removed the snapshots of 2 sessions (8.0 KB): ${OLD}, ${ORPHAN}`)
  expect(world.spawned.filter(argv => argv[0] === 'rm').map(argv => argv.at(-1) ?? '').sort()).toEqual(
    [`${LENS}/${OLD}`, `${LENS}/${ORPHAN}`, `${LENS}/.statusline/${OLD}.count`, `${LENS}/.statusline/${OLD}.count.4242`].sort(),
  )
})

test('with keepDays set, a start removes the old sessions whose transcripts are still there, never an only copy, and says so once', { options: { keepDays: 30 } }, async ($, on) => {
  const world = setupPrune(on)
  arrange(world)
  arrangeKept(world)
  await $.session.start(START)
  expect(removed(world)).toEqual([])

  await world.clock.advance(PRUNE_DELAY_MS)

  expect(removed(world).sort()).toEqual([`${LENS}/${OLD}`, `${LENS}/.statusline/${OLD}.count`, `${LENS}/.statusline/${OLD}.count.4242`].sort())
  expect(world.files.has(`${LENS}/${ORPHAN}/01/meta.json`)).toBe(true)
  expect(world.toasts.filter(toast => toast.startsWith('removed the snapshots'))).toEqual([
    'removed the snapshots of 1 session untouched for more than 30 days (4.0 KB); the keepDays option sets how long they stay',
  ])
})

test('with keepDays set and no folder old enough, the old status files still go', { options: { keepDays: 30 } }, async ($, on) => {
  const world = setupPrune(on)
  place(world, `${LENS}/.statusline/${OLD}.json`, '{}', 40)
  session(world, YOUNG, 5, 5)
  await $.session.start(START)

  await world.clock.advance(PRUNE_DELAY_MS)

  expect(removed(world)).toEqual([`${LENS}/.statusline/${OLD}.json`])
  expect(world.toasts.filter(toast => toast.startsWith('removed'))).toEqual([])
})

test('keepDays under 7 counts as 7, so a session left open over a weekend keeps its snapshots', { options: { keepDays: 1 } }, async ($, on) => {
  const world = setupPrune(on)
  session(world, BUSY, 3, 3)
  session(world, OLD, 8, 8)
  await $.session.start(START)

  await world.clock.advance(PRUNE_DELAY_MS)

  expect(removed(world)).toEqual([`${LENS}/${OLD}`])
})

test('with keepDays at 0, the default, a start removes nothing', async ($, on) => {
  const world = setupPrune(on)
  arrange(world)
  await $.session.start(START)
  await world.clock.advance(PRUNE_DELAY_MS)

  expect(removed(world)).toEqual([])
})
