// The session's transcript file read as data (pure). Claude Code keeps one JSON object a line: the
// conversation's rows, each compaction's boundary row and the summary row after it. These readers take
// the few fields they need and pass over the rest, so a row from another build never stops them.
import type { SessionMessage, ToolResultSummary, ToolUseSummary } from 'claude-code'

import type { CompactLensSpan } from '../types'
import { isCommandText } from './lost'
import { ENGINE_SUMMARY_OPENING } from './paths'

/** One line of the transcript and its number, from 1. */
export type NumberedLine = { line: number; text: string }

/** A compaction as its boundary row records it. */
export type Boundary = {
  line: number
  at: string
  trigger: string
  tokensBefore: number | null
  tokensAfter: number | null
  /** The ids of the messages the compaction kept as they were. */
  kept: readonly string[]
}

/** A message of a compacted span, with where it stands in the transcript. */
export type SpanMessage = SessionMessage & { line: number; at: string; uuid: string; isPrompt: boolean }

type Json = Record<string, unknown>

const isJson = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value)
const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])

/** A line read as a row; undefined for a line that is not a JSON object. */
export const parseRow = (text: string): Json | undefined => {
  try {
    const row: unknown = JSON.parse(text)
    return isJson(row) ? row : undefined
  } catch {
    return undefined
  }
}

/** `grep -n` output (`<line>:<match>`) as the line numbers it names, ascending, each once. */
export const grepLineNumbers = (output: readonly string[]): number[] =>
  [...new Set(output.map(line => Number.parseInt(line, 10)).filter(n => Number.isInteger(n) && n > 0))].sort((a, b) => a - b)

/** The index pass's output (`b6`, `s7`): the line numbers carrying one tag, ascending, each once. */
export const taggedLineNumbers = (output: readonly string[], tag: string): number[] =>
  grepLineNumbers(output.filter(line => line.startsWith(tag)).map(line => line.slice(tag.length)))

/** `sed -n 'N{=;p;}'` output: each line's number, then the line. */
export const numberedPairs = (output: readonly string[]): NumberedLine[] => {
  const pairs: NumberedLine[] = []
  for (let i = 0; i + 1 < output.length; i += 2) {
    const line = Number(output[i])
    if (Number.isInteger(line) && line > 0) pairs.push({ line, text: output[i + 1] ?? '' })
  }
  return pairs
}

/** The sed script that prints the given lines, each after its number, and stops after the last. */
export const sedPrintScript = (lines: readonly number[]): string => {
  const sorted = [...new Set(lines)].sort((a, b) => a - b)
  return sorted.map((line, i) => (i === sorted.length - 1 ? `${line}{=;p;q;}` : `${line}{=;p;}`)).join(';')
}

/** Whether a line is a summary row the engine marked (a tool's input can hold the mark's text too). */
export const isSummaryRow = ({ text }: NumberedLine): boolean => {
  const row = parseRow(text)
  return row?.type === 'user' && row.isCompactSummary === true
}

/** A boundary row; undefined for any other line. */
export const parseBoundary = ({ line, text }: NumberedLine): Boundary | undefined => {
  const row = parseRow(text)
  if (row?.type !== 'system' || row.subtype !== 'compact_boundary') return undefined
  const meta = isJson(row.compactMetadata) ? row.compactMetadata : {}
  const kept = isJson(meta.preservedMessages) ? meta.preservedMessages : {}
  return {
    line,
    at: str(row.timestamp),
    trigger: str(meta.trigger) || 'unknown',
    tokensBefore: num(meta.preTokens),
    tokensAfter: num(meta.postTokens),
    kept: strings(kept.allUuids ?? kept.uuids),
  }
}

/**
 * The lines between compaction `k`'s boundary and the one before (k from 1), and its summary row when
 * marked. What it dropped is decided row by row (splitSpan): the rows the compaction before kept, above
 * that one's boundary, join it, and the rows it kept itself stay.
 */
export const spanOf = (boundaries: readonly number[], summaries: readonly number[], k: number): CompactLensSpan | undefined => {
  const boundary = boundaries[k - 1]
  if (boundary === undefined) return undefined
  const next = boundaries[k] ?? Number.POSITIVE_INFINITY
  const summary = summaries.find(line => line > boundary && line < next)
  return { from: (boundaries[k - 2] ?? 0) + 1, to: boundary - 1, boundary, ...(summary === undefined ? {} : { summary }) }
}

type Block = Json

