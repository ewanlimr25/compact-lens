#!/usr/bin/env node
// Runs compact-lens's own modules against any transcript, outside Claude Code, so a report such as
// "recall did not find X" can be reproduced from the transcript file alone:
//
//   node tools/replay.mjs <transcript.jsonl> list
//   node tools/replay.mjs <transcript.jsonl> lost [n]
//   node tools/replay.mjs <transcript.jsonl> prompts [n]
//   node tools/replay.mjs <transcript.jsonl> recall "<words>" [n]
//
// The answer goes to standard output. What the mod would have shown on the side (its toasts and log
// lines) and the time taken go to standard error. The snapshots the mod writes go under a scratch home
// that is removed when the run ends, by Ctrl-C or a kill too; --keep keeps it and says where. It needs a Node that strips
// TypeScript types by itself (22.18 or later), and perl or grep, and sed, as the mod does.
import { mkdtempSync, rmSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

import { createEngine } from './engine.mjs'

register('./loader.mjs', import.meta.url)

/** The mod's folder: the one tools/ is in. */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Exit codes: the mod answered; the mod said why it could not; the command line was wrong. */
const EXIT = Object.freeze({ answered: 0, refused: 1, usage: 2 })
/** Exit codes after Ctrl-C or a kill: 128 and the signal's number, as a shell reports them. */
const SIGNAL_EXIT = Object.freeze({ SIGINT: 130, SIGTERM: 143 })

const USAGE = [
  'usage: node tools/replay.mjs <transcript.jsonl> <command> [--keep]',
  '  list                    every compaction the transcript holds, with its lines',
  '  lost [n]                what compaction n dropped (the latest when n is left out), as lost.md has it',
  '  prompts [n]             the person\'s prompts from compaction n\'s span, as a restore hands them to Claude',
  '  recall "<words>" [n]    the compacted passages that hold the words, as the recall tool returns them',
  '  --keep                  keep the scratch home the snapshots went to, and say where it is',
].join('\n')

/** A compaction's number as the mod's commands take it: `2` or `#2`. */
const numberIn = word => (word !== undefined && /^#?\d+$/.test(word) ? Number(word.replace('#', '')) : undefined)

/** The command line: the transcript, the command and its words, and whether the snapshots are kept. */
const parseArgs = argv => {
  const isKept = argv.includes('--keep')
  const [transcript, command, ...words] = argv.filter(arg => arg !== '--keep')
  return { transcript, command, words, isKept }
}

/** The mod's modules, loaded once the resolve hook is in place. */
async function loadModules() {
  const [session, reader, history, restore, state, paths, records, report] = await Promise.all(
    ['session', 'reader', 'history', 'restore', 'state', 'paths', 'records', 'report'].map(name => import(`../hooks/${name}.ts`)),
  )
  return { ...session, ...reader, ...history, ...restore, ...state, ...paths, ...records, ...report }
}

/** One compaction as `list` prints it: number, trigger, time, tokens and where it stands in the transcript. */
const listLine = (mod, record) => {
  const span = record.span
  const lines = span === undefined ? 'not in the transcript' : `lines ${span.from}–${span.to}, boundary ${span.boundary}${span.summary === undefined ? '' : `, summary ${span.summary}`}`
  return `  #${record.n} ${record.trigger.padEnd(6)} ${mod.shortTime(record.at)}  ${mod.tokensOf(record)} tokens  ${lines}`
}

async function listText(mod, $, transcript) {
  const synced = await mod.syncHistory($)
  const records = await mod.getRecords($)
  const state = synced.transcript === 'read' ? 'read from the transcript' : `the transcript is ${synced.transcript}`
  return { text: [`${transcript}`, `${records.length} compaction${records.length === 1 ? '' : 's'}, ${state}`, ...records.map(r => listLine(mod, r))].join('\n') }
}

async function lostText(mod, $, words) {
  await mod.syncHistory($)
  const n = numberIn(words[0]) ?? (await mod.getRecords($)).at(-1)?.n
  if (n === undefined) return { refusal: 'no compaction has run in this session yet' }
  const record = await mod.materialize($, n)
  if (typeof record === 'string') return { refusal: record }
  return { text: await $.fs.read(mod.compactionFiles(await mod.ensureSession($), record.n).lost) }
}

async function promptsText(mod, $, words) {
  const restored = await mod.restorePrompts($, numberIn(words[0]), true)
  return typeof restored === 'string' ? { refusal: restored } : { text: restored.block }
}

async function recallText(mod, $, words) {
  const [query = '', compaction] = words
  const recalled = await mod.recallPassages($, query, numberIn(compaction))
  return typeof recalled === 'string' ? { refusal: recalled } : { text: recalled.block }
}

/** Runs the command on the session; the mod's answer, or why it gave none. */
async function runCommand(mod, $, { transcript, command, words }) {
  await mod.ensureSession($)
  await mod.noteTranscript($, transcript)
  if (command === 'list') return listText(mod, $, transcript)
  if (command === 'lost') return lostText(mod, $, words)
  if (command === 'prompts') return promptsText(mod, $, words)
  return recallText(mod, $, words)
}

/** Why the command line cannot run, or undefined when it can. */
async function usageProblem({ transcript, command }) {
  if (transcript === undefined || !['list', 'lost', 'prompts', 'recall'].includes(command ?? '')) return USAGE
  const kind = await stat(transcript).then(
    found => (found.isFile() ? 'file' : 'other'),
    () => 'none',
  )
  return kind === 'file' ? undefined : `${transcript}: no such transcript file\n${USAGE}`
}

/** Removes the scratch home, or says where it is kept; synchronous, so a signal's handler can run it. */
const leaveHome = (home, isKept) => {
  if (isKept) process.stderr.write(`replay: the snapshots are kept in ${home}\n`)
  else rmSync(home, { recursive: true, force: true })
}

/** Runs `stop` with the exit code on Ctrl-C or a kill, until the function it returns removes the handlers. */
const onSignals = stop => {
  const handlers = Object.entries(SIGNAL_EXIT).map(([signal, code]) => [signal, () => stop(code)])
  handlers.forEach(([signal, handler]) => process.once(signal, handler))
  return () => handlers.forEach(([signal, handler]) => process.off(signal, handler))
}

async function main(argv) {
  const args = parseArgs(argv)
  const problem = await usageProblem(args)
  if (problem !== undefined) {
    process.stderr.write(`${problem}\n`)
    return EXIT.usage
  }
  const started = performance.now()
  const transcript = resolve(args.transcript)
  // The handlers come first: a signal is handled between steps, so once the home is made it is known to them.
  let home
  const unwatch = onSignals(code => {
    if (home !== undefined) leaveHome(home, args.isKept)
    process.exit(code)
  })
  home = mkdtempSync(join(tmpdir(), 'compact-lens-replay-'))
  const note = (kind, text) => process.stderr.write(`[${kind}] ${text}\n`)
  try {
    const mod = await loadModules()
    const loaded = performance.now()
    const $ = createEngine({ transcript, home, root: ROOT, note })
    const answer = await runCommand(mod, $, { ...args, transcript })
    const ms = n => `${Math.round(n)} ms`
    process.stderr.write(`replay: ${args.command} in ${ms(performance.now() - loaded)} (modules loaded in ${ms(loaded - started)})\n`)
    if (answer.refusal !== undefined) {
      process.stdout.write(`the mod gave no answer: ${answer.refusal}\n`)
      return EXIT.refused
    }
    process.stdout.write(answer.text.endsWith('\n') ? answer.text : `${answer.text}\n`)
    return EXIT.answered
  } finally {
    unwatch()
    leaveHome(home, args.isKept)
  }
}

process.exitCode = await main(process.argv.slice(2))
