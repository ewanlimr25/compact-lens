// The session's compactions as its transcript file records them. The mod's hook sees a compaction only
// while the mod is loaded and its hook runs; the transcript holds every one. So the count comes from
// there, a compaction the hook missed is recorded from its boundary row, and its files (before.md,
// lost.md, after.md) are written from the transcript the first time someone asks for them.
import type { EngineInterface } from 'claude-code'

import type { CompactLensRecord, CompactLensSpan } from '../types'
import { computeLost } from './lost'
import { APPLY_SUMMARY_ROWS, compactionFiles, COPY_SLACK, KEPT_WINDOW, pad2 } from './paths'
import type { TranscriptIndex } from './reader'
import { findTranscript, indexLines, readLines, readRange } from './reader'
import { buildIndexRecord, buildUnseenRecord, hashOf, isRecordedSummary, parseRecord, summaryIn, triggerOf, userMessage, withDetail, withSummary } from './records'
import { renderLost } from './report'
import { ensureSession, isoNow, log } from './session'
import { contextText, renderTranscript } from './snapshot'
import { getHeldSessionId, getRecords, setBusy, setRecords } from './state'
import { foundToast, UNPAIRED, unseenBefore, unseenLost } from './texts'
import type { Boundary, SpanParts } from './transcript'
import { copiesOf, isSummaryRow, parseBoundary, spanOf, splitSpan, summaryFrom } from './transcript'
import { writeAfter } from './writes'

/** How the look went: the transcript `read`; `missing`, none written yet (a new session); `unreadable`, it could not be read here (no process to run). */
export type TranscriptState = 'read' | 'missing' | 'unreadable'

/** What a look at the transcript found: the compactions it added, and how many boundaries the transcript holds. */
export type SyncResult = { added: CompactLensRecord[]; transcript: TranscriptState; boundaryCount: number | null }

/** The session's compactions as its transcript holds them: every boundary (with the messages it kept) and every marked summary row. */
export type CompactionMap = { path: string; boundaries: readonly Boundary[]; summaries: readonly number[] }

/** The look under way, for the session it is for. */
let syncing: { id: string; run: Promise<SyncResult> } | undefined
/** The transcript as last read: a look that finds it unchanged, and the records still holding what it found, reads nothing. */
let lastRead: { id: string; dir: string; size: number; mtimeMs: number; map: CompactionMap } | undefined

/** Brings the records up to date with the session's transcript: one look at a time per session, none while it is unchanged. */
export async function syncHistory($: EngineInterface): Promise<SyncResult> {
  const id = await $.session.id()
  if (syncing?.id === id) return syncing.run
  const run = runSync($, id).finally(() => {
    if (syncing?.run === run) syncing = undefined
  })
  syncing = { id, run }
  return run
}

/** Writes the records unless the session changed while they were read (a /clear or a /resume); whether they were written. */
async function setRecordsOf($: EngineInterface, id: string, fn: (list: CompactLensRecord[]) => CompactLensRecord[]): Promise<boolean> {
  if ((await getHeldSessionId($)) !== id) return false
  await setRecords($, fn)
  return true
}

async function runSync($: EngineInterface, id: string): Promise<SyncResult> {
  const dir = await ensureSession($)
  const path = await findTranscript($, id)
  if (path === null) return legacySync($, { dir, id, transcript: 'missing', mayAdopt: true })
  try {
    const stat = await $.fs.stat(path)
    if (lastRead !== undefined && (await isUnchanged($, id, dir, stat, path))) return { added: [], transcript: 'read', boundaryCount: lastRead.map.boundaries.length }
    const index = await indexLines($, path).catch((error: unknown) => {
      log($, `the session's transcript could not be read (${String(error)}); only the compactions the mod saw run are recorded`)
      return undefined
    })
    // No command could read it: the summary in use is all there is to go on, as before the transcript was read.
    if (index === undefined) return legacySync($, { dir, id, transcript: 'unreadable', mayAdopt: true })
    return await syncFromTranscript($, { dir, path, id, index, stat })
  } catch (error) {
    // A read or a write failed this time: the next look tries again, and nothing is numbered apart from the transcript meanwhile.
    log($, `the session's transcript could not be read just now (${String(error)}); the next look tries again`)
    return legacySync($, { dir, id, transcript: 'unreadable', mayAdopt: false })
  }
}

