// What a restore or a recall hands the model (pure): the person's prompts from a compacted span, or the
// passages of the compacted transcript that match a search, as one block, verbatim, held to RESTORE_CAP.
import { EXCERPT_RADIUS, MIN_SEARCH_CHARS, RESTORE_CAP } from './paths'
import { shortTime } from './report'
import { cut } from './snapshot'
import type { NumberedLine } from './transcript'
import { parseRow } from './transcript'

/**
 * A text with its ASCII letters lower-cased and every other character as it is: the host's search
 * (perl's `tr/A-Z/a-z/` over the file's bytes) folds no other case, so a word with other letters is
 * found in the case it is typed. The length never changes, so an index in one is an index in the other.
 */
export const asciiLower = (text: string): string => text.replace(/[A-Z]/g, letter => letter.toLowerCase())

/** The words of a search, ASCII-lower-cased: "quoted phrases" whole, other words one by one, each once. */
export const searchTerms = (query: string): string[] =>
  [...query.matchAll(/"([^"]+)"|(\S+)/g)]
    .map(match => asciiLower((match[1] ?? match[2] ?? '').trim()))
    .filter((term, i, all) => term !== '' && all.indexOf(term) === i)

/** Each term spelled as the transcript file spells it inside a quoted text, for the host's search. */
export const needlesOf = (terms: readonly string[]): string[] => terms.map(term => JSON.stringify(term).slice(1, -1))

/** One part of a row worth showing: who or what it is, and its text. */
type Piece = { label: string; text: string }

