import type { SessionMessage, ToolUseSummary } from 'claude-code'

import { TEXT_CAP, TOOL_INPUT_CAP, TOOL_RESULT_CAP } from './paths'

/** Cuts `text` to `cap` characters, saying how much was cut. */
export const cut = (text: string, cap: number): string =>
  text.length <= cap ? text : `${text.slice(0, cap)}\n… [cut: ${text.length - cap} more characters]`

/** Drops the engine's system-reminder blocks from a user message's text. */
export const stripReminders = (text: string): string =>
  text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()

/** True for a message the person typed: a user message with text and no tool results. */
export const isPrompt = (m: SessionMessage): boolean =>
  m.role === 'user' && (m.toolResults === undefined || m.toolResults.length === 0) && stripReminders(m.text) !== ''

export const inputText = (use: ToolUseSummary): string => {
  try {
    return JSON.stringify(use.input, null, 1)
  } catch {
    return String(use.input)
  }
}

/** The characters a message puts in the context: its text, its tool inputs and its tool results. */
export const messageChars = (m: SessionMessage): number =>
  m.text.length +
  m.toolUses.reduce((sum, use) => sum + inputText(use).length, 0) +
  (m.toolResults ?? []).reduce((sum, result) => sum + result.text.length, 0)

export const transcriptChars = (messages: readonly SessionMessage[]): number =>
  messages.reduce((sum, m) => sum + messageChars(m), 0)

/** A rough token count: four characters a token. */
export const estimateTokens = (chars: number): number => Math.round(chars / 4)

export const fmtTokens = (n: number): string =>
  n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

/** The text the context holds after a compaction: every message's text and tool results. */
export const contextText = (messages: readonly SessionMessage[]): string =>
  messages.flatMap(m => [m.text, ...(m.toolResults ?? []).map(r => r.text)]).join('\n')

const renderToolUse = (use: ToolUseSummary): string => {
  const lines = [`### tool ${use.tool} (${use.tool_use_id})`, '```json', cut(inputText(use), TOOL_INPUT_CAP), '```']
  if (use.text !== undefined) {
    lines.push(`result${use.isError === true ? ' (error)' : ''}:`, '```', cut(use.text, TOOL_RESULT_CAP), '```')
  }
  return lines.join('\n')
}

const renderMessage = (m: SessionMessage, index: number): string => {
  const parts = [`## ${index + 1} · ${m.role}`]
  const results = m.toolResults ?? []
  if (results.length > 0) {
    parts.push(`(${results.length} tool result${results.length === 1 ? '' : 's'}, shown under the calls above)`)
  }
  const text = m.text.trim()
  if (text !== '') parts.push(cut(text, TEXT_CAP))
  for (const use of m.toolUses) parts.push(renderToolUse(use))
  if (text === '' && m.toolUses.length === 0 && results.length === 0) parts.push('(no text: a thinking-only or empty message)')
  return parts.join('\n\n')
}

export type TranscriptHeader = { title: string; lines: readonly string[] }

/** A transcript as a readable markdown record, one section per message. */
export const renderTranscript = (messages: readonly SessionMessage[], header: TranscriptHeader): string =>
  [`# ${header.title}`, header.lines.join('\n'), ...messages.map(renderMessage)].join('\n\n') + '\n'

/** The raw record, the engine's handles left out. */
export const toJson = (messages: readonly SessionMessage[]): string =>
  JSON.stringify(
    messages.map(m => {
      const { handle: _handle, ...rest } = m
      return rest
    }),
    null,
    1,
  )

/** The index of the summary in a compaction's result: the first user message with text and no tool results. */
export const findSummaryIndex = (messages: readonly SessionMessage[]): number =>
  messages.findIndex(m => m.role === 'user' && m.text.trim() !== '' && (m.toolResults ?? []).length === 0)