/** A record read back from a folder's meta.json; undefined when there is none or it is no record. */
async function readRecordFile($: EngineInterface, path: string): Promise<CompactLensRecord | undefined> {
  try {
    return (await $.fs.exists(path)) ? parseRecord(await $.fs.read(path)) : undefined
  } catch {
    return undefined
  }
}

/** The records the mod holds for this session's folder (an earlier version kept another session's after a /clear), with any on disk it does not hold. */
async function recordsWithDisk($: EngineInterface, dir: string): Promise<CompactLensRecord[]> {
  const held = (await getRecords($)).filter(r => r.dir.startsWith(`${dir}/`))
  const entries = await $.fs.list(dir).catch(() => [])
  const missing = entries
    .filter(entry => entry.kind === 'dir' && /^\d{2,}$/.test(entry.name))
    .map(entry => Number(entry.name))
    .filter(n => !held.some(r => r.n === n))
  const found = await Promise.all(missing.map(n => readRecordFile($, compactionFiles(dir, n).meta)))
  return [...held, ...found.filter((r): r is CompactLensRecord => r !== undefined)].sort((a, b) => a.n - b.n)
}

/** Whether the transcript is as last read for this session, and the records still hold what was found there (none were reset since). */
async function isUnchanged($: EngineInterface, id: string, dir: string, stat: { size: number; mtimeMs: number }, path: string): Promise<boolean> {
  const seen = lastRead
  if (seen === undefined || seen.id !== id || seen.map.path !== path || seen.dir !== dir || seen.size !== stat.size || seen.mtimeMs !== stat.mtimeMs) return false
  return (await getRecords($)).length >= seen.map.boundaries.length
}

/** The boundary rows and the marked summary rows among the lines the index found their probes on: a tool's input can hold either probe's text. */
async function readMarks($: EngineInterface, path: string, index: TranscriptIndex): Promise<Pick<CompactionMap, 'boundaries' | 'summaries'>> {
  const rows = await readLines($, path, [...index.boundaries, ...index.summaries])
  const boundaries = rows.flatMap(row => {
    const boundary = parseBoundary(row)
    return boundary === undefined ? [] : [boundary]
  })
  return { boundaries, summaries: rows.filter(isSummaryRow).map(row => row.line) }
}

type SyncArgs = { dir: string; path: string; id: string; index: TranscriptIndex; stat: { size: number; mtimeMs: number } }

async function syncFromTranscript($: EngineInterface, { dir, path, id, index, stat }: SyncArgs): Promise<SyncResult> {
  const map: CompactionMap = { path, ...(await readMarks($, path, index)) }
  const lines = map.boundaries.map(b => b.line)
  const held = await recordsWithDisk($, dir)
  const unpaired = await unpairedOf($, map, held)
  const added = map.boundaries.flatMap((boundary, i) => {
    const n = i + 1
    const span = spanOf(lines, map.summaries, n)
    return held.some(r => r.n === n) || span === undefined ? [] : [buildIndexRecord(n, boundary, span, compactionFiles(dir, n).dir)]
  })
  const spanned = held.map(r => (unpaired.has(r.n) ? withoutSpan(r) : withSpan(r, spanOf(lines, map.summaries, r.n))))
  const records = await withLatestSummary($, path, dir, [...spanned, ...added].sort((a, b) => a.n - b.n))
  lastRead = { id, dir, size: stat.size, mtimeMs: stat.mtimeMs, map }
  if (!(await setRecordsOf($, id, () => records))) return { added: [], transcript: 'read', boundaryCount: map.boundaries.length }
  // Whichever look finds them says so: a catch-up, a background read or a command.
  if (added.length > 0) $.ui.toast(foundToast(added))
  return { added, transcript: 'read', boundaryCount: map.boundaries.length }
}

/** Whether a held `unseen` record's summary is the transcript's for its number, by transcript and number: the file only grows, so a verdict stands. */
const pairings = new Map<string, boolean>()

