// The session.compact hook: every compaction of the main conversation is snapshotted as it runs, the
// note inserted after its summary; the person's /compact with an edit waiting is answered by the mod.
import type { EngineInterface, SessionCompacted, SessionCompactInput, SessionCompactResult, SessionMessage } from 'claude-code'

import type { CompactLensPin, CompactLensRecord, CompactLensTrigger } from '../types'
import { forgetThreshold, refreshStatus } from './ahead'
import { setPending, supersedeApply } from './apply'
import { syncHistory } from './history'
import { computeLost } from './lost'
import { buildApplyNote, buildNote, buildPinnedDirective, mergeInstructions } from './notes'
import type { CompactionFiles } from './paths'
import { COMPACT_COMMAND, compactionFiles, draftFile, pad2, SYNC_DELAY_MS } from './paths'
import type { NextCompact, RecordCompactionArgs } from './records'
import { buildRecord, findRecordedSummary, insertAfter, replaceAt, userMessage } from './records'
import { renderLost } from './report'
import { ensureSession, isoNow, log } from './session'
import { contextText, findSummaryIndex, renderTranscript, transcriptChars } from './snapshot'
import { getDraft, getPins, getRecords, isApplyPending, setContext, setDraft, setRecords, setWarnedAt } from './state'
import { compactedToast } from './texts'
import { writeAfter } from './writes'

/** The number the next compaction takes: one past the transcript's boundaries where it was read, else past the last record. */
async function nextNumber($: EngineInterface): Promise<number> {
  const synced = await syncHistory($).catch(() => undefined)
  const last = (await getRecords($)).at(-1)?.n ?? 0
  return (synced?.boundaryCount ?? last) + 1
}

/** Reads the transcript a moment after a compaction, once the engine has written its boundary row: the record gets its lines. */
export function scheduleSync($: EngineInterface): void {
  $.clock.after(SYNC_DELAY_MS, () => void syncHistory($).catch(error => log($, `the transcript was not read after the compaction (${String(error)})`)))
}

async function writeRecord($: EngineInterface, record: CompactLensRecord, files: CompactionFiles, after: readonly SessionMessage[]): Promise<void> {
  await writeAfter($, record, files, after)
  await $.fs.write(files.meta, JSON.stringify(record, null, 2))
  await setRecords($, list => [...list.filter(r => r.n !== record.n), record].sort((a, b) => a.n - b.n))
  if (record.trigger !== 'apply') {
    await setWarnedAt($, null)
    await setContext($, null)
    forgetThreshold()
  }
  await refreshStatus($)
}

/** The draft the person edited, if draft.md differs from what the mod wrote there; undefined otherwise. */
async function readEditedDraft($: EngineInterface, dir: string, remembered: string): Promise<string | undefined> {
  const path = draftFile(dir)
  if (!(await $.fs.exists(path))) return undefined
  const edited = (await $.fs.read(path)).trim()
  return edited !== '' && edited !== remembered.trim() ? edited : undefined
}

/** Forgets a spent draft, then empties draft.md: a draft the mod no longer remembers is never used, so a failure here is logged, not fatal. */
async function clearDraft($: EngineInterface, dir: string): Promise<void> {
  try {
    if ((await getDraft($)) === null) return
    await setDraft($, null)
    await $.fs.write(draftFile(dir), '')
  } catch (error) {
    log($, `${draftFile(dir)} could not be emptied (${String(error)}); the draft in it is spent, so write over it`)
  }
}

/**
 * The person's edited draft, to use as the summary when the engine reused the draft it was edited
 * from: it stays in draft.md until the compaction is recorded. An edit the engine passed over is kept
 * beside the record, never wiped.
 */
async function takeEditedDraft($: EngineInterface, dir: string, files: CompactionFiles, engineText: string): Promise<string | undefined> {
  const remembered = await getDraft($)
  if (remembered === null) return undefined
  const edited = await readEditedDraft($, dir, remembered)
  if (edited !== undefined && engineText.trim() === remembered.trim()) return edited
  if (edited !== undefined) {
    const kept = `${files.dir}/draft-unused.md`
    await $.fs.write(kept, edited)
    log($, `draft.md was edited, but the engine's summary moved on; the edit is kept at ${kept}`)
  }
  await clearDraft($, dir)
  return undefined
}

