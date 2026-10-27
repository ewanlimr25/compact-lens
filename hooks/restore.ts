// Getting back what a compaction took out of the context: the person's own prompts, or the passages that
// mention some words, read from the session's transcript and handed to the model verbatim.
import type { EngineInterface } from 'claude-code'

import type { CompactionMap } from './history'
import { compactionMap, copyReachOf, leadOf, mayRewrite, readSpan, recordFor } from './history'
import { MIN_SEARCH_CHARS, RECALL_ROWS, RECALL_SCAN_CAP } from './paths'
import type { Found } from './recall'
import { needlesOf, passagesOfRow, promptsBlock, recallBlock, searchTerms } from './recall'
import { linesHolding, readLines } from './reader'
import { RECALL_UNAVAILABLE, UNPAIRED } from './texts'
import { droppedBy, parseRow, signatureOf, spanOf } from './transcript'

/** What a restore hands the model: the block, and a few words on what it holds. */
export type Restored = { block: string; summary: string; chars: number }

/** Why there is no map of the transcript to read from. */
const noMapReason = (state: 'missing' | 'unreadable'): string =>
  state === 'unreadable' ? RECALL_UNAVAILABLE : 'no compaction has run yet, so nothing has been taken out of the context'

/** The person's prompts from compaction n's span (the latest when n is left out), as a block for the model; the reason there are none otherwise. */
export async function restorePrompts($: EngineInterface, n: number | undefined, isRequestedByPerson: boolean): Promise<Restored | string> {
  const record = await recordFor($, n)
  if (typeof record === 'string') return record
  const map = await compactionMap($)
  if (typeof map === 'string') return RECALL_UNAVAILABLE
  if (record.span === undefined) return UNPAIRED(record.n)
  const parts = await readSpan($, map, record.n)
  const prompts = (parts?.dropped ?? []).filter(m => m.isPrompt)
  const keptCount = (parts?.kept ?? []).filter(m => m.isPrompt).length
  if (prompts.length === 0 && keptCount > 0) return `compaction #${record.n} kept every prompt you typed in its span (${keptCount}), so it has none to give back`
  if (prompts.length === 0) return `compaction #${record.n}'s span holds no prompt you typed (only tool calls, notices or messages from other agents)`
  const block = promptsBlock({ n: record.n, prompts: prompts.map(m => ({ text: m.text, at: m.at })), isRequestedByPerson })
  return { block, summary: `your ${prompts.length} prompt${prompts.length === 1 ? '' : 's'} from compaction #${record.n}`, chars: block.length }
}

/**
 * The lines a search reads: one compaction's (with the rows above it the one before kept), or every
 * line before the latest boundary; and past them, where that compaction may have written kept messages
 * again (`twinsTo`, which is `last` where it wrote none), so a passage it kept is known. `ranAt` is when
 * it ran: what it wrote again carries older times.
 */
type Scope = { first: number; last: number; twinsTo: number; ranAt: string; n: number | undefined; label: string }

const scopeOf = (map: CompactionMap, n: number | undefined): Scope | string => {
  const lines = map.boundaries.map(b => b.line)
  const count = lines.length
  if (count === 0) return noMapReason('missing')
  const k = n ?? count
  const span = spanOf(lines, map.summaries, k)
  if (span === undefined) return `there is no compaction #${n} in the transcript`
  const twinsTo = mayRewrite(map, k) ? copyReachOf(map, k) : span.to
  const ranAt = map.boundaries[k - 1]?.at ?? ''
  if (n === undefined) return { first: 1, last: span.to, twinsTo, ranAt, n, label: `the ${count} compacted span${count === 1 ? '' : 's'}` }
  return { first: leadOf(map, n), last: span.to, twinsTo, ranAt, n, label: `the span compaction #${n} summarised` }
}

/**
 * The messages the scope's compaction wrote again after its boundary, by signature: the matching rows
 * there, read oldest first a batch at a time, until a batch ends on a row written after it ran (all of
 * them where its boundary has no time). What it wrote again comes first, so the rows still in the
 * context past that are left unread.
 */