/**
 * The numbers of the held `unseen` records whose summary is not the one the transcript has for their
 * number: compact-lens 0.3.0 numbered such a record one past its last, which two compactions it missed
 * in a row put out of step. Nothing is read from the transcript into their folders; each is said once.
 */
async function unpairedOf($: EngineInterface, map: CompactionMap, held: readonly CompactLensRecord[]): Promise<ReadonlySet<number>> {
  const lines = map.boundaries.map(b => b.line)
  const unseen = held.filter(r => r.trigger === 'unseen')
  const verdicts = await Promise.all(
    unseen.map(async r => {
      const key = `${map.path}#${r.n}`
      const known = pairings.get(key)
      if (known !== undefined) return known
      const span = spanOf(lines, map.summaries, r.n)
      const text = span === undefined ? undefined : await readSummaryText($, map.path, span)
      const isPaired = text !== undefined && isRecordedSummary(text, r)
      pairings.set(key, isPaired)
      if (!isPaired) log($, `compaction #${r.n} was recorded by an earlier version of compact-lens under another number than the transcript's; its files are left as they are`)
      return isPaired
    }),
  )
  return new Set(unseen.filter((_, i) => verdicts[i] === false).map(r => r.n))
}

/** The session's compactions as its transcript holds them, brought up to date; why there is no map otherwise. */
export async function compactionMap($: EngineInterface): Promise<CompactionMap | Exclude<TranscriptState, 'read'>> {
  const synced = await syncHistory($)
  if (synced.transcript !== 'read') return synced.transcript
  const id = await $.session.id()
  return lastRead?.id === id ? lastRead.map : 'missing'
}

const withSpan = (record: CompactLensRecord, span: CompactLensSpan | undefined): CompactLensRecord => (span === undefined ? record : { ...record, span })

/** A record without its lines: an earlier build gave every held record the lines of its number, and the host keeps values across a reload. */
const withoutSpan = (record: CompactLensRecord): CompactLensRecord => {
  const { span: _dropped, ...rest } = record
  return rest
}

/** The lines a compaction's summary is on: its marked row, or for an apply the rows right after the boundary. */
const summaryLines = (span: CompactLensSpan): number[] =>
  span.summary !== undefined ? [span.summary] : Array.from({ length: APPLY_SUMMARY_ROWS }, (_, i) => span.boundary + 1 + i)

async function readSummaryText($: EngineInterface, path: string, span: CompactLensSpan): Promise<string | undefined> {
  return summaryFrom(await readLines($, path, summaryLines(span)))
}

/** The latest compaction's summary, read when its record has none yet (a compaction the hook missed), so it can be edited and applied. */
async function withLatestSummary($: EngineInterface, path: string, dir: string, records: CompactLensRecord[]): Promise<CompactLensRecord[]> {
  const latest = records.at(-1)
  if (latest === undefined || latest.summaryHead !== '' || latest.span === undefined) return records
  const text = await readSummaryText($, path, latest.span)
  if (text === undefined) return records
  const files = compactionFiles(dir, latest.n)
  try {
    if (!(await $.fs.exists(files.summary))) {
      await $.fs.write(files.summary, text)
      // Its mark: with no record on disk yet, a prune tells the summary as written from an edit of it by this.
      await $.fs.write(files.mark, hashOf(text)).catch(error => log($, `${files.mark} was not written (${String(error)}); a prune keeps this folder`))
    }
  } catch (error) {
    // The count stands without it; the summary is written at the next look.
    log($, `${files.summary} was not written (${String(error)}); the next look tries again`)
    return records
  }
  return records.map(r => (r.n === latest.n ? withSummary(r, text) : r))
}

// ---------------------------------------------------------------- where the transcript cannot be read

/** The summary the conversation runs on: the engine puts it first in the next request; undefined before any compaction. */
export async function summaryNow($: EngineInterface, records: readonly CompactLensRecord[]): Promise<string | undefined> {
  return summaryIn(await $.session.messages({ as: 'api' }), await $.session.messages(), records.map(r => r.summaryHead))
}

type LegacyArgs = { dir: string; id: string; transcript: TranscriptState; mayAdopt: boolean }