const blocksOf = (content: unknown): Block[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content.filter(isJson) : []

const textOfBlocks = (blocks: readonly Block[]): string =>
  blocks
    .filter(block => block.type === 'text')
    .map(block => str(block.text))
    .filter(text => text !== '')
    .join('\n')

/** A tool result's content as text: a string, or its text blocks joined. */
const resultText = (content: unknown): string => (typeof content === 'string' ? content : textOfBlocks(blocksOf(content)))

/** The text a user row holds: its text blocks, or a queued prompt's text. */
const userText = (row: Json): string => {
  const message = isJson(row.message) ? row.message : {}
  return textOfBlocks(blocksOf(message.content))
}

/**
 * Whether a user row is a prompt the person typed: origin `human`. In a transcript that marks no origins
 * (older than them), a plain row no engine wrote. Never a command, a summary or a hidden note.
 */
const isTypedPrompt = (row: Json, text: string, origin: string | undefined, hasOrigins: boolean): boolean => {
  if (row.isMeta === true || row.isCompactSummary === true || text.trim() === '' || isCommandText(text)) return false
  if (text.startsWith(ENGINE_SUMMARY_OPENING)) return false
  if (origin !== undefined) return origin === 'human'
  return !hasOrigins && !/^<(?:task-notification|agent-message)\b/.test(text.trimStart())
}

const originOf = (value: unknown): string | undefined => (isJson(value) && typeof value.kind === 'string' ? value.kind : undefined)

const base = (row: Json, line: number) => ({ line, at: str(row.timestamp), uuid: str(row.uuid) })

/** A user row as a message: its text, or its tool results; undefined for an empty one. */
const fromUser = (row: Json, line: number, hasOrigins: boolean): SpanMessage | undefined => {
  const message = isJson(row.message) ? row.message : {}
  const blocks = blocksOf(message.content)
  const results: ToolResultSummary[] = blocks
    .filter(block => block.type === 'tool_result')
    .map(block => ({ tool_use_id: str(block.tool_use_id), text: resultText(block.content), isError: block.is_error === true }))
  const text = userText(row)
  if (text === '' && results.length === 0) return undefined
  const isPrompt = results.length === 0 && isTypedPrompt(row, text, originOf(row.origin), hasOrigins)
  return { ...base(row, line), role: 'user', text, toolUses: [], ...(results.length === 0 ? {} : { toolResults: results }), isPrompt }
}

/** A prompt the person typed while a turn ran, folded into it as an attachment; other attachments are the engine's. */
const fromAttachment = (row: Json, line: number): SpanMessage | undefined => {
  const attachment = isJson(row.attachment) ? row.attachment : {}
  if (attachment.type !== 'queued_command') return undefined
  const text = typeof attachment.prompt === 'string' ? attachment.prompt : textOfBlocks(blocksOf(attachment.prompt))
  if (text.trim() === '') return undefined
  const isPrompt = attachment.commandMode === 'prompt' && originOf(attachment.origin) === 'human' && !isCommandText(text)
  return { ...base(row, line), role: 'user', text, toolUses: [], isPrompt }
}

/** One assistant row's text and tool calls (a response is written a block a row). */
const fromAssistant = (row: Json, line: number): SpanMessage => {
  const message = isJson(row.message) ? row.message : {}
  const blocks = blocksOf(message.content)
  const toolUses: ToolUseSummary[] = blocks
    .filter(block => block.type === 'tool_use')
    .map(block => ({ tool_use_id: str(block.id), tool: str(block.name), input: isJson(block.input) ? block.input : {} }))
  return { ...base(row, line), role: 'assistant', text: textOfBlocks(blocks), toolUses, isPrompt: false }
}

const messageId = (row: Json): string => (isJson(row.message) ? str(row.message.id) : '')

/** Joins a response's rows into one message: the texts in order, the tool calls in order. */
const joinResponse = (first: SpanMessage, more: SpanMessage): SpanMessage => ({
  ...first,
  text: [first.text, more.text].filter(text => text !== '').join('\n'),
  toolUses: [...first.toolUses, ...more.toolUses],
})

const withResult = (use: ToolUseSummary, result: ToolResultSummary | undefined): ToolUseSummary =>
  result === undefined ? use : { ...use, text: result.text, ...(result.isError ? { isError: true as const } : {}) }

/** Gives each tool call the text of its result, as the engine's own messages carry it. */
const withResults = (messages: readonly SpanMessage[]): SpanMessage[] => {
  const results = new Map(messages.flatMap(m => (m.toolResults ?? []).map(r => [r.tool_use_id, r] as const)))
  return messages.map(m =>
    m.toolUses.length === 0
      ? m
      : { ...m, toolUses: m.toolUses.map(use => withResult(use, results.get(use.tool_use_id))) },
  )
}

/** A line read as a row, with its number. */
type ParsedLine = { line: number; row: Json }

const parsedLines = (lines: readonly NumberedLine[]): ParsedLine[] =>
  lines.flatMap(({ line, text }) => {
    const row = parseRow(text)
    return row === undefined ? [] : [{ line, row }]
  })

/** Whether the transcript marks who wrote a row: the person's prompts carry origin `human` since Claude Code 2.1.26x. */
const marksOrigins = (rows: readonly ParsedLine[]): boolean => rows.some(({ row }) => isJson(row.origin))

/** Rows as the conversation's messages, oldest first. */
const messagesOf = (rows: readonly ParsedLine[], hasOrigins: boolean): SpanMessage[] => {
  const out: SpanMessage[] = []
  let lastResponseId = ''
  for (const { line, row } of rows) {
    if (row.isSidechain === true) continue
    if (row.type === 'assistant') {
      const one = fromAssistant(row, line)
      const id = messageId(row)
      const previous = out.at(-1)
      if (id !== '' && id === lastResponseId && previous?.role === 'assistant') out[out.length - 1] = joinResponse(previous, one)
      else out.push(one)
      lastResponseId = id
      continue
    }
    const one = row.type === 'user' ? fromUser(row, line, hasOrigins) : row.type === 'attachment' ? fromAttachment(row, line) : undefined
    if (one === undefined) continue
    out.push(one)
    if (one.toolResults === undefined) lastResponseId = ''
  }
  return withResults(out)
}

/**
 * A compacted span's rows as the conversation's messages, oldest first: the person's prompts (queued
 * ones too), the responses (a response's rows joined), the tool results. A subagent's rows, the
 * engine's notices and attachments, and lines that do not parse are left out.
 */
export const spanMessages = (lines: readonly NumberedLine[]): SpanMessage[] => {
  const rows = parsedLines(lines)
  return messagesOf(rows, marksOrigins(rows))
}

/**
 * Which compaction took a row out of the context: the first whose boundary comes after it, or a later
 * one where that one kept it (Claude Code keeps the last few messages through a compaction, above its
 * boundary); 0 for a row every compaction since has kept, which the context still holds.
 */
export const droppedBy = (boundaries: readonly Boundary[], line: number, uuid: string): number => {
  const first = boundaries.findIndex(b => b.line > line)
  if (first < 0) return 0
  const dropper = boundaries.findIndex((b, i) => i >= first && (uuid === '' || !b.kept.includes(uuid)))
  return dropper < 0 ? 0 : dropper + 1
}

/**
 * What a row says and when, apart from its id and place: two rows with the same are one message written
 * twice (the engine keeps a message's time when it writes it again); '' for a row that is no message.
 */
export const signatureOf = (row: Json): string => {
  const at = str(row.timestamp)
  if (row.type === 'user' || row.type === 'assistant') return `${row.type}@${at}:${JSON.stringify(isJson(row.message) ? row.message.content : null)}`
  return row.type === 'attachment' ? `attachment@${at}:${JSON.stringify(row.attachment)}` : ''
}

/** The messages written after a hook's compaction (the mod's apply, or its note): a message kept through it is written there again, its id new. */
export const copiesOf = (lines: readonly NumberedLine[]): ReadonlySet<string> =>
  new Set(parsedLines(lines).map(({ row }) => signatureOf(row)).filter(signature => signature !== ''))

/** Which compaction a span is, every boundary of the transcript, and the messages written again after its boundary. */
export type SpanFilter = { k: number; boundaries: readonly Boundary[]; copies: ReadonlySet<string> }

/** A span's messages: what its compaction dropped, and what it kept. */
export type SpanParts = { dropped: SpanMessage[]; kept: SpanMessage[] }

/**
 * Splits the rows read for compaction k (from above the boundary before it to its own) into what it
 * dropped and what it kept: a row it kept by id, or one written again after its boundary, stays; rows
 * an earlier compaction dropped are neither.
 */
export const splitSpan = (lines: readonly NumberedLine[], { k, boundaries, copies }: SpanFilter): SpanParts => {
  const rows = parsedLines(lines)
  const hasOrigins = marksOrigins(rows)
  const fates = rows.map(({ line, row }) => {
    const by = droppedBy(boundaries, line, str(row.uuid))
    if (by === k) return copies.has(signatureOf(row)) ? 'kept' : 'dropped'
    return by === 0 || by > k ? 'kept' : 'out'
  })
  const pick = (fate: string): ParsedLine[] => rows.filter((_, i) => fates[i] === fate)
  return { dropped: messagesOf(pick('dropped'), hasOrigins), kept: messagesOf(pick('kept'), hasOrigins) }
}

/** The summary a compaction installed: its marked summary row, or for an apply the first user row with text after the boundary. */
export const summaryFrom = (lines: readonly NumberedLine[]): string | undefined => {
  for (const { text } of lines) {
    const row = parseRow(text)
    if (row?.type !== 'user') continue
    const body = userText(row)
    if (body !== '') return body
  }
  return undefined
}