async function snapshotBefore($: EngineInterface, messages: readonly SessionMessage[], files: CompactionFiles, title: string, line: string): Promise<void> {
  await $.fs.write(files.before, renderTranscript(messages, { title, lines: [line] }))
}

/** The summary, the lost report, the record and the note: what every real compaction leaves. */
async function recordCompaction($: EngineInterface, args: RecordCompactionArgs): Promise<{ messages: SessionMessage[]; record: CompactLensRecord }> {
  const { n, trigger, at, files, before, withSummary, summaryIndex, pins } = args
  const summary = withSummary[summaryIndex] ?? userMessage('')
  const lost = computeLost(before, contextText(withSummary))
  const record = buildRecord({ n, trigger, at, files, before, after: withSummary, summary: summary.text, lost, tokensBefore: args.tokensBefore, tokensAfter: args.tokensAfter })
  await $.fs.write(files.summary, summary.text)
  await $.fs.write(files.lost, renderLost(lost, { n, trigger, at, beforePath: files.before, tokensBefore: args.tokensBefore, tokensAfter: args.tokensAfter }))
  const note = userMessage(buildNote({ record, files, pins, keptCount: withSummary.length - 1 }))
  const messages = insertAfter(withSummary, summaryIndex, note)
  await writeRecord($, record, files, messages)
  return { messages, record }
}

/** What a real compaction knows by the time the engine's summary comes back. */
type Summarised = { e: SessionCompactInput; result: SessionCompacted; n: number; files: CompactionFiles; at: string; trigger: CompactLensTrigger; pins: readonly CompactLensPin[]; dir: string }

/** The summary, the lost report, the record and the note, once the engine has summarised. */
async function afterSummary($: EngineInterface, { e, result, n, files, at, trigger, pins, dir }: Summarised): Promise<SessionCompactResult> {
  const summaryIndex = findSummaryIndex(result.messages)
  if (summaryIndex < 0) {
    log($, `compaction #${n}: no summary message found in the result; nothing recorded beyond ${files.before}`)
    return result
  }
  const engineSummary = result.messages[summaryIndex] ?? userMessage('')
  const edited = await takeEditedDraft($, dir, files, engineSummary.text)
  const withSummary = replaceAt(result.messages, summaryIndex, edited === undefined ? engineSummary : userMessage(edited))
  const { messages, record } = await recordCompaction($, { n, trigger, at, files, before: e.messages, withSummary, summaryIndex, pins, tokensBefore: result.tokensBefore, tokensAfter: result.tokensAfter })
  if (edited !== undefined) await clearDraft($, dir)
  const draftNote = edited === undefined ? '' : ', the edited draft.md used as the summary'
  log($, `compaction #${n} (${trigger}): ${e.messages.length} → ${messages.length} messages${draftNote}; snapshots in ${files.dir}`)
  $.ui.toast(compactedToast(record))
  scheduleSync($)
  return { ...result, messages }
}

/** A real compaction: snapshot what goes in, let the engine summarise, snapshot what comes out, insert the note. */
async function handleReal($: EngineInterface, e: SessionCompactInput, next: NextCompact, dir: string): Promise<SessionCompactResult> {
  const [n, pins] = await Promise.all([nextNumber($), getPins($)])
  const files = compactionFiles(dir, n)
  const at = await isoNow($)
  const trigger: CompactLensTrigger = e.trigger === 'precompute' ? 'auto' : e.trigger
  const beforeLine = `${e.messages.length} messages, ${transcriptChars(e.messages)} characters; the whole transcript the engine compacted.`
  await snapshotBefore($, e.messages, files, `before — compaction #${n} (${trigger}) at ${at}`, beforeLine)

  const instructions = mergeInstructions(e.instructions, buildPinnedDirective(pins))
  const result = await next(instructions === undefined ? e : { ...e, instructions })
  if (result.skip !== undefined) {
    log($, `compaction #${n} skipped: ${result.skip}`)
    return result
  }
  // The summary came back: a failure from here on keeps the engine's result, and says what became of an edited draft.
  try {
    return await afterSummary($, { e, result, n, files, at, trigger, pins, dir })
  } catch (error) {
    const isDraftWaiting = (await getDraft($).catch(() => null)) !== null
    const draft = isDraftWaiting ? `; your edit is still in ${draftFile(dir)}` : ''
    log($, `compaction #${n} could not be recorded (${String(error)}); the engine's summary stands, without the mod's note${draft}`)
    return result
  }
}

