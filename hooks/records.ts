// The record of a compaction and the message helpers the compaction hook uses (pure).
import type { SessionCompactInput, SessionCompactResult, SessionMessage } from 'claude-code'

import type { CompactLensPin, CompactLensRecord, CompactLensSpan, CompactLensTrigger } from '../types'
import type { LostReport } from './lost'
import type { CompactionFiles } from './paths'
import { ENGINE_SUMMARY_OPENING, SUMMARY_HEAD_CHARS } from './paths'
import { estimateTokens, fmtTokens, transcriptChars } from './snapshot'
import type { Boundary } from './transcript'

export type NextCompact = (e: SessionCompactInput) => Promise<SessionCompactResult>

export const userMessage = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })

const isPlainUser = (m: SessionMessage | undefined): boolean =>
  m !== undefined && m.role === 'user' && (m.toolResults === undefined || m.toolResults.length === 0)

/** A summary's length and FNV-1a hash: two summaries that share their opening still differ here. */
export const hashOf = (text: string): string => {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0
  return `${text.length}-${hash.toString(16)}`
}

/** Whether `text` is the summary a record names: its opening, and its whole text where the record holds a hash. */
export const isRecordedSummary = (text: string, record: CompactLensRecord): boolean =>
  record.summaryHead !== '' && text.startsWith(record.summaryHead) && (record.summaryHash === undefined || record.summaryHash === hashOf(text))

/** Where a record's summary stands in a compaction's input: the first plain user message that is it; -1 when absent. */
export const findRecordedSummary = (messages: readonly SessionMessage[], record: CompactLensRecord): number =>
  messages.findIndex(m => isPlainUser(m) && isRecordedSummary(m.text, record))

/** A message of the next request, in the Messages API's shape: `$.session.messages({ as: 'api' })`. */
export type ApiLike = { role: string; content: ReadonlyArray<{ type: string; [field: string]: unknown }> }

/** The text blocks of the next request's opening user messages, before the model's first reply: where the engine puts the last summary. */
const openingTexts = (api: readonly ApiLike[]): string[] => {
  const end = api.findIndex(m => m.role !== 'user')
  return (end < 0 ? api : api.slice(0, end)).flatMap(m =>
    m.content.flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])),
  )
}

/**
 * The summary the conversation runs on. It is found in the next request, where the engine puts the
 * last summary first: the first opening text block that opens as the engine's summaries do, or with
 * a recorded summary's head (an applied edit may open otherwise), so a prompt sent later is never
 * taken for one. Its text is the transcript's own message that block holds, the longest such, in
 * case the request merged the note after it into the same block; the block itself without one.
 */
export const summaryIn = (api: readonly ApiLike[], rows: readonly SessionMessage[], heads: readonly string[]): string | undefined => {
  const opensAsSummary = (text: string): boolean => text.startsWith(ENGINE_SUMMARY_OPENING) || heads.some(head => head !== '' && text.startsWith(head))
  const block = openingTexts(api).find(opensAsSummary)
  if (block === undefined) return undefined
  const held = rows.filter(m => isPlainUser(m) && m.text !== '' && opensAsSummary(m.text) && block.startsWith(m.text))
  return held.reduce<string | undefined>((longest, m) => (longest === undefined || m.text.length > longest.length ? m.text : longest), undefined) ?? block
}

export const replaceAt = (messages: readonly SessionMessage[], index: number, message: SessionMessage): SessionMessage[] =>
  messages.map((one, i) => (i === index ? message : one))

export const insertAfter = (messages: readonly SessionMessage[], index: number, message: SessionMessage): SessionMessage[] => [
  ...messages.slice(0, index + 1),
  message,
  ...messages.slice(index + 1),
]

/** The counts a lost report gives a record. */
const lostCounts = (lost: LostReport) => ({
  promptsInSpan: lost.prompts.length,
  promptsWeak: lost.promptsWeak,
  filesInSpan: lost.filesEdited.length + lost.filesRead.filter(path => !lost.filesEdited.includes(path)).length,
  filesUnnamed: lost.filesUnnamed.length,
  identifiersLost: lost.identifiersLostTotal,
})

const summaryFields = (summary: string) => ({ summaryHead: summary.slice(0, SUMMARY_HEAD_CHARS), summaryHash: hashOf(summary) })

export type RecordArgs = {
  n: number
  trigger: CompactLensTrigger
  at: string
  files: CompactionFiles
  before: readonly SessionMessage[]
  after: readonly SessionMessage[]
  summary: string
  lost: LostReport
  tokensBefore?: number
  tokensAfter?: number
  source?: 'live' | 'transcript'
  span?: CompactLensSpan
}