/**
 * Without the transcript: the records held and on disk and, where no command can read the transcript at
 * all (`mayAdopt`), the summary in use recorded as `unseen` when no record has it.
 */
async function legacySync($: EngineInterface, { dir, id, transcript, mayAdopt }: LegacyArgs): Promise<SyncResult> {
  const nothing: SyncResult = { added: [], transcript, boundaryCount: null }
  const records = await recordsWithDisk($, dir)
  if (!(await setRecordsOf($, id, () => records)) || !mayAdopt) return nothing
  const text = await summaryNow($, records)
  if (text === undefined || records.some(r => isRecordedSummary(text, r))) return nothing
  const rows = await $.session.messages()
  const index = rows.findIndex(m => m.role === 'user' && m.text === text)
  const after = index < 0 ? [userMessage(text)] : rows.slice(index)
  const n = (records.at(-1)?.n ?? 0) + 1
  const files = compactionFiles(dir, n)
  const at = await isoNow($)
  await $.fs.write(files.before, unseenBefore(n, at))
  await $.fs.write(files.summary, text)
  await $.fs.write(files.lost, unseenLost(n, at))
  const record = buildUnseenRecord({ n, at, files, after, summary: text })
  await writeAfter($, record, files, after)
  await $.fs.write(files.meta, JSON.stringify(record, null, 2))
  if (!(await setRecordsOf($, id, list => [...list, record]))) return nothing
  log($, `compaction #${n} ran unseen; its summary is recorded in ${files.summary}`)
  return { added: [record], transcript, boundaryCount: null }
}

// ---------------------------------------------------------------- reading a compaction from the transcript

/** Whether a record's files still wait to be read from the transcript. */
export const needsReading = (record: CompactLensRecord): boolean => record.hasDetail === false || record.trigger === 'unseen'

/** The reads under way, by session and compaction. */
const reading = new Map<string, Promise<CompactLensRecord | string>>()

/**
 * A compaction's record with its files written, read from the transcript where only its boundary was
 * known, or where its folder went (`isGone`: a prune from another session); why not, otherwise.
 */
export async function materialize($: EngineInterface, n: number, isGone = false): Promise<CompactLensRecord | string> {
  const id = await $.session.id()
  const key = `${id}:${n}`
  const running = reading.get(key)
  if (running !== undefined) return running
  const started = runMaterialize($, n, id, isGone).finally(() => reading.delete(key))
  reading.set(key, started)
  return started
}

async function runMaterialize($: EngineInterface, n: number, id: string, isGone: boolean): Promise<CompactLensRecord | string> {
  const dir = await ensureSession($)
  const record = (await getRecords($)).find(r => r.n === n)
  if (record === undefined) return `there is no compaction #${n}`
  if (!isGone && !needsReading(record)) return record
  const map = await compactionMap($)
  if (typeof map === 'string') return `compaction #${n} is known by its summary alone: the session's transcript could not be read`
  if (record.span === undefined) return UNPAIRED(n)
  await setBusy($, `reading compaction #${pad2(n)} from the transcript`)
  try {
    return await readCompaction($, { dir, map, record, span: record.span, id })
  } finally {
    await setBusy($, null)
  }
}

/** The first line read for compaction k: KEPT_WINDOW lines above the boundary before it, where the messages that one kept stand. */
export const leadOf = (map: CompactionMap, k: number): number => {
  const previous = map.boundaries[k - 2]?.line
  return previous === undefined ? 1 : Math.max(1, previous - KEPT_WINDOW)
}

/**
 * Whether compaction k may have written the messages it kept again after its boundary: a hook answered
 * it (the mod's apply, or the mod's note after the engine's summary), which leaves no kept messages
 * named in its boundary row, or no marked summary. The engine's own compactions name the messages
 * they keep and leave them where they stand.
 */
export const mayRewrite = (map: CompactionMap, k: number): boolean => {
  const boundary = map.boundaries[k - 1]
  if (boundary === undefined) return false
  return boundary.kept.length === 0 || spanOf(map.boundaries.map(b => b.line), map.summaries, k)?.summary === undefined
}