async function writtenAgain($: EngineInterface, path: string, lines: readonly number[], ranAt: string): Promise<ReadonlySet<string>> {
  const signatures = new Set<string>()
  for (let read = 0; read < lines.length; ) {
    const batch = lines.slice(read, read + RECALL_ROWS)
    read += batch.length
    const rows = (await readLines($, path, batch)).sort((a, b) => a.line - b.line).flatMap(({ text }) => {
      const row = parseRow(text)
      return row === undefined ? [] : [row]
    })
    rows.map(signatureOf).filter(signature => signature !== '').forEach(signature => signatures.add(signature))
    const newest = rows.map(row => (typeof row.timestamp === 'string' ? row.timestamp : '')).filter(at => at !== '').at(-1)
    if (ranAt !== '' && newest !== undefined && newest > ranAt) break
  }
  return signatures
}

/** The passages found, and how many matching rows were left unread. */
type Collected = { found: Found[]; unread: number }

/**
 * The passages among the candidate lines in scope, read newest first a batch at a time, until enough are
 * found or RECALL_SCAN_CAP rows were read. A row whose message a newer row holds again (same time, same
 * words), or the compaction wrote again past the scope, was kept through its compaction: the newer row
 * speaks for it.
 */
async function collect($: EngineInterface, map: CompactionMap, scope: Scope, candidates: readonly number[], terms: readonly string[], kept: ReadonlySet<string>): Promise<Collected> {
  const found: Found[] = []
  const seen = new Set(kept)
  let read = 0
  while (read < Math.min(candidates.length, RECALL_SCAN_CAP) && found.length < RECALL_ROWS) {
    const batch = candidates.slice(read, read + RECALL_ROWS)
    read += batch.length
    const rows = (await readLines($, map.path, batch)).sort((a, b) => b.line - a.line)
    for (const { line, text } of rows) {
      const row = parseRow(text)
      if (row === undefined) continue
      const signature = signatureOf(row)
      const isWrittenAgain = signature !== '' && seen.has(signature)
      if (signature !== '') seen.add(signature)
      const k = droppedBy(map.boundaries, line, typeof row.uuid === 'string' ? row.uuid : '')
      if (k === 0 || isWrittenAgain || (scope.n !== undefined && k !== scope.n)) continue
      found.push(...passagesOfRow(line, row, terms).map(p => ({ ...p, n: k })))
    }
  }
  return { found, unread: candidates.length - read }
}

/** The passages of the compacted transcript that hold every word of `query`, newest first, as a block for the model; the reason there can be none otherwise. */
export async function recallPassages($: EngineInterface, query: string, n: number | undefined): Promise<Restored | string> {
  const terms = searchTerms(query)
  if (terms.length === 0) return 'say what to search for: one or more words, a "quoted phrase" kept whole'
  if (Math.max(...terms.map(term => term.length)) < MIN_SEARCH_CHARS) return `search with a word of ${MIN_SEARCH_CHARS} or more characters: shorter ones match nearly every row`
  const map = await compactionMap($)
  if (typeof map === 'string') return noMapReason(map)
  const scope = scopeOf(map, n)
  if (typeof scope === 'string') return scope
  const holding = await linesHolding($, map.path, needlesOf(terms))
  const kept = await writtenAgain($, map.path, holding.filter(line => line > scope.last && line <= scope.twinsTo), scope.ranAt)
  const candidates = holding.filter(line => line >= scope.first && line <= scope.last).reverse()
  const { found: passages, unread } = await collect($, map, scope, candidates, terms, kept)
  const block = recallBlock({ query, passages, scope: scope.label, transcript: map.path, unread })
  const found = passages.length === 0 ? 'no passage' : `${passages.length} passage${passages.length === 1 ? '' : 's'}`
  return { block, summary: `${found} mentioning "${query}"`, chars: block.length }
}