export const buildRecord = (args: RecordArgs): CompactLensRecord => ({
  n: args.n,
  trigger: args.trigger,
  at: args.at,
  dir: args.files.dir,
  source: args.source ?? 'live',
  hasDetail: true,
  ...(args.span === undefined ? {} : { span: args.span }),
  messagesBefore: args.before.length,
  messagesAfter: args.after.length,
  charsBefore: transcriptChars(args.before),
  charsAfter: transcriptChars(args.after),
  tokensBefore: args.tokensBefore ?? null,
  tokensAfter: args.tokensAfter ?? null,
  ...summaryFields(args.summary),
  ...lostCounts(args.lost),
})

/** What every real compaction's record is built from: the transcript in, the result with its summary, the pins. */
export type RecordCompactionArgs = {
  n: number
  trigger: CompactLensTrigger
  at: string
  files: CompactionFiles
  before: readonly SessionMessage[]
  withSummary: readonly SessionMessage[]
  summaryIndex: number
  pins: readonly CompactLensPin[]
  tokensBefore?: number
  tokensAfter?: number
}

/** The trigger a boundary row names, as a record's: `manual` and `auto` as written, anything else as the engine's own word for a plugin's. */
export const triggerOf = (word: string): CompactLensTrigger => (word === 'manual' || word === 'auto' ? word : 'plugin')

/**
 * The record of a compaction known only from its boundary row: its number, time, trigger and tokens,
 * and where it stands in the transcript. Its summary and span are read when first asked for.
 */
export const buildIndexRecord = (n: number, boundary: Boundary, span: CompactLensSpan, dir: string): CompactLensRecord => ({
  n,
  trigger: triggerOf(boundary.trigger),
  at: boundary.at,
  dir,
  source: 'transcript',
  hasDetail: false,
  span,
  messagesBefore: 0,
  messagesAfter: 0,
  charsBefore: 0,
  charsAfter: 0,
  tokensBefore: boundary.tokensBefore,
  tokensAfter: boundary.tokensAfter,
  summaryHead: '',
  promptsInSpan: 0,
  filesInSpan: 0,
  identifiersLost: 0,
})

/** A record with its summary read: what an apply and an edit find it by. */
export const withSummary = (record: CompactLensRecord, summary: string): CompactLensRecord => ({ ...record, ...summaryFields(summary) })

/** A record once its span has been read from the transcript: the counts filled in. */
export const withDetail = (record: CompactLensRecord, detail: { before: readonly SessionMessage[]; after: readonly SessionMessage[]; summary: string; lost: LostReport }): CompactLensRecord => ({
  ...record,
  hasDetail: true,
  messagesBefore: detail.before.length,
  messagesAfter: detail.after.length,
  charsBefore: transcriptChars(detail.before),
  charsAfter: transcriptChars(detail.after),
  ...summaryFields(detail.summary),
  ...lostCounts(detail.lost),
})

/** The pins a store entry holds, and the records a store entry of 0.3.0 held; empty lists for anything else. */
export const heldLists = (held: unknown): { pinned: CompactLensPin[]; compactions: CompactLensRecord[] } => {
  const { pinned, compactions } = held !== null && typeof held === 'object' ? (held as { pinned?: unknown; compactions?: unknown }) : {}
  return {
    pinned: Array.isArray(pinned) ? (pinned as CompactLensPin[]) : [],
    compactions: Array.isArray(compactions) ? (compactions as CompactLensRecord[]) : [],
  }
}

/** A record read back from a folder's meta.json; undefined for anything that is not one. */
export const parseRecord = (text: string): CompactLensRecord | undefined => {
  try {
    const value: unknown = JSON.parse(text)
    if (value === null || typeof value !== 'object') return undefined
    const record = value as Partial<CompactLensRecord>
    return typeof record.n === 'number' && typeof record.trigger === 'string' && typeof record.at === 'string' && typeof record.dir === 'string'
      ? (record as CompactLensRecord)
      : undefined
  } catch {
    return undefined
  }
}

export type UnseenArgs = { n: number; at: string; files: CompactionFiles; after: readonly SessionMessage[]; summary: string }

/** The record of a compaction the mod did not see run, where the transcript could not be read: its summary and what follows it. */
export const buildUnseenRecord = ({ n, at, files, after, summary }: UnseenArgs): CompactLensRecord => ({
  n,
  trigger: 'unseen',
  at,
  dir: files.dir,
  source: 'transcript',
  hasDetail: false,
  messagesBefore: 0,
  messagesAfter: after.length,
  charsBefore: 0,
  charsAfter: transcriptChars(after),
  tokensBefore: null,
  tokensAfter: null,
  ...summaryFields(summary),
  promptsInSpan: 0,
  filesInSpan: 0,
  identifiersLost: 0,
})

/** A record's tokens in and out: the engine's counts, or the estimate where it gave none; `?` where neither is known. */
export const tokensOf = (record: CompactLensRecord): string => {
  const side = (tokens: number | null, chars: number): string => (tokens !== null ? fmtTokens(tokens) : chars > 0 ? fmtTokens(estimateTokens(chars)) : '?')
  return `${side(record.tokensBefore, record.charsBefore)} → ${side(record.tokensAfter, record.charsAfter)}`
}
