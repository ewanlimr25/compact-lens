// The hooks module: it ties the engine's events to the mod's parts, each in a module of its own. The
// validator follows `$` past an import only into `function` declarations, so every part that takes
// `$` is declared that way.
import type { EngineInterface, On, Register } from 'claude-code'

import { afterStep, forgetThreshold, refreshStatus } from './ahead'
import { checkApplicable, markOfferDue, offerCompact, setPending, takeOfferDue } from './apply'
import { runCommand } from './commands'
import { endApply, handleCompact, isApplyRunning } from './compaction'
import { config, readConfig, useConfig } from './config'
import { handleSubmit, handleSubmitFailure } from './edit'
import { needsReading, syncHistory } from './history'
import { buildPromptSection } from './notes'
import { readInBackground, renderPane } from './pane'
import { COMMAND, COMPACT_COMMAND, KEEP_TOOL, PANE_ID, PRUNE_DELAY_MS, SYNC_DELAY_MS } from './paths'
import { pin } from './pins'
import { autoPrune } from './prune'
import { noteTranscript } from './reader'
import { recallPassages } from './restore'
import { makeRootPrivate } from './privacy'
import { ensureSession, log, rootProblem, snapshotRoot } from './session'
import { getPins, getRecords, getSessionDir, isApplyPending } from './state'
import { refreshScript } from './statusline'
import { APPLY_DESCRIPTION, ARGUMENT_HINT, failureText, KEEP_DESCRIPTION, RECALL_DESCRIPTION } from './texts'
import { noteVersion } from './version'

/** The mod's tools and its command, offered for the session. */
async function registerSurface($: EngineInterface): Promise<void> {
  await $.tool.register({
    name: 'keep',
    description: KEEP_DESCRIPTION,
    inputSchema: { type: 'object', properties: { note: { type: 'string', description: 'The fact to keep, verbatim.' } }, required: ['note'] },
  })
  await $.tool.register({ name: 'apply', description: APPLY_DESCRIPTION, inputSchema: { type: 'object', properties: {} } })
  await $.tool.register({
    name: 'recall',
    description: RECALL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The words to search for, all of which a passage holds (all but one where none holds them all); "a quoted phrase" is kept whole.' },
        compaction: { type: 'number', description: "Search only this compaction's span (its number, from 1); every compacted span when left out." },
      },
      required: ['query'],
    },
  })
  await $.command.register({
    name: COMMAND,
    description: 'Compact Lens: what each compaction dropped, given back to Claude on request; edit the summary; pin notes.',
    argumentHint: ARGUMENT_HINT,
  })
}

/**
 * Brings the records up to date with the session's transcript (the look says when it finds compactions
 * the mod had not seen run); with `isLatestRead`, the latest one's lost report is then read in the
 * background, so the pane and /compact-lens lost have it at hand. Never throws.
 */
async function catchUp($: EngineInterface, isLatestRead: boolean): Promise<void> {
  try {
    await syncHistory($)
    await refreshStatus($)
    const latest = (await getRecords($)).at(-1)
    if (isLatestRead && latest !== undefined && needsReading(latest)) $.clock.after(SYNC_DELAY_MS, () => void readInBackground($, latest.n))
  } catch (error) {
    log($, `the session's compactions could not be read from its transcript (${String(error)})`)
  }
}

/** At start: a new version announced; a failure is logged, never thrown. */
async function noteStart($: EngineInterface): Promise<void> {
  await noteVersion($).catch(error => log($, `the version notice was not given (${String(error)})`))
}

/** A catch-up a moment from now, once the engine has written the rows of what just happened. */
function scheduleCatchUp($: EngineInterface, isLatestRead: boolean): void {
  $.clock.after(SYNC_DELAY_MS, () => void catchUp($, isLatestRead))
}

/** The engine's classic events name the session's transcript; a /clear or a /resume also changes the session under the mod. */
async function noteClassic($: EngineInterface, transcriptPath: string | undefined, isNewSession: boolean): Promise<void> {
  try {
    if (isNewSession) await ensureSession($)
    await noteTranscript($, transcriptPath)
  } catch (error) {
    log($, `the session's transcript was not noted (${String(error)})`)
  }
}

/** The model's keep tool: the note pinned, or why not. */
async function keepTool($: EngineInterface, note: unknown): Promise<{ result: string } | { deny: string }> {
  const text = typeof note === 'string' ? note.trim() : ''
  if (text === '') return { deny: 'compact-lens: the note is empty' }
  const { id, count } = await pin($, text)
  return { result: `Pinned note ${id} (${count} pinned). It is kept verbatim through every compaction of this session.` }
}

/** The model's apply tool: summary.md readied, /compact offered to the person when the turn ends. */
async function applyTool($: EngineInterface): Promise<{ result: string } | { deny: string }> {
  const applicable = await checkApplicable($)
  if (typeof applicable === 'string') return { deny: `compact-lens: ${applicable}` }
  await setPending($, true)
  markOfferDue()
  return {
    result: `${applicable.path} is ready. The person applies it with ${COMPACT_COMMAND}: when this turn ends, ${COMPACT_COMMAND} goes into their prompt box, and the mod answers it with the edited summary (no summariser runs; the messages after the summary stay). Tell them to press Enter on it.`,
  }
}

