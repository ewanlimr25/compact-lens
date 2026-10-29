// The status-line script, bin/statusline.pl, run as a status line runs it: Claude Code's status JSON on
// standard input, one line out. Each test installs a copy in a folder of its own, as the mod does, so the
// count it keeps beside itself never lands in the repository.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'statusline.pl')
const SESSION = '6f2ef4d2-f1a4-403a-a65c-80cdd70c9b66'
/** The script reads the transcript in blocks of this size (its BLOCK_BYTES) and the first bytes it compares (its HEAD_BYTES). */
const BLOCK = 1024 * 1024
const HEAD = 64
/** The probe a boundary row holds, and where it starts in BOUNDARY's row. */
const PROBE = '"subtype":"compact_boundary"'
const BOUNDARY = { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 180000 } }
const PROMPT = { type: 'user', message: { role: 'user', content: 'hello' } }
/** A prompt as long as PROMPT whose first 64 bytes differ from it. */
const OTHER = { type: 'user', message: { role: 'user', content: 'howdy' } }
/** A row that only quotes the boundary's probe: inside a text it is escaped, so it is no boundary. */
const QUOTING = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'grep for "subtype":"compact_boundary" rows' }] } }

const folders = []
afterEach(() => folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true })))

/** A folder with the script installed in it, as `/compact-lens statusline` installs it, and a transcript path inside. */
const install = () => {
  const root = mkdtempSync(join(tmpdir(), 'compact-lens-status-'))
  folders.push(root)
  copyFileSync(SCRIPT, join(root, 'statusline.pl'))
  return { root, script: join(root, 'statusline.pl'), transcript: join(root, 'projects', `${SESSION}.jsonl`) }
}

const lines = rows => rows.map(row => `${JSON.stringify(row)}\n`).join('')

const writeRows = (path, rows) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, lines(rows))
}

