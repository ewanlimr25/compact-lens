import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { HOME, setup, START } from './kit'

const PRESENTATION = { isFullscreen: true, columns: 120 }
const run = ($: Engine, args: string) => $.command.run({ command: 'compact-lens', args, origin: { kind: 'composer' }, presentation: PRESENTATION })
const LENS = `${HOME}/.claude/compact-lens`
const privacyCommands = (spawned: readonly string[][]): string[][] => spawned.filter(argv => argv[0] === '/bin/mkdir' || argv[0] === '/bin/chmod')

for (const [dir, reason] of [
  ['snaps', 'the dir option "snaps" is not a full path (one starting with / or ~/)'],
  ['~', 'the dir option "~" is your home folder or a folder above it'],
  ['/', 'the dir option "/" is your home folder or a folder above it'],
  ['~/lens/../..', 'the dir option "~/lens/../.." is your home folder or a folder above it'],
  ['/HOME/Tester', 'the dir option "/HOME/Tester" is your home folder or a folder above it'],
] as const) {
  test(`the dir option "${dir}" gives way to the default folder, and a toast and doctor say why`, { options: { dir } }, async ($, on) => {
    const world = setup(on)
    await $.session.start(START)

    const doctor = await run($, 'doctor')

    expect(world.toasts).toContain(`${reason}; snapshots go to ${LENS} instead`)
    expect(doctor.text?.split('\n')).toContain(`✗ ${reason}; snapshots go to ${LENS} instead`)
    expect(privacyCommands(world.spawned)).toEqual([
      ['/bin/mkdir', '-p', '-m', '700', LENS],
      ['/bin/chmod', '700', LENS],
    ])
  })
}

test('a dir option under the home folder is used as it reads, its trailing slash dropped, with no toast', { options: { dir: '~/snaps/' } }, async ($, on) => {
  const world = setup(on)
  await $.session.start(START)

  const doctor = await run($, 'doctor')

  expect(doctor.text).toContain(`– snapshots: ${HOME}/snaps: none yet`)
  expect(doctor.text).not.toContain('✗')
  expect(world.toasts.filter(toast => toast.includes('dir option'))).toEqual([])
})

test('at start the snapshot folder is made private, as Claude Code keeps its transcripts: created 700 and set to 700, or set to 700 when there', async ($, on) => {
  const world = setup(on)
  await $.session.start(START)
  world.files.set(`${LENS}/a/01/meta.json`, '{}')
  await $.session.start(START)

  expect(privacyCommands(world.spawned)).toEqual([
    ['/bin/mkdir', '-p', '-m', '700', LENS],
    ['/bin/chmod', '700', LENS],
    ['/bin/chmod', '700', LENS],
  ])
})

test('a dir option naming a file, or a folder that cannot be listed, is never changed: a log line says why', { options: { dir: '~/notes.md' } }, async ($, on) => {
  const world = setup(on)
  world.files.set(`${HOME}/notes.md`, 'my notes')
  await $.session.start(START)

  expect(privacyCommands(world.spawned)).toEqual([])
  expect(world.logs).toContain(`${HOME}/notes.md could not be made private (it is not a folder): its snapshots copy your transcripts, which Claude Code keeps for your eyes alone`)
})

test('a snapshot folder whose details cannot be read is left as it is, never taken for one that is missing', async ($, on) => {
  const world = setup(on, { statFails: path => path === LENS })
  world.files.set(`${LENS}/a/01/meta.json`, '{}')
  await $.session.start(START)

  expect(privacyCommands(world.spawned)).toEqual([])
  expect(world.logs).toContain(`${LENS} could not be made private (it could not be read): its snapshots copy your transcripts, which Claude Code keeps for your eyes alone`)
})

test('a snapshot folder that cannot be listed keeps its mode: what it holds is unknown', async ($, on) => {
  const world = setup(on, { listFails: path => path === LENS })
  world.files.set(`${LENS}/a/01/meta.json`, '{}')
  await $.session.start(START)

  expect(privacyCommands(world.spawned)).toEqual([])
  expect(world.logs).toContain(`${LENS} could not be made private (it could not be listed): its snapshots copy your transcripts, which Claude Code keeps for your eyes alone`)
})

test("numbered folders holding files compact-lens did not write are someone else's: a photo library keeps its mode", { options: { dir: '~/Photos' } }, async ($, on) => {
  const world = setup(on)
  world.files.set(`${HOME}/Photos/2023/07/beach.jpg`, 'jpg')
  await $.session.start(START)

  expect(privacyCommands(world.spawned)).toEqual([])
  expect(world.logs).toContain(
    `${HOME}/Photos could not be made private (it holds files compact-lens did not write (2023), so its mode was left as it is): its snapshots copy your transcripts, which Claude Code keeps for your eyes alone`,
  )
})

