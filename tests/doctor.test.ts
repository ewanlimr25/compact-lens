import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { PERL_VERSION } from './host'
import { BUNDLED_SCRIPT, ENGINE_VERSION, HOME, MOD_VERSION, setup, START, TRANSCRIPT, writeTranscript } from './kit'
import { twoCompactions } from './rows'

const PRESENTATION = { isFullscreen: true, columns: 120 }
const run = ($: Engine, args: string) => $.command.run({ command: 'compact-lens', args, origin: { kind: 'composer' }, presentation: PRESENTATION })
const LENS = `${HOME}/.claude/compact-lens`

test('doctor names the versions, the transcript and its count, the status line, perl, the snapshots and the script', async ($, on) => {
  const world = setup(on)
  writeTranscript(world, twoCompactions())
  await $.session.start(START)

  const doctor = await run($, 'doctor')

  const lines = (doctor.text ?? '').split('\n')
  expect(lines[0]).toMatch(new RegExp(`^compact-lens ${MOD_VERSION.replace(/\./g, '\\.')} on Claude Code ${ENGINE_VERSION.replace(/\./g, '\\.')}, loaded from /`))
  expect(lines).toContain(`✓ transcript: ${TRANSCRIPT} holds 2 compactions; all 2 are recorded`)
  expect(lines).toContain(`✓ status line: the mod sets "${world.status}"; if it does not show under the prompt, /compact-lens statusline puts the count in your own status line`)
  expect(lines).toContain(`✓ perl ${PERL_VERSION}: a search takes one pass over the transcript`)
  expect(lines.some(line => line.startsWith(`✓ snapshots: ${LENS}: 1 session, `) && line.endsWith('kept until you prune them (/compact-lens prune <days>)'))).toBe(true)
  expect(lines).toContain('– status-line script: not installed; /compact-lens statusline puts the count in your own status line (ccstatusline or Claude Code\'s)')
})

test('doctor says plainly when there is no transcript yet, perl is missing and the status line is off', { options: { statusLine: false } }, async ($, on) => {
  setup(on, { perl: false })
  await $.session.start(START)

  const doctor = await run($, 'doctor')

  const lines = (doctor.text ?? '').split('\n')
  expect(lines).toContain("– transcript: none yet; Claude Code writes it with the session's first message")
  expect(lines).toContain('– status line: off (the statusLine option); /compact-lens statusline can show the count in your own status line')
  expect(lines).toContain('– perl: not found; grep reads the transcript instead, more slowly on a large one')
  expect(lines).toContain(`– snapshots: ${LENS}: none yet`)
})

test('doctor tells an installed script that is current from one an older version left', async ($, on) => {
  const world = setup(on)
  await $.session.start(START)
  world.files.set(`${LENS}/statusline.pl`, BUNDLED_SCRIPT)
  const current = await run($, 'doctor')
  world.files.set(`${LENS}/statusline.pl`, '#!/usr/bin/env perl\n# compact-lens-statusline: an older one\nprint "older\\n";\n')
  const stale = await run($, 'doctor')

  expect(current.text).toContain(`✓ status-line script: ${LENS}/statusline.pl, current`)
  expect(stale.text).toContain(`– status-line script: ${LENS}/statusline.pl differs from this version's; a session start of the version you want replaces it`)
})

test("doctor counts the session folders holding anything of the mod's and their size, and names the keepDays rule when it is set", { options: { keepDays: 14 } }, async ($, on) => {
  const world = setup(on)
  world.files.set(`${LENS}/0b6f2c1e-1111-4222-8333-944445555666/01/meta.json`, 'x'.repeat(2048))
  world.files.set(`${LENS}/0b6f2c1e-1111-4222-8333-944445555666/01/before.md`, 'y'.repeat(1024))
  // A file of someone else's beside the mod's: a prune keeps the folder, and doctor still counts it.
  world.files.set(`${LENS}/1c7e3d2f-2222-4333-9444-a55556666777/01/meta.json`, 'x'.repeat(1024))
  world.files.set(`${LENS}/1c7e3d2f-2222-4333-9444-a55556666777/01/notes.txt`, 'n'.repeat(1024))
  world.files.set(`${LENS}/.statusline/sess-1`, 'cache')
  await $.session.start(START)

  const doctor = await run($, 'doctor')

  expect(doctor.text).toContain(`✓ snapshots: ${LENS}: 2 sessions, 5.0 KB; sessions untouched for 14 days are removed at start while their transcripts are still there (keepDays)`)
})

test('a new version says so once, naming the one before; a reload of the same version says nothing', async ($, on) => {
  const world = setup(on, { store: false })
  mock.store(on, { version: '0.4.0' })
  await $.session.start(START)
  await $.session.start(START)

  const notices = world.toasts.filter(toast => toast.includes('is running'))
  expect(notices).toEqual([`compact-lens ${MOD_VERSION} is running (was 0.4.0). /compact-lens doctor checks the setup; /compact-lens statusline puts the count in your own status line`])
})

test("the first start remembers the version and says it once; a manifest it cannot read changes nothing", async ($, on) => {
  const world = setup(on)
  await $.session.start(START)
  world.manifest = 'not json'
  await $.session.start(START)

  const notices = world.toasts.filter(toast => toast.includes('is running'))
  expect(notices).toEqual([`compact-lens ${MOD_VERSION} is running. /compact-lens doctor checks the setup; /compact-lens statusline puts the count in your own status line`])
})

test('doctor and the version notice survive an engine that cannot say its version', async ($, on) => {
  const world = setup(on)
  world.engineVersion = ''
  await $.session.start(START)

  const doctor = await run($, 'doctor')

  expect((doctor.text ?? '').split('\n')[0]).toMatch(/^compact-lens 0\.5\.0-test on Claude Code \(version unknown\), loaded from \//)
  expect(world.logs.filter(line => line.includes('failed'))).toEqual([])
})

test("doctor says when keepDays is at or past Claude Code's cleanupPeriodDays, where it removes nothing", { options: { keepDays: 30 } }, async ($, on) => {
  const world = setup(on)
  world.files.set(`${LENS}/0b6f2c1e-1111-4222-8333-944445555666/01/meta.json`, '{}')
  await $.session.start(START)

  const doctor = await run($, 'doctor')

  expect(doctor.text).toContain(
    '; keepDays (30) removes no snapshots: Claude Code deletes a transcript after 30 days (cleanupPeriodDays), and keepDays keeps the snapshots of a session whose transcript is that old or gone, as their only copy; set it under 30',
  )
  expect(doctor.text).toMatch(/^– snapshots: /m)
})

test('doctor names the keepDays rule where cleanupPeriodDays keeps transcripts longer', { options: { keepDays: 30 } }, async ($, on) => {
  const world = setup(on)
  world.settings = { cleanupPeriodDays: 90 }
  world.files.set(`${LENS}/0b6f2c1e-1111-4222-8333-944445555666/01/meta.json`, '{}')
  await $.session.start(START)

  const doctor = await run($, 'doctor')

  expect(doctor.text).toContain(`✓ snapshots: ${LENS}: 1 session, 2 B; sessions untouched for 30 days are removed at start while their transcripts are still there (keepDays)`)
})