/** Runs the script with the status JSON on standard input; its output and exit code. */
const status = (script, input) => {
  const ran = spawnSync('perl', [script], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' })
  return { out: ran.stdout, code: ran.status, err: ran.stderr }
}

const forSession = (transcript, session_id = SESSION) => ({ session_id, transcript_path: transcript, model: { id: 'claude-opus-5-5' } })

test('it prints the compactions the transcript holds, one a boundary row, and never counts the probe quoted in a text', () => {
  const { script, transcript } = install()
  writeRows(transcript, [PROMPT, BOUNDARY, QUOTING, PROMPT, BOUNDARY])
  assert.deepEqual(status(script, forSession(transcript)), { out: '2 compactions\n', code: 0, err: '' })
  writeRows(transcript, [PROMPT, BOUNDARY])
  assert.equal(status(script, forSession(transcript, 'b1c2d3e4-0000-4000-8000-000000000001')).out, '1 compaction\n')
})

test('a second run reads only what the transcript gained: rows counted once stay counted', () => {
  const { root, script, transcript } = install()
  writeRows(transcript, [PROMPT, BOUNDARY, PROMPT])
  assert.equal(status(script, forSession(transcript)).out, '1 compaction\n')
  const counted = statSync(transcript).size
  appendFileSync(transcript, lines([BOUNDARY, PROMPT, BOUNDARY]))
  assert.equal(status(script, forSession(transcript)).out, '3 compactions\n')
  assert.ok(existsSync(join(root, '.statusline', `${SESSION}.count`)))
  // The first part rewritten in place (same length, no boundary): a run that read it again would count 2.
  const first = lines([PROMPT, BOUNDARY, PROMPT])
  writeFileSync(transcript, first.replace('compact_boundary', 'compact_xoundary') + lines([BOUNDARY, PROMPT, BOUNDARY]))
  assert.equal(statSync(transcript).size, counted + lines([BOUNDARY, PROMPT, BOUNDARY]).length)
  assert.equal(status(script, forSession(transcript)).out, '3 compactions\n')
})

test('a row still being written is counted once its line ends', () => {
  const { script, transcript } = install()
  writeRows(transcript, [PROMPT])
  const row = JSON.stringify(BOUNDARY)
  appendFileSync(transcript, row.slice(0, 20))
  assert.equal(status(script, forSession(transcript)).out, '0 compactions\n')
  appendFileSync(transcript, `${row.slice(20)}\n`)
  assert.equal(status(script, forSession(transcript)).out, '1 compaction\n')
})

test('a transcript that shrank or was replaced is counted again from its start', () => {
  const { script, transcript } = install()
  writeRows(transcript, [BOUNDARY, BOUNDARY, BOUNDARY, PROMPT, PROMPT])
  assert.equal(status(script, forSession(transcript)).out, '3 compactions\n')
  writeRows(transcript, [BOUNDARY])
  assert.equal(status(script, forSession(transcript)).out, '1 compaction\n')
  rmSync(transcript)
  writeRows(transcript, [BOUNDARY, PROMPT, BOUNDARY, PROMPT, PROMPT, PROMPT])
  assert.equal(status(script, forSession(transcript)).out, '2 compactions\n')
})

test('the pinned notes and a waiting edit come from what the mod last wrote for the session', () => {
  const { root, script, transcript } = install()
  writeRows(transcript, [BOUNDARY])
  mkdirSync(join(root, '.statusline'), { recursive: true })
  writeFileSync(join(root, '.statusline', `${SESSION}.json`), JSON.stringify({ compactions: 1, pinned: 2, pending: true }))
  assert.equal(status(script, forSession(transcript)).out, '1 compaction · 2 pinned · /compact applies the edit\n')
  writeFileSync(join(root, '.statusline', `${SESSION}.json`), JSON.stringify({ compactions: 1, pinned: 0, pending: false }))
  assert.equal(status(script, forSession(transcript)).out, '1 compaction\n')
  writeFileSync(join(root, '.statusline', `${SESSION}.json`), 'not json')
  assert.equal(status(script, forSession(transcript)).out, '1 compaction\n')
})

test('no transcript yet is no compaction; no transcript named, or input it cannot read, prints nothing; it always exits 0', () => {
  const { script, transcript } = install()
  assert.deepEqual(status(script, forSession(transcript)), { out: '0 compactions\n', code: 0, err: '' })
  assert.deepEqual(status(script, { session_id: SESSION }), { out: '', code: 0, err: '' })
  assert.deepEqual(status(script, 'not json'), { out: '', code: 0, err: '' })
  assert.deepEqual(status(script, ''), { out: '', code: 0, err: '' })
})

test('a session id that is no plain name is never part of a path: the count is right and nothing is kept', () => {
  const { root, script, transcript } = install()
  writeRows(transcript, [BOUNDARY, BOUNDARY])
  assert.equal(status(script, forSession(transcript, '../../escape')).out, '2 compactions\n')
  assert.equal(existsSync(join(root, '.statusline')) ? readdirSync(join(root, '.statusline')).length : 0, 0)
  assert.equal(existsSync(join(root, '..', 'escape.count')), false)
})

const headOf = path => readFileSync(path).subarray(0, HEAD).toString('hex')
const keptFile = root => join(root, '.statusline', `${SESSION}.count`)

test('line 2 marks the file as the one compact-lens installs, so the mod never replaces a file of someone else', () => {
  assert.match(readFileSync(SCRIPT, 'utf8').split('\n')[1], /^# compact-lens-statusline: /)
})

test('the kept count is the owner\'s alone: the file is 0600 in a 0700 folder', () => {
  const { root, script, transcript } = install()
  writeRows(transcript, [BOUNDARY])
  assert.equal(status(script, forSession(transcript)).out, '1 compaction\n')
  assert.equal(statSync(keptFile(root)).mode & 0o777, 0o600)
  assert.equal(statSync(join(root, '.statusline')).mode & 0o777, 0o700)
})

test('a link planted where the count is kept is replaced, never written through', () => {
  const { root, script, transcript } = install()
  writeRows(transcript, [BOUNDARY])
  const outside = join(root, 'outside.txt')
  writeFileSync(outside, 'keep me\n')
  mkdirSync(join(root, '.statusline'), { mode: 0o700 })
  symlinkSync(outside, keptFile(root))
  assert.equal(status(script, forSession(transcript)).out, '1 compaction\n')
  assert.equal(readFileSync(outside, 'utf8'), 'keep me\n')
  assert.ok(lstatSync(keptFile(root)).isFile())
  assert.equal(status(script, forSession(transcript)).out, '1 compaction\n')
})

test('a new file put in place of the transcript is counted from its start, though its first bytes are the same (the inode tells them apart)', () => {
  const { script, transcript } = install()
  writeRows(transcript, [PROMPT, BOUNDARY, PROMPT])
  assert.equal(status(script, forSession(transcript)).out, '1 compaction\n')
  const [inode, head, size] = [statSync(transcript).ino, headOf(transcript), statSync(transcript).size]
  writeFileSync(`${transcript}.new`, lines([PROMPT, BOUNDARY, BOUNDARY, BOUNDARY]))
  renameSync(`${transcript}.new`, transcript)
  // Only the inode differs: the same first bytes, and longer, so a run that went on from the old offset would say 2.
  assert.notEqual(statSync(transcript).ino, inode)
  assert.equal(headOf(transcript), head)
  assert.ok(statSync(transcript).size > size)
  assert.equal(status(script, forSession(transcript)).out, '3 compactions\n')
})

test('the transcript rewritten in place from another start is counted from its start (its first bytes tell them apart)', () => {
  const { script, transcript } = install()
  writeRows(transcript, [PROMPT, BOUNDARY, PROMPT])
  assert.equal(status(script, forSession(transcript)).out, '1 compaction\n')
  const [inode, head, size] = [statSync(transcript).ino, headOf(transcript), statSync(transcript).size]
  writeFileSync(transcript, lines([OTHER, BOUNDARY, BOUNDARY, BOUNDARY]))
  // Only the first bytes differ: the same inode, and longer, so a run that went on from the old offset would say 2.
  assert.equal(statSync(transcript).ino, inode)
  assert.notEqual(headOf(transcript), head)
  assert.ok(statSync(transcript).size > size)
  assert.equal(status(script, forSession(transcript)).out, '3 compactions\n')
})

test('a row cut after its probe still waits for its newline, then counts once', () => {
  const { script, transcript } = install()
  writeRows(transcript, [PROMPT])
  const row = JSON.stringify(BOUNDARY)
  const cut = row.indexOf(PROBE) + PROBE.length + 1
  appendFileSync(transcript, row.slice(0, cut))
  assert.equal(status(script, forSession(transcript)).out, '0 compactions\n')
  appendFileSync(transcript, `${row.slice(cut)}\n`)
  assert.equal(status(script, forSession(transcript)).out, '1 compaction\n')
  assert.equal(status(script, forSession(transcript)).out, '1 compaction\n')
})

/** A prompt row of exactly `length` bytes with its newline. */
const fillerRow = length => {
  const empty = lines([{ type: 'user', message: { role: 'user', content: '' } }])
  const row = lines([{ type: 'user', message: { role: 'user', content: 'x'.repeat(length - empty.length) } }])
  assert.equal(row.length, length)
  return row
}

test('a probe across the edge of a block read counts once, wherever it falls', () => {
  const { script, transcript } = install()
  const boundary = lines([BOUNDARY])
  const probeAt = boundary.indexOf(PROBE)
  mkdirSync(dirname(transcript), { recursive: true })
  // From wholly before the edge, through every split, to wholly after it.
  for (const shift of [-PROBE.length - 1, -PROBE.length, -PROBE.length + 1, -14, -1, 0, 1]) {
    writeFileSync(transcript, fillerRow(BLOCK + shift - probeAt) + boundary + lines([PROMPT, BOUNDARY]))
    rmSync(join(dirname(script), '.statusline'), { recursive: true, force: true })
    assert.equal(status(script, forSession(transcript)).out, '2 compactions\n', `probe at the edge ${shift >= 0 ? '+' : ''}${shift}`)
  }
})

/** A deterministic stream of numbers in [0, 1), so a failure can be run again. */
const seeded = seed => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}

test('a transcript of many blocks is counted row for row, at once or in pieces cut anywhere', () => {
  const { script, transcript } = install()
  const random = seeded(20261027)
  const rows = Array.from({ length: 400 }, () => {
    const pick = random()
    if (pick < 0.15) return BOUNDARY
    if (pick < 0.25) return QUOTING
    return { type: 'user', message: { role: 'user', content: 'y'.repeat(Math.floor(random() * 60000)) } }
  })
  const text = lines(rows)
  const expected = rows.filter(row => row === BOUNDARY).length
  assert.ok(text.length > 4 * BLOCK)
  writeRows(transcript, [])
  const said = n => (n === 1 ? '1 compaction\n' : `${n} compactions\n`)
  let written = 0
  for (const cut of [BLOCK - 3, 2 * BLOCK + 17, 2 * BLOCK + 18, 3 * BLOCK + 99999, text.length]) {
    appendFileSync(transcript, text.slice(written, cut))
    written = cut
    const complete = text.slice(0, text.lastIndexOf('\n', cut - 1) + 1)
    const sofar = rows.slice(0, complete.split('\n').length - 1).filter(row => row === BOUNDARY).length
    assert.equal(status(script, forSession(transcript)).out, said(sofar), `after ${cut} bytes`)
  }
  assert.equal(status(script, forSession(transcript)).out, said(expected))
  rmSync(join(dirname(script), '.statusline'), { recursive: true, force: true })
  assert.equal(status(script, forSession(transcript)).out, said(expected))
})

/** Runs the script as `status` does, but calls `before(pid)` once the process is up and before it reads its input. */
const statusAfter = (script, input, before) =>
  new Promise((resolve, reject) => {
    const child = spawn('perl', [script], { stdio: ['pipe', 'pipe', 'pipe'] })
    const out = []
    child.stdout.on('data', chunk => out.push(chunk))
    child.on('error', reject)
    child.on('close', code => resolve({ out: Buffer.concat(out).toString('utf8'), code }))
    before(child.pid)
    child.stdin.end(JSON.stringify(input))
  })

test('a file or a link left at the temporary name is removed, never written through, and the count is kept', async () => {
  const { root, script, transcript } = install()
  writeRows(transcript, [BOUNDARY, BOUNDARY])
  const outside = join(root, 'outside.txt')
  writeFileSync(outside, 'keep me\n')
  mkdirSync(join(root, '.statusline'), { mode: 0o700 })
  const planted = pid => `${keptFile(root)}.${pid}`
  assert.deepEqual(await statusAfter(script, forSession(transcript), pid => symlinkSync(outside, planted(pid))), { out: '2 compactions\n', code: 0 })
  assert.equal(readFileSync(outside, 'utf8'), 'keep me\n')
  assert.match(readFileSync(keptFile(root), 'utf8'), / 2\n$/)
  assert.deepEqual(readdirSync(join(root, '.statusline')), [`${SESSION}.count`])
  appendFileSync(transcript, lines([BOUNDARY]))
  assert.deepEqual(await statusAfter(script, forSession(transcript), pid => writeFileSync(planted(pid), 'stale')), { out: '3 compactions\n', code: 0 })
  assert.match(readFileSync(keptFile(root), 'utf8'), / 3\n$/)
  assert.deepEqual(readdirSync(join(root, '.statusline')), [`${SESSION}.count`])
})