/** The model's recall tool: the compacted passages that mention the query, verbatim. */
async function recallTool($: EngineInterface, query: unknown, compaction: unknown): Promise<{ result: string } | { deny: string }> {
  const words = typeof query === 'string' ? query.trim() : ''
  const n = typeof compaction === 'number' && Number.isInteger(compaction) && compaction > 0 ? compaction : undefined
  const recalled = await recallPassages($, words, n)
  return typeof recalled === 'string' ? { deny: `compact-lens: ${recalled}` } : { result: recalled.block }
}

/** The session-scoped system-prompt section, while the mod's tools are offered. */
async function promptSection($: EngineInterface): Promise<string> {
  const [dir, records, pins] = await Promise.all([getSessionDir($), getRecords($), getPins($)])
  return buildPromptSection({ sessionDir: dir ?? '(unset)', records, pinnedCount: pins.length })
}

/**
 * At start: a dir option set aside says so, the snapshot root is made private (its snapshots copy the
 * transcripts), and only a private root's status-line script is checked and kept current. Where no
 * program can run (a surface without processes), nothing is said: no script can run there either.
 */
async function secureRoot($: EngineInterface): Promise<void> {
  const [problem, root] = await Promise.all([rootProblem($), snapshotRoot($)])
  if (problem !== undefined) $.ui.toast(`${problem}; snapshots go to ${root} instead`)
  const privacy = await makeRootPrivate($)
  if (privacy.kind === 'refused') log($, `${root} could not be made private (${privacy.reason}): its snapshots copy your transcripts, which Claude Code keeps for your eyes alone`)
  if (privacy.kind !== 'private') return
  await refreshScript($).catch(error => log($, `the status-line script was not checked (${String(error)})`))
}

/** The session's start, its switches (/clear, /resume) and compactions run without the mod's hook. */
function onSession(on: On): void {
  on('session.start', async ($, e, next) => {
    await ensureSession($)
    await registerSurface($)
    await secureRoot($)
    await catchUp($, true)
    await noteStart($)
    if (config().keepDays > 0) $.clock.after(PRUNE_DELAY_MS, () => void autoPrune($))
    if (config().openPane && e.isInteractive) void $.ui.open({ id: PANE_ID, title: 'Compact Lens' })
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    const isNewSession = e.source === 'clear' || e.source === 'resume' || e.source === 'fork'
    await noteClassic($, e.transcript_path, isNewSession)
    if (isNewSession) scheduleCatchUp($, true)
    return next(e)
  })

  on('classic.PostCompact', async ($, e, next) => {
    if (e.agent_id === undefined) {
      await noteClassic($, e.transcript_path, false)
      scheduleCatchUp($, false)
    }
    return next(e)
  })
}

/** Each compaction recorded as it runs, the context read at every step, the apply offered when a turn ends, and the auto-compaction line forgotten when it may move. */
function onTurns(on: On): void {
  on('session.compact', ($, e, next) => handleCompact($, e, next)).catch(($, e, next) => {
    if (!isApplyRunning() || e.trigger !== 'manual' || e.agentId !== undefined) {
      log($, `the compaction hook failed and stood aside: ${failureText(next.error)}`)
      return next(e)
    }
    endApply()
    return { skip: `compact-lens: the edit could not be applied (${failureText(next.error)}), so nothing changed; it still waits: ${COMPACT_COMMAND} tries again, /${COMMAND} cancel drops it` }
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId === undefined) await afterStep($).catch(error => log($, `the context was not read after the step (${String(error)})`))
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && takeOfferDue() && (await isApplyPending($))) await offerCompact($)
    return result
  })

  // Where auto-compaction runs can move with the settings (auto-compaction turned off, its window) or the model.
  on('classic.ConfigChange', ($, e, next) => {
    forgetThreshold()
    return next(e)
  })

  on('classic.PostModelSwitch', ($, e, next) => {
    forgetThreshold()
    return next(e)
  })
}

/** The model's three tools. */
function onTools(on: On): void {
  on('tool.call', { tool: 'mcp__compact-lens__keep' }, ($, e) => keepTool($, e.note)).catch(($, e, next) => ({
    deny: `compact-lens: keep failed: ${failureText(next.error)}`,
  }))

  on('tool.call', { tool: 'mcp__compact-lens__apply' }, $ => applyTool($)).catch(($, e, next) => ({
    deny: `compact-lens: apply failed: ${failureText(next.error)}`,
  }))

  on('tool.call', { tool: 'mcp__compact-lens__recall' }, ($, e) => recallTool($, e.query, e.compaction)).catch(($, e, next) => ({
    deny: `compact-lens: recall failed: ${failureText(next.error)}`,
  }))
}

/** The person's side: the command, the prompt box's edit, the system-prompt section and the pane. */
function onPerson(on: On): void {
  on('command.run', { command: COMMAND }, ($, e) => runCommand($, e.args, e.origin)).catch(($, e, next) => ({
    text: `the command failed: ${failureText(next.error)}`,
  }))

  on('prompt.submit', ($, e, next) => handleSubmit($, e, next)).catch(($, e, next) => handleSubmitFailure($, e, next.error, next))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes(KEEP_TOOL)) return composed
    return { sections: [...composed.sections, { id: 'compact-lens:lens', text: await promptSection($), scope: 'session' }] }
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, ($, e) => renderPane($, e))
}

export const register: Register = (on, options) => {
  useConfig(readConfig(options))
  onSession(on)
  onTurns(on)
  onTools(on)
  onPerson(on)
}
