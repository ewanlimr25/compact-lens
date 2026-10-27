// Readying an edited summary for the person's /compact. The engine never runs a plugin's own
// session.compact hook for a compaction that plugin asked for with $.session.compact(): its summariser
// runs instead. So an apply rides on the person's /compact, which the hook answers with the edit.
import type { EngineInterface } from 'claude-code'

import { refreshStatus } from './ahead'
import { summaryNow, syncHistory } from './history'
import { COMMAND, COMPACT_COMMAND, COMPACT_FILL, compactionFiles, pad2 } from './paths'
import { isRecordedSummary } from './records'
import { ensureSession, log } from './session'
import { getRecords, setApplyPending } from './state'
import { OFFER_TOAST, RUN_COMPACT_TOAST } from './texts'

/** Sets whether an edit waits, and redraws the status line, which says so. */
export async function setPending($: EngineInterface, isPending: boolean): Promise<void> {
  await setApplyPending($, isPending)
  await refreshStatus($)
}

// The model's apply offers /compact when its turn ends; a reload forgets it, and the status line still says an apply waits.
let isOfferDue = false

export const markOfferDue = (): void => {
  isOfferDue = true
}

/** Whether an offer waits for the turn's end, clearing it. */
export const takeOfferDue = (): boolean => {
  const was = isOfferDue
  isOfferDue = false
  return was
}

/** Puts `text` in the prompt box when the box is empty or holds only `replaced` (a caught prompt the engine put back); whether the box holds `text` now. */
export async function fillFree($: EngineInterface, text: string, replaced?: string): Promise<boolean> {
  const box = (await $.prompt.read()).text.trim()
  const isFree = box === '' || (replaced !== undefined && box === replaced.trim())
  if (!isFree || box === text.trim()) return box === text.trim()
  return (await $.prompt.fill({ text, mode: 'replace' })).isFilled
}

/** Puts /compact in the prompt box when the box is free, else says to run it; never throws. */
export async function offerCompact($: EngineInterface, replaced?: string): Promise<void> {
  const isOffered = await fillFree($, COMPACT_FILL, replaced).catch(error => {
    log($, `apply: ${COMPACT_COMMAND} did not go into the prompt box (${String(error)})`)
    return false
  })
  $.ui.toast(isOffered ? OFFER_TOAST : RUN_COMPACT_TOAST)
}

export function scheduleOffer($: EngineInterface, delayMs: number, replaced?: string): void {
  $.clock.after(delayMs, () => void offerCompact($, replaced))
}

/** The summary.md an apply would use, when it differs from the summary the conversation runs on; the reason otherwise. */
export async function checkApplicable($: EngineInterface): Promise<{ path: string } | string> {
  await syncHistory($)
  const dir = await ensureSession($)
  const records = await getRecords($)
  const latest = records.at(-1)
  if (latest === undefined) return 'no compaction has run yet, so there is no summary to replace'
  const path = compactionFiles(dir, latest.n).summary
  if (!(await $.fs.exists(path))) return `${path} is missing`
  const edited = (await $.fs.read(path)).trim()
  if (edited === '') return `${path} is empty`
  const inUse = await summaryNow($, records)
  if (inUse === undefined || !isRecordedSummary(inUse, latest)) return `the summary of #${pad2(latest.n)} is not the one in use now, so there is nothing for ${path} to replace`
  if (inUse.trim() === edited) return `${path} is the summary in use; edit it first`
  return { path }
}

/** A compaction other than the person's /compact ran while an edit waited: the edit is of a summary no longer in use. */
export async function supersedeApply($: EngineInterface): Promise<void> {
  await setPending($, false)
  const text = `a compaction ran before the edited summary was applied, so it was not; the edit stays in the previous folder's summary.md, and /${COMMAND} edit loads the new summary`
  log($, text)
  $.ui.toast(text)
}

/** The pane's Apply: readies summary.md and offers /compact at once. */
export async function applyFromPane($: EngineInterface): Promise<void> {
  const applicable = await checkApplicable($)
  if (typeof applicable === 'string') {
    $.ui.toast(`nothing to apply: ${applicable}`)
    return
  }
  await setPending($, true)
  await offerCompact($)
}
