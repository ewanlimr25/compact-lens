// The record of a compaction and the message helpers the compaction hook uses (pure).
import type { SessionMessage } from 'claude-code'

import type { CompactLensRecord } from '../types'
import type { LostReport } from './lost'
import type { CompactionFiles } from './paths'
import { SUMMARY_HEAD_CHARS } from './paths'
import { estimateTokens, fmtTokens, transcriptChars } from './snapshot'

export const userMessage = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })

export const replaceAt = (messages: readonly SessionMessage[], index: number, message: SessionMessage): SessionMessage[] =>
  messages.map((one, i) => (i === index ? message : one))

export const insertAfter = (messages: readonly SessionMessage[], index: number, message: SessionMessage): SessionMessage[] => [
  ...messages.slice(0, index + 1),
  message,
  ...messages.slice(index + 1),
]

export type RecordArgs = {
  n: number
  trigger: CompactLensRecord['trigger']
  at: string
  files: CompactionFiles
  before: readonly SessionMessage[]
  after: readonly SessionMessage[]
  summary: string
  lost: LostReport
  tokensBefore?: number
  tokensAfter?: number
}

export const buildRecord = (args: RecordArgs): CompactLensRecord => ({
  n: args.n,
  trigger: args.trigger,
  at: args.at,
  dir: args.files.dir,
  messagesBefore: args.before.length,
  messagesAfter: args.after.length,
  charsBefore: transcriptChars(args.before),
  charsAfter: transcriptChars(args.after),
  tokensBefore: args.tokensBefore ?? null,
  tokensAfter: args.tokensAfter ?? null,
  summaryHead: args.summary.slice(0, SUMMARY_HEAD_CHARS),
  promptsInSpan: args.lost.prompts.length,
  filesInSpan: args.lost.filesEdited.length + args.lost.filesRead.length,
  identifiersLost: args.lost.identifiersLostTotal,
})

/** A record's tokens in and out: the engine's counts, or the estimate where it gave none. */
export const tokensOf = (record: CompactLensRecord): string => {
  const before = record.tokensBefore ?? estimateTokens(record.charsBefore)
  const after = record.tokensAfter ?? estimateTokens(record.charsAfter)
  return `${fmtTokens(before)} → ${fmtTokens(after)}`
}
