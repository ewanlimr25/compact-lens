import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { SCRIPT_RECHECK_MS } from '../hooks/paths'
import { APPLY, BEFORE, BUNDLED_SCRIPT, DIR, HOME, KEEP, SESSION, setup, START, SUMMARY } from './kit'

const PRESENTATION = { isFullscreen: true, columns: 120 }
const run = ($: Engine, args: string) => $.command.run({ command: 'compact-lens', args, origin: { kind: 'composer' }, presentation: PRESENTATION })
const LENS = `${HOME}/.claude/compact-lens`
const STATUS = `${LENS}/.statusline/${SESSION}.json`
/** A copy an older compact-lens wrote, its marker on line 2, and a statusline.pl of the person's own. */
const MARKED_OLDER = '#!/usr/bin/env perl\n# compact-lens-statusline: an older one\nprint "older\\n";\n'
const FOREIGN = '#!/usr/bin/env perl\nprint "mine\\n";\n'
const step = async ($: Engine, index: number) => {
  const stream = $.turn.step({ turnId: 't1', index, model: 'm', messageCount: 3 })
  for await (const piece of stream) void piece
  return stream.result
}

test('statusline installs the script beside the snapshots and says how to put it in ccstatusline or Claude Code', async ($, on) => {
  const world = setup(on)
  await $.session.start(START)

  const reply = await run($, 'statusline')

  expect(world.files.get(`${LENS}/statusline.pl`)).toBe(BUNDLED_SCRIPT)
  const text = reply.text ?? ''
  expect(text).toContain(`installed ${LENS}/statusline.pl: it prints this session's compactions, counted from its transcript, and the pinned notes, as in "2 compactions · 1 pinned"`)
  expect(text).toContain(`ccstatusline: run npx -y ccstatusline@latest in a terminal to open its settings (ccstatusline, once pinned), add a Custom Command widget, and set its command to  perl ${LENS}/statusline.pl`)
  expect(text).toContain(`  "statusLine": { "type": "command", "command": "perl ${LENS}/statusline.pl" }`)
  expect(text).toContain('Each session start puts its own version of the script in place. To change it, copy it under another name in the same folder')
  expect(JSON.parse(world.files.get(STATUS) ?? '{}')).toEqual({ compactions: 0, pinned: 0, pending: false })
})

test("once installed, the session's status is written for the script when it changes, and only then", async ($, on) => {
  const world = setup(on)
  await $.session.start(START)
  await run($, 'statusline')

  await $.tool.call({ tool: KEEP, note: 'the staging database is db-stg-2' })
  expect(JSON.parse(world.files.get(STATUS) ?? '{}')).toEqual({ compactions: 0, pinned: 1, pending: false })
  const first = await $.session.compact({ trigger: 'auto', messages: BEFORE })
  world.transcript = [...(first.messages ?? [])]
  world.files.set(`${DIR}/01/summary.md`, `${SUMMARY}\nEdited.`)
  await $.tool.call({ tool: APPLY })
  expect(JSON.parse(world.files.get(STATUS) ?? '{}')).toEqual({ compactions: 1, pinned: 1, pending: true })

  const before = world.mtimes.get(STATUS)
  await step($, 0)
  await step($, 1)
  expect(world.mtimes.get(STATUS)).toBe(before)
})

test('without the script installed, no status file is written', async ($, on) => {
  const world = setup(on)
  await $.session.start(START)
  await $.tool.call({ tool: KEEP, note: 'a fact' })

  expect([...world.files.keys()].some(path => path.includes('/.statusline/'))).toBe(false)
})

test('at start, a copy an older version installed is replaced with this one, and a current copy is left as it is', async ($, on) => {
  const world = setup(on)
  world.files.set(`${LENS}/statusline.pl`, MARKED_OLDER)
  await $.session.start(START)
  expect(world.files.get(`${LENS}/statusline.pl`)).toBe(BUNDLED_SCRIPT)

  const written = world.mtimes.get(`${LENS}/statusline.pl`)
  await $.session.start(START)
  expect(world.mtimes.get(`${LENS}/statusline.pl`)).toBe(written)
  expect(world.files.has(STATUS)).toBe(true)
})

test("a statusline.pl compact-lens did not write is never replaced, at start or by the command, and doctor says so", async ($, on) => {
  const world = setup(on)
  world.files.set(`${LENS}/statusline.pl`, FOREIGN)
  await $.session.start(START)

  const reply = await run($, 'statusline')
  const doctor = await run($, 'doctor')

  expect(world.files.get(`${LENS}/statusline.pl`)).toBe(FOREIGN)
  expect(reply.text).toBe(`nothing was installed: ${LENS}/statusline.pl is a file compact-lens did not write; move it, then ask again`)
  expect(doctor.text).toContain(`✗ status-line script: ${LENS}/statusline.pl is not compact-lens's; move it, then /compact-lens statusline`)
  expect(world.files.has(STATUS)).toBe(false)
})

test('a session started before the script was installed writes its status once the script is there', async ($, on) => {
  const world = setup(on)
  await $.session.start(START)
  world.files.set(`${LENS}/statusline.pl`, BUNDLED_SCRIPT)

  await $.tool.call({ tool: KEEP, note: 'a fact' })
  expect(world.files.has(STATUS)).toBe(false)
  await world.clock.advance(SCRIPT_RECHECK_MS)
  await $.tool.call({ tool: KEEP, note: 'another fact' })

  expect(JSON.parse(world.files.get(STATUS) ?? '{}')).toEqual({ compactions: 0, pinned: 2, pending: false })
})

test('a snapshot folder with a tilde in its path is quoted, so no shell reads it as a home folder', { options: { dir: '/home/tester/a~b' } }, async ($, on) => {
  setup(on)
  await $.session.start(START)

  const reply = await run($, 'statusline')

  expect(reply.text).toContain("set its command to  perl '/home/tester/a~b/statusline.pl'")
})

test('a snapshot folder with a space in its path is quoted in the commands it gives', { options: { dir: '/home/tester/my snaps' } }, async ($, on) => {
  setup(on)
  await $.session.start(START)

  const reply = await run($, 'statusline')

  expect(reply.text).toContain("set its command to  perl '/home/tester/my snaps/statusline.pl'")
  expect(reply.text).toContain(`"command": "perl '/home/tester/my snaps/statusline.pl'"`)
})

test('a status file that cannot be written is logged, and the pin and the status line go on', async ($, on) => {
  const world = setup(on, { failWrite: path => path.endsWith('.json') && path.includes('/.statusline/') })
  await $.session.start(START)
  await run($, 'statusline')

  const kept = await $.tool.call({ tool: KEEP, note: 'the staging database is db-stg-2' })

  expect('result' in kept && String(kept.result)).toContain('Pinned note 1')
  expect(world.status).toContain('1 pinned')
  expect(world.logs.some(line => line.includes(`${STATUS} was not written for the status-line script`))).toBe(true)
})
