// The context as it fills: the status line, and one warning to the model per window ahead of the
// compaction. Both are measured against where auto-compaction runs, which can sit far below the
// model's window (a 500k compaction window on a 1M model compacts at about 47% of the window).
import type { EngineInterface } from 'claude-code'

import type { CompactLensContext } from '../types'
import { config } from './config'
import { buildWarning, contextPhrase, progressPercent } from './notes'
import { ensureSession, log } from './session'
import { getContext, getPins, getRecords, getWarnedAt, isApplyPending, setContext, setWarnedAt } from './state'
import { writeStatusFile } from './statusline'
import { statusLineText } from './texts'

/** Where auto-compaction runs, for one session and window: read from the engine's breakdown, again after a compaction or a /model switch (the window changes). */
let threshold: { sessionId: string; window: number; value: number | null } | undefined

/** Drops the remembered auto-compaction line: a compaction may move it. */
export function forgetThreshold(): void {
  threshold = undefined
}

async function thresholdOf($: EngineInterface, sessionId: string, window: number): Promise<number | null> {
  if (threshold?.sessionId === sessionId && threshold.window === window) return threshold.value
  try {
    const breakdown = (await $.session.usage({ breakdown: 'summary' })).context.breakdown
    const value = breakdown === undefined || !breakdown.isAutoCompactEnabled ? null : (breakdown.autoCompactThreshold ?? null)
    threshold = { sessionId, window, value }
    return value
  } catch {
    // Not remembered: the next step reads it again.
    return null
  }
}

/** The line under the prompt (unless the statusLine option turns it off), and the session's status for the status-line script. */
export async function refreshStatus($: EngineInterface): Promise<void> {
  const [context, records, pins, isPending] = await Promise.all([getContext($), getRecords($), getPins($), isApplyPending($)])
  $.ui.status(config().statusLine ? statusLineText({ context, records, pinCount: pins.length, isPending }) : undefined)
  await writeStatusFile($, { compactions: records.length, pinned: pins.length, pending: isPending })
}

/** The context from the free usage call, against auto-compaction's line; undefined before the first response. */
export async function readContext($: EngineInterface): Promise<CompactLensContext | undefined> {
  const usage = (await $.session.usage()).context
  if (usage.tokens === undefined) return undefined
  const context = { tokens: usage.tokens, window: usage.window, threshold: await thresholdOf($, await $.session.id(), usage.window) }
  await setContext($, context)
  return context
}

/** Appends a hidden user-role note; the reason when it could not be. */
export async function appendNote($: EngineInterface, text: string): Promise<string | undefined> {
  try {
    const appended = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
    return appended.deny
  } catch (error) {
    return String(error)
  }
}

/** After a main-loop model step: the context, the status line, and the one warning per window. */
export async function afterStep($: EngineInterface): Promise<void> {
  const dir = await ensureSession($)
  const context = await readContext($)
  await refreshStatus($)
  const line = config().warnAtPercent
  if (context === undefined || line <= 0 || progressPercent(context) < line) return
  if ((await getWarnedAt($)) !== null) return
  await setWarnedAt($, progressPercent(context))
  const failure = await appendNote($, buildWarning({ context, sessionDir: dir }))
  if (failure !== undefined) {
    log($, `the warning note was not appended (${failure}); it is tried again at the next step`)
    await setWarnedAt($, null)
    return
  }
  $.ui.toast(`context at ${contextPhrase(context)}; Claude was told what a compaction keeps and how to pin a fact`)
}