test('a snapshot folder that cannot be made private is logged, and the status-line script is never installed there', async ($, on) => {
  const world = setup(on, { chmodFails: true })
  const older = '#!/usr/bin/env perl\n# compact-lens-statusline: an older one\nprint "older\\n";\n'
  world.files.set(`${LENS}/statusline.pl`, older)
  await $.session.start(START)
  expect(world.files.get(`${LENS}/statusline.pl`)).toBe(older)
  world.files.delete(`${LENS}/statusline.pl`)

  const reply = await run($, 'statusline')

  expect(world.logs).toContain(`${LENS} could not be made private (chmod ended with code 1): its snapshots copy your transcripts, which Claude Code keeps for your eyes alone`)
  expect(reply.text).toBe(`nothing was installed: ${LENS} could not be made private (chmod ended with code 1), and a script there that others could change would run in your status line`)
  expect(world.files.has(`${LENS}/statusline.pl`)).toBe(false)
})

test("a folder holding files compact-lens did not write keeps its mode: no chmod, a log line, doctor's ✗, and no script installed or updated", { options: { dir: '~/Public' } }, async ($, on) => {
  const world = setup(on)
  world.files.set(`${HOME}/Public/.localized`, '')
  world.files.set(`${HOME}/Public/Drop Box/note.txt`, 'shared')
  world.files.set(`${HOME}/Public/statusline.pl`, '#!/usr/bin/env perl\n# compact-lens-statusline: an older one\nprint "older\\n";\n')
  await $.session.start(START)

  const reply = await run($, 'statusline')
  const doctor = await run($, 'doctor')

  const reason = 'it holds files compact-lens did not write (.localized, Drop Box), so its mode was left as it is'
  const lines = doctor.text?.split('\n') ?? []
  expect(privacyCommands(world.spawned)).toEqual([])
  expect(world.logs).toContain(`${HOME}/Public could not be made private (${reason}): its snapshots copy your transcripts, which Claude Code keeps for your eyes alone`)
  expect(reply.text).toBe(`nothing was installed: ${HOME}/Public could not be made private (${reason}), and a script there that others could change would run in your status line`)
  expect(lines).toContain(`✗ ${HOME}/Public was not made private: ${reason}`)
  expect(lines).toContain(`– status-line script: ${HOME}/Public/statusline.pl differs from this version's, and is not updated while the folder is not made private`)
})

test("a copy of the status-line script under another name, its marked second line kept, is compact-lens's: the folder is still made private", async ($, on) => {
  const world = setup(on)
  world.files.set(`${LENS}/a/01/meta.json`, '{}')
  world.files.set(`${LENS}/my-statusline.pl`, '#!/usr/bin/env perl\n# compact-lens-statusline: my copy\nprint "mine\\n";\n')
  await $.session.start(START)

  expect(privacyCommands(world.spawned)).toEqual([['/bin/chmod', '700', LENS]])
  expect(world.logs.filter(line => line.includes('private'))).toEqual([])
})

test('a folder that leads to the home folder through a link is never made private', { options: { dir: '~/lens' } }, async ($, on) => {
  const world = setup(on)
  world.files.set(`${HOME}/lens/x/01/meta.json`, '{}')
  world.links.set(`${HOME}/lens`, HOME)
  await $.session.start(START)

  expect(privacyCommands(world.spawned)).toEqual([])
  expect(world.logs).toContain(`${HOME}/lens could not be made private (it leads to ${HOME}, your home folder or a folder above it): its snapshots copy your transcripts, which Claude Code keeps for your eyes alone`)
})

test('where no process can run, the start says nothing of privacy', async ($, on) => {
  const world = setup(on, { processes: false })
  await $.session.start(START)

  expect(world.logs.filter(line => line.includes('private'))).toEqual([])
})

test('where /bin holds no chmod or mkdir, the ones on the PATH make the folder private', async ($, on) => {
  const world = setup(on, { binMissing: true })
  await $.session.start(START)
  world.files.set(`${LENS}/a/01/meta.json`, '{}')
  await $.session.start(START)

  expect(world.spawned.filter(argv => ['mkdir', 'chmod'].includes(argv[0] ?? ''))).toEqual([
    ['mkdir', '-p', '-m', '700', LENS],
    ['chmod', '700', LENS],
    ['chmod', '700', LENS],
  ])
  expect(world.logs.filter(line => line.includes('private'))).toEqual([])
})