/** Where the rows written again after compaction k's boundary can reach: as many rows as were read for it, and a few, before the next boundary. */
export const copyReachOf = (map: CompactionMap, k: number): number => {
  const boundary = map.boundaries[k - 1]?.line ?? 0
  const next = map.boundaries[k]?.line ?? Number.POSITIVE_INFINITY
  return Math.min(boundary + (boundary - leadOf(map, k)) + COPY_SLACK, next - 1)
}

const NO_COPIES: ReadonlySet<string> = new Set()

/** The messages compaction k wrote again after its boundary, read from the rows right after it; none where it cannot have. */
export async function copiesAfter($: EngineInterface, map: CompactionMap, k: number): Promise<ReadonlySet<string>> {
  const boundary = map.boundaries[k - 1]?.line
  if (boundary === undefined || !mayRewrite(map, k)) return NO_COPIES
  return copiesOf(await readRange($, map.path, boundary + 1, copyReachOf(map, k)))
}

/**
 * What compaction k took out of the context, and what it kept, read from the transcript: its lines,
 * with those above the boundary before it, where the messages that compaction kept stand.
 */
export async function readSpan($: EngineInterface, map: CompactionMap, k: number): Promise<SpanParts | undefined> {
  const span = spanOf(map.boundaries.map(b => b.line), map.summaries, k)
  if (span === undefined) return undefined
  const [rows, copies] = await Promise.all([readRange($, map.path, leadOf(map, k), span.to), copiesAfter($, map, k)])
  return splitSpan(rows, { k, boundaries: map.boundaries, copies })
}

type ReadArgs = { dir: string; map: CompactionMap; record: CompactLensRecord; span: CompactLensSpan; id: string }

async function readCompaction($: EngineInterface, { dir, map, record, span, id }: ReadArgs): Promise<CompactLensRecord> {
  const [parts, summaryText] = await Promise.all([readSpan($, map, record.n), readSummaryText($, map.path, span)])
  const { dropped, kept } = parts ?? { dropped: [], kept: [] }
  const messages = [...dropped, ...kept].sort((a, b) => a.line - b.line)
  const boundary = map.boundaries[record.n - 1]
  const summary = summaryText ?? ''
  const after = [userMessage(summary), ...kept]
  const lost = computeLost(messages, contextText(after))
  const files = compactionFiles(dir, record.n)
  const trigger = record.trigger === 'unseen' && boundary !== undefined ? triggerOf(boundary.trigger) : record.trigger
  const shown = { ...span, from: Math.min(span.from, messages[0]?.line ?? span.from) }
  const title = `before — compaction #${record.n} (${trigger}) at ${record.at}, read from the transcript`
  const line = `${messages.length} messages from lines ${shown.from}–${span.to} of ${map.path}, ${kept.length} of them kept through the compaction: the mod did not see this compaction run, so it read the span from the session's transcript afterwards.`
  await $.fs.write(files.before, renderTranscript(messages, { title, lines: [line] }))
  if (!(await $.fs.exists(files.summary))) await $.fs.write(files.summary, summary)
  const updated = { ...withDetail(record, { before: messages, after, summary, lost }), trigger }
  await writeAfter($, updated, files, after)
  const tokens = { ...(updated.tokensBefore === null ? {} : { tokensBefore: updated.tokensBefore }), ...(updated.tokensAfter === null ? {} : { tokensAfter: updated.tokensAfter }) }
  await $.fs.write(files.lost, renderLost(lost, { n: record.n, trigger, at: record.at, beforePath: files.before, span: shown, ...tokens }))
  await $.fs.write(files.meta, JSON.stringify(updated, null, 2))
  await setRecordsOf($, id, list => list.map(r => (r.n === record.n ? updated : r)))
  return updated
}

/** The record of compaction `n`, or the latest when `n` is left out; the reason there is none otherwise. */
export async function recordFor($: EngineInterface, n: number | undefined): Promise<CompactLensRecord | string> {
  await syncHistory($)
  const records = await getRecords($)
  if (records.length === 0) return 'no compaction has run in this session yet'
  const record = n === undefined ? records.at(-1) : records.find(r => r.n === n)
  return record ?? `there is no compaction #${n}; this session has ${records.length} (1 to ${records.at(-1)?.n ?? records.length})`
}
