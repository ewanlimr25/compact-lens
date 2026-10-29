// tools/replay.mjs run as a person runs it, against a transcript written from the mod's own test rows
// (tests/rows.ts): two compactions the mod never saw run. Run with `node --test 'tools/test/*.test.mjs'`.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createEngine } from '../engine.mjs'

register('../loader.mjs', import.meta.url)
const rows = await import('../../tests/rows.ts')

const REPLAY = fileURLToPath(new URL('../replay.mjs', import.meta.url))
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** The folder the test's files go in: the transcript, and a home the runs are pointed at. */
let scratch = ''
let transcript = ''

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'compact-lens-replay-test-'))
  transcript = join(scratch, 'sess-replay.jsonl')
  await writeFile(transcript, rows.twoCompactions().map(row => JSON.stringify(row)).join('\n') + '\n')
})

after(() => rm(scratch, { recursive: true, force: true }))

/** One run of the tool, its HOME a folder of the test's own, so a write to ~/.claude would show there. */
const replay = (...args) => {
  const ran = spawnSync(process.execPath, [REPLAY, ...args], { encoding: 'utf8', env: { ...process.env, HOME: join(scratch, 'home') } })
  return { code: ran.status, out: ran.stdout, err: ran.stderr }
}

test('list names every compaction the transcript holds, with its lines', () => {
  const { code, out, err } = replay(transcript, 'list')

  assert.equal(code, 0)
  assert.match(out, /2 compactions, read from the transcript/)
  assert.match(out, /#1 auto {3}2026-10-20 10:06 UTC {2}180k → 20k tokens {2}lines 1–5, boundary 6, summary 7/)
  assert.match(out, /#2 manual 2026-10-20 10:13 UTC {2}175k → 20k tokens {2}lines 7–12, boundary 13, summary 14/)
  assert.match(err, /\[toast\] found 2 earlier compactions/)
  assert.match(err, /replay: list in \d+ ms/)
})

test('lost prints what the compaction dropped, as lost.md has it', () => {
  const { code, out } = replay(transcript, 'lost', '1')

  assert.equal(code, 0)
  assert.match(out, /^# What compaction #1 \(auto\) dropped/)
  assert.ok(out.includes(rows.SPAN_ONE_PROMPT))
  assert.match(out, /- \/repo\/src\/net\/retry\.ts \(edited\)/)
})

test('prompts gives back the span\'s prompts, a queued one too, as a restore hands them to Claude', () => {
  const { code, out } = replay(transcript, 'prompts', '#2')

  assert.equal(code, 0)
  assert.match(out, /<compact-lens-restore n="2" kind="prompts">/)
  assert.ok(out.includes(`1. [2026-10-20 10:08 UTC] ${rows.SPAN_TWO_PROMPT}`))
  assert.ok(out.includes(`2. [2026-10-20 10:11 UTC] ${rows.QUEUED_PROMPT}`))
})

test('recall finds the compacted passage and leaves the reply the compaction kept', () => {
  const { code, out } = replay(transcript, 'recall', 'canary-42')

  assert.equal(code, 0)
  assert.match(out, /<compact-lens-recall query="canary-42">/)
  assert.match(out, /--- #2 · line 10 · a tool result/)
  assert.ok(out.includes(`deployed to ${rows.CANARY_URL}`))
  assert.doesNotMatch(out, /line 12/)
})

test('a refusal is printed with exit code 1, and a wrong command line with the usage and exit code 2', () => {
  const short = replay(transcript, 'recall', 'ab')
  const unknown = replay(transcript, 'explain')
  const missing = replay(join(scratch, 'none.jsonl'), 'list')

  assert.equal(short.code, 1)
  assert.match(short.out, /the mod gave no answer: search with a word of 3 or more characters/)
  assert.equal(unknown.code, 2)
  assert.match(unknown.err, /^usage: node tools\/replay\.mjs/)
  assert.equal(missing.code, 2)
  assert.match(missing.err, /none\.jsonl: no such transcript file/)
})

test('the snapshots go to a scratch home, removed afterwards unless --keep keeps it', async () => {
  const removed = replay(transcript, 'lost', '1')
  const kept = replay(transcript, 'lost', '1', '--keep')
  const folder = /the snapshots are kept in (.+)\n/.exec(kept.err)?.[1] ?? ''

  try {
    assert.equal(removed.code, 0)
    assert.doesNotMatch(removed.err, /kept in/)
    assert.ok(existsSync(join(folder, '.claude/compact-lens/sess-replay/01/lost.md')))
    assert.equal(existsSync(join(scratch, 'home/.claude/compact-lens')), false)
  } finally {
    if (folder !== '') await rm(folder, { recursive: true, force: true })
  }
})

test('the engine refuses a method it does not shim, naming it', () => {
  const $ = createEngine({ transcript, home: scratch, root: ROOT, note: () => {} })

  assert.throws(() => $.fs.remove, /replay: \$\.fs\.remove is not shimmed/)
  assert.throws(() => $.agent, /replay: \$\.agent is not shimmed/)
  assert.equal($.plugin.name, 'compact-lens')
})

test('a spawned command streams what it writes and says how it ended; one that cannot start throws when read', async () => {
  const $ = createEngine({ transcript, home: scratch, root: ROOT, note: () => {} })
  const stream = $.process.spawn({ argv: ['sed', '-n', '6p', transcript] })
  const pieces = []
  for await (const piece of stream) pieces.push(piece)
  const ended = await stream.result
  const missing = $.process.spawn({ argv: ['no-such-program-for-replay'] })

  assert.match(pieces.map(p => p.text).join(''), /"subtype":"compact_boundary"/)
  assert.deepEqual(ended, { code: 0, signal: null })
  await assert.rejects(async () => {
    for await (const piece of missing) assert.fail(`read ${piece.text}`)
  }, /ENOENT/)
})

/** The scratch homes a run made under `folder`, its TMPDIR. */
const homesIn = folder => readdirSync(folder).filter(name => name.startsWith('compact-lens-replay-'))

/** Resolves once `path` exists; rejects after `ms`. */
const appears = (path, ms) =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + ms
    const poll = setInterval(() => {
      if (existsSync(path)) resolve(clearInterval(poll))
      else if (Date.now() > deadline) reject(new Error(`${path} never appeared`), clearInterval(poll))
    }, 5)
  })

/**
 * A run held in the middle by a perl that never answers (first on its PATH: it notes its pid, then sleeps),
 * sent `signal` there; how it ended, what it wrote to stderr and the scratch homes left behind.
 */
async function interrupted(signal, ...flags) {
  const folder = await mkdtemp(join(scratch, 'held-'))
  const [bin, tmp, mark] = [join(folder, 'bin'), join(folder, 'tmp'), join(folder, 'perl.pid')]
  await Promise.all([mkdir(bin), mkdir(tmp)])
  await writeFile(join(bin, 'perl'), '#!/bin/sh\necho $$ > "$REPLAY_HELD_PID"\nexec sleep 60\n')
  chmodSync(join(bin, 'perl'), 0o755)
  const env = { ...process.env, HOME: join(scratch, 'home'), TMPDIR: tmp, PATH: `${bin}:${process.env.PATH}`, REPLAY_HELD_PID: mark }
  const child = spawn(process.execPath, [REPLAY, transcript, 'list', ...flags], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  const err = []
  child.stderr.on('data', chunk => err.push(chunk))
  const ended = new Promise(resolve => child.on('exit', (code, killedBy) => resolve({ code, killedBy })))
  try {
    await appears(mark, 10_000)
    assert.equal(homesIn(tmp).length, 1, 'the run is held with its scratch home made')
    child.kill(signal)
    return { ...(await ended), err: Buffer.concat(err).toString('utf8'), homes: homesIn(tmp).map(name => join(tmp, name)) }
  } finally {
    child.kill('SIGKILL')
    if (existsSync(mark)) process.kill(Number(readFileSync(mark, 'utf8')), 'SIGKILL')
  }
}

test('a run stopped by Ctrl-C or a kill removes its scratch home and exits 130 or 143, as a shell reports them', async () => {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const { code: exited, killedBy, homes } = await interrupted(signal)

    assert.deepEqual({ exited, killedBy }, { exited: code, killedBy: null }, signal)
    assert.deepEqual(homes, [], signal)
  }
})

test('a run stopped with --keep keeps its scratch home and says where it is', async () => {
  const { code, err, homes } = await interrupted('SIGINT', '--keep')

  assert.equal(code, 130)
  assert.equal(homes.length, 1)
  assert.ok(err.includes(`replay: the snapshots are kept in ${homes[0]}`))
})