/** A precomputed summary: keep its draft on disk so it can be read, or edited, before the compaction lands. */
async function handlePrecompute($: EngineInterface, e: SessionCompactInput, next: NextCompact, dir: string): Promise<SessionCompactResult> {
  const result = await next(e)
  if (result.skip !== undefined) return result
  const index = findSummaryIndex(result.messages)
  const text = result.messages[index]?.text
  if (index < 0 || text === undefined) return result
  const remembered = await getDraft($)
  const inProgress = remembered === null ? undefined : await readEditedDraft($, dir, remembered)
  if (inProgress !== undefined) {
    log($, `a summary was precomputed again, but ${draftFile(dir)} holds an edit; it was left as it is`)
    return result
  }
  await $.fs.write(draftFile(dir), text)
  await setDraft($, text)
  log($, `a summary was precomputed ahead of the compaction; its draft is at ${draftFile(dir)}`)
  return result
}

/** An apply: the edited summary.md replaces the current summary; no summariser runs. A skip drops the waiting edit and says why. */
async function handleApply($: EngineInterface, e: SessionCompactInput, dir: string): Promise<SessionCompactResult> {
  const skip = async (reason: string): Promise<SessionCompactResult> => {
    await setPending($, false)
    return { skip: `compact-lens: ${reason}; run ${COMPACT_COMMAND} again to compact as usual` }
  }
  const latest = (await getRecords($)).at(-1)
  if (latest === undefined) return skip('nothing to apply, no compaction has run yet')
  const current = compactionFiles(dir, latest.n)
  const edited = (await $.fs.exists(current.summary)) ? (await $.fs.read(current.summary)).trim() : ''
  if (edited === '') return skip(`${current.summary} is missing or empty, so nothing was applied`)
  const index = findRecordedSummary(e.messages, latest)
  if (index < 0) return skip(`the summary of #${pad2(latest.n)} is not in the conversation now, so the edit was not applied; it stays in ${current.summary}`)
  const old = e.messages[index] ?? userMessage('')
  if (old.text.trim() === edited) return skip(`${current.summary} is the summary in use, so there was nothing to apply`)

  const n = await nextNumber($)
  const files = compactionFiles(dir, n)
  const at = await isoNow($)
  const withSummary = replaceAt(e.messages, index, userMessage(edited))
  const lost = computeLost([old], contextText(withSummary))
  const record = buildRecord({ n, trigger: 'apply', at, files, before: e.messages, after: withSummary, summary: edited, lost })
  await snapshotBefore($, e.messages, files, `before — apply #${n} at ${at}`, 'The transcript as it stood when the edited summary replaced the summary.')
  await $.fs.write(files.summary, edited)
  await $.fs.write(files.lost, renderLost(lost, { n, trigger: 'apply', at, beforePath: current.summary }))
  const messages = insertAfter(withSummary, index, userMessage(buildApplyNote(record, files)))
  await writeRecord($, record, files, messages)
  await setPending($, false)
  log($, `apply #${n}: the summary was replaced from ${current.summary}; snapshots in ${files.dir}`)
  $.ui.toast(`your edited summary is in place (#${pad2(n)})`)
  scheduleSync($)
  return { messages }
}

// Set while the hook answers an apply: if it throws, its .catch must skip, never hand the compaction to the summariser.
let isApplying = false

export const isApplyRunning = (): boolean => isApplying

export const endApply = (): void => {
  isApplying = false
}

/** The session.compact hook: the engine's compactions are recorded; the person's /compact with an edit waiting is answered by the mod. */
export async function handleCompact($: EngineInterface, e: SessionCompactInput, next: NextCompact): Promise<SessionCompactResult> {
  if (e.agentId !== undefined) return next(e)
  if (!Array.isArray(e.messages)) {
    log($, `a compaction arrived without its messages (trigger ${String(e.trigger)}); passed through`)
    return next(e)
  }
  const dir = await ensureSession($)
  if (e.trigger === 'precompute') return handlePrecompute($, e, next, dir)
  const isPending = await isApplyPending($)
  if (isPending && e.trigger === 'manual' && (e.instructions ?? '').trim() === '') {
    isApplying = true
    const applied = await handleApply($, e, dir)
    isApplying = false
    return applied
  }
  const result = await handleReal($, e, next, dir)
  if (isPending && result.skip === undefined) await supersedeApply($).catch(error => log($, `the waiting apply was not set aside (${String(error)})`))
  return result
}