type Json = Record<string, unknown>
const isJson = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value)
const blocksOf = (content: unknown): Json[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content.filter(isJson) : []
const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : blocksOf(content)
        .map(block => (typeof block.text === 'string' ? block.text : ''))
        .join('\n')

const userLabel = (row: Json): string => {
  if (row.isCompactSummary === true) return 'an earlier summary'
  const origin = isJson(row.origin) ? row.origin.kind : undefined
  if (origin === 'human') return 'the person'
  return row.isMeta === true ? 'a note to Claude' : typeof origin === 'string' ? `a ${origin} message` : 'a user-side message'
}

const userPieces = (row: Json): Piece[] =>
  blocksOf(isJson(row.message) ? row.message.content : undefined).flatMap(block =>
    block.type === 'tool_result'
      ? [{ label: 'a tool result', text: textOf(block.content) }]
      : block.type === 'text' && typeof block.text === 'string'
        ? [{ label: userLabel(row), text: block.text }]
        : [],
  )

/** A tool call's input as the values it holds, `key: value` a line: what was typed, unescaped, for the search and the excerpt. */
const inputText = (input: unknown): string =>
  isJson(input) ? Object.entries(input).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join('\n') : ''

const assistantPieces = (row: Json): Piece[] =>
  blocksOf(isJson(row.message) ? row.message.content : undefined).flatMap(block =>
    block.type === 'tool_use'
      ? [{ label: `Claude's ${typeof block.name === 'string' ? block.name : 'tool'} call`, text: inputText(block.input) }]
      : block.type === 'text' && typeof block.text === 'string'
        ? [{ label: 'Claude', text: block.text }]
        : [],
  )

/** The parts of a transcript row a search can match: a prompt, a reply, a tool call or result, a queued prompt. */
const piecesOf = (row: Json): Piece[] => {
  if (row.isSidechain === true) return []
  if (row.type === 'user') return userPieces(row)
  if (row.type === 'assistant') return assistantPieces(row)
  const attachment = isJson(row.attachment) ? row.attachment : {}
  return attachment.type === 'queued_command' && typeof attachment.prompt === 'string' ? [{ label: 'a queued prompt', text: attachment.prompt }] : []
}

/** The text around the first place `term` stands in `text`, cut at EXCERPT_RADIUS on each side. */
export const excerptAround = (text: string, term: string): string => {
  const at = asciiLower(text).indexOf(term)
  const start = Math.max(0, at - EXCERPT_RADIUS)
  const end = Math.min(text.length, (at < 0 ? 0 : at + term.length) + EXCERPT_RADIUS)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`
}

/** A matching part of the transcript: where it stands, who wrote it, the text around the match, and the words it lacks (a partial match). */
export type Passage = { line: number; at: string; label: string; excerpt: string; missing?: readonly string[] }

/** A passage of the compacted transcript and the compaction that took it out of the context. */
export type Found = Passage & { n: number }

/**
 * The parts of a parsed row that hold at least `least` of the terms (every one when left out), each as a
 * passage. A part that lacks some must hold one long enough to search on, as a search must.
 */
export const passagesOfRow = (line: number, row: Record<string, unknown>, terms: readonly string[], least = terms.length): Passage[] => {
  if (terms.length === 0) return []
  const at = typeof row.timestamp === 'string' ? row.timestamp : ''
  return piecesOf(row).flatMap(piece => {
    const text = asciiLower(piece.text)
    const held = terms.filter(term => text.includes(term))
    const isPartial = held.length < terms.length
    if (held.length === 0 || held.length < least || (isPartial && !held.some(term => term.length >= MIN_SEARCH_CHARS))) return []
    const missing = terms.filter(term => !held.includes(term))
    return [{ line, at, label: piece.label, excerpt: excerptAround(piece.text, held[0] ?? ''), ...(isPartial ? { missing } : {}) }]
  })
}

/** The parts of one transcript line that hold every term, each as a passage. */
export const passagesOf = ({ line, text }: NumberedLine, terms: readonly string[]): Passage[] => {
  const row = parseRow(text)
  return row === undefined ? [] : passagesOfRow(line, row, terms)
}

/** The most one entry may take, so a single huge one cannot fill the block alone. */
const ENTRY_CAP = Math.floor(RESTORE_CAP / 2)

/** The entries that fit in `room` characters, in the order given (each cut to ENTRY_CAP), and how many did not. */
const fitting = (entries: readonly string[], room: number): { kept: string[]; left: number } => {
  const kept: string[] = []
  let used = 0
  for (const entry of entries.map(one => cut(one, ENTRY_CAP))) {
    if (used + entry.length + 1 > room) break
    kept.push(entry)
    used += entry.length + 1
  }
  return { kept, left: entries.length - kept.length }
}

/** What the line saying how many were left out may take. */
const NOTE_ROOM = 160

const roomFor = (head: readonly string[], tail: readonly string[]): number => RESTORE_CAP - [...head, ...tail].join('\n').length - NOTE_ROOM

/**
 * `unread`: how many rows holding the words the search stopped before reading. `least` of the query's
 * `termCount` words each passage holds: every one, or all but one where no passage held them all.
 */
export type RecallArgs = { query: string; passages: readonly Found[]; scope: string; transcript: string; unread: number; least: number; termCount: number }

const RECALL_END = '</compact-lens-recall>'

/** What the rows hold, as the unread line says it: every word, or so many of them. */
const heldWords = ({ least, termCount }: RecallArgs): string => (least >= termCount ? 'every word' : `${least} of the words`)

const unreadLine = (unread: number, args: RecallArgs): string =>
  unread === 1
    ? `1 more row holds ${heldWords(args)} but was not read: add a word, or name a compaction, to reach it.`
    : `${unread} more rows hold ${heldWords(args)} but were not read: add a word, or name a compaction, to reach them.`

const recallOpening = (args: RecallArgs): string => {
  const { query, passages, scope, transcript, unread, least, termCount } = args
  if (passages.length > 0 && least < termCount)
    return `No passage of ${scope} holds every word of "${query}". These hold ${least} of its ${termCount} words, verbatim, newest first; each names the word it lacks, the compaction that took it out of the context and its line in ${transcript}.`
  if (passages.length > 0) return `Passages from ${scope} that hold every word of "${query}", verbatim, newest first. Each is named by the compaction that took it out of the context and its line in ${transcript}.`
  if (unread > 0) return `No passage of ${scope} read so far holds ${heldWords(args)} of "${query}". ${unreadLine(unread, args)}`
  return `Nothing in ${scope} matches "${query}". The compacted transcript is ${transcript}; a different word, or fewer words, may find it.`
}

/** What a partial passage lacks, at the end of its heading. */
const lacking = (p: Found): string => (p.missing === undefined || p.missing.length === 0 ? '' : ` · lacks ${p.missing.map(word => JSON.stringify(word)).join(', ')}`)

/** The recall's answer: the passages, newest first, each named by the compaction that removed it and its transcript line. */
export const recallBlock = (args: RecallArgs): string => {
  const { query, passages, unread } = args
  const head = [`<compact-lens-recall query=${JSON.stringify(query)}>`, recallOpening(args)]
  const entries = passages.map(p => `--- #${p.n} · line ${p.line} · ${p.label}${p.at === '' ? '' : ` · ${shortTime(p.at)}`}${lacking(p)}\n${p.excerpt}`)
  const tail = passages.length > 0 && unread > 0 ? [`(${unreadLine(unread, args)})`] : []
  const { kept, left } = fitting(entries, roomFor(head, [...tail, RECALL_END]))
  const more = left > 0 ? [`(${left} more passages not shown, past ${RESTORE_CAP} characters: search with more words, or name a compaction)`] : []
  return [...head, ...kept, ...more, ...tail, RECALL_END].join('\n')
}

/** One of the person's prompts as a restore gives it back. */
export type RestoredPrompt = { text: string; at: string }

export type PromptsArgs = { n: number; prompts: readonly RestoredPrompt[]; isRequestedByPerson: boolean }

const RESTORE_END = '</compact-lens-restore>'

/** The person's prompts from compaction n's span, for the model: verbatim, oldest first; past RESTORE_CAP the newest are kept. */
export const promptsBlock = ({ n, prompts, isRequestedByPerson }: PromptsArgs): string => {
  const who = isRequestedByPerson ? 'The person asked for these back' : 'Recalled'
  const head = [
    `<compact-lens-restore n="${n}" kind="prompts">`,
    `${who}: the person's own prompts from the span compaction #${n} summarised, verbatim, oldest first. The summary paraphrased them; where it differs, these are what the person said.`,
  ]
  const entries = prompts.map((p, i) => `${i + 1}. ${p.at === '' ? '' : `[${shortTime(p.at)}] `}${p.text}`)
  const { kept, left } = fitting([...entries].reverse(), roomFor(head, [RESTORE_END]))
  const older = left > 0 ? [`(the ${left} oldest not shown, past ${RESTORE_CAP} characters)`] : []
  return [...head, ...older, ...[...kept].reverse(), RESTORE_END].join('\n')
}
