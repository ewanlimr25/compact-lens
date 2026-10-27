// The lost report as Markdown (pure): what a compaction dropped first, then everything its span held.
// The same text is lost.md, the reply to /compact-lens lost, and the pane's view.
import type { CompactLensSpan } from '../types'
import type { LostPrompt, LostReport } from './lost'
import { COMMAND, PROMPT_CAP, RECALL_TOOL, WEAK_COVERAGE } from './paths'
import { fmtTokens } from './snapshot'

export type LostHeader = {
  n: number
  trigger: string
  at: string
  beforePath: string
  tokensBefore?: number
  tokensAfter?: number
  span?: CompactLensSpan
}

/** An ISO time as a short UTC stamp: 2026-10-26T22:17:03.120Z → 2026-10-26 22:17 UTC. */
export const shortTime = (iso: string): string => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : iso)

const list = (title: string, items: readonly string[]): string[] =>
  items.length === 0 ? [] : [`### ${title} (${items.length})`, ...items.map(item => `- ${item}`), '']

/** ✓ when most of a prompt's words are in the summary, ✗ when few are, – when it is too short to say. */
const mark = (prompt: LostPrompt): string => (prompt.coverage === null ? '–' : prompt.coverage < WEAK_COVERAGE ? '✗' : '✓')

const promptLine = (prompt: LostPrompt, i: number): string => {
  const when = prompt.at === undefined ? '' : `${shortTime(prompt.at)} — `
  return `${i + 1}. ${mark(prompt)} ${when}${prompt.text.replace(/\n/g, '\n   ')}`
}

/** The size of the span: the engine's token count when it gave one, and the characters of its text and tool calls. */
const sizeLine = (report: LostReport, tokensBefore: number | undefined): string =>
  tokensBefore === undefined
    ? `- messages compacted: ${report.messages}, about ${fmtTokens(report.tokens)} tokens (${report.chars} characters, at 4 a token)`
    : `- messages compacted: ${report.messages}, ${fmtTokens(tokensBefore)} tokens by the engine's count; their text and tool calls are ${report.chars} characters (about ${fmtTokens(report.tokens)} tokens at 4 a token)`

const headerLine = (header: LostHeader): string => {
  const tokens = header.tokensBefore === undefined ? '' : ` · ${fmtTokens(header.tokensBefore)} tokens in${header.tokensAfter === undefined ? '' : ` → ${fmtTokens(header.tokensAfter)} out`}`
  const lines = header.span === undefined ? '' : ` · transcript lines ${header.span.from}–${header.span.to}`
  return `${header.trigger} · ${shortTime(header.at)}${tokens}${lines}`
}

/** The opening section: the counts that matter and how to get things back. */
const glance = (report: LostReport, n: number): string[] => {
  const unnamed = report.filesUnnamed.length
  const files = report.filesEdited.length + report.filesRead.filter(path => !report.filesEdited.includes(path)).length
  return [
    '## At a glance',
    `- Your prompts: ${report.prompts.length}${report.prompts.length === 0 ? '' : `; ${report.promptsWeak} barely appear in the summary (✗ below)`}.`,
    `- Files: ${files} touched; ${unnamed} never named after the compaction.`,
    `- Details: ${report.identifiersLostTotal} identifiers (paths, hashes, names, links) no longer mentioned.`,
    `- To get them back: \`/${COMMAND} restore ${n}\` gives Claude your prompts verbatim; \`/${COMMAND} restore ${n} <words>\` the passages that mention them. Claude can search with ${RECALL_TOOL} itself.`,
    '',
  ]
}

const promptsSection = (report: LostReport): string[] =>
  report.prompts.length === 0
    ? []
    : [
        `## Your prompts, verbatim (cut at ${PROMPT_CAP} characters)`,
        '✓ most of its words are in the summary · ✗ few are · – too short to judge',
        '',
        ...report.prompts.map(promptLine),
        '',
      ]

const unnamedSection = (report: LostReport): string[] =>
  report.filesUnnamed.length === 0
    ? []
    : [`## Files never named after the compaction (${report.filesUnnamed.length})`, ...report.filesUnnamed.map(f => `- ${f.path} (${f.how})`), '']

const detailsSection = (report: LostReport): string[] =>
  report.identifiersLost.length === 0
    ? []
    : [
        `## Details no longer mentioned (times seen in the span)${report.identifiersLostTotal > report.identifiersLost.length ? `: the first ${report.identifiersLost.length} of ${report.identifiersLostTotal}` : ''}`,
        ...report.identifiersLost.map(one => `- \`${one.id}\` ×${one.count}`),
        '',
      ]

const everything = (report: LostReport, tokensBefore: number | undefined): string[] => [
  '## Everything the span held',
  sizeLine(report, tokensBefore),
  `- tool calls: ${report.toolUses}; your prompts: ${report.prompts.length}; slash commands: ${report.slashCommands.length}`,
  `- identifiers found in the span: ${report.identifiersFound}; still mentioned: ${report.identifiersKept}; no longer mentioned: ${report.identifiersLostTotal}`,
  '',
  ...list(`Slash commands you ran (cut at ${PROMPT_CAP} characters)`, report.slashCommands),
  ...list('Files edited or written', report.filesEdited),
  ...list('Files read (by Read, and by cat, head, sed and the like in Bash, as written)', report.filesRead),
  ...list('Commands run', report.commands),
  ...list('Agents spawned', report.agents),
  ...list(
    'Tool calls by tool',
    report.toolCounts.map(one => `${one.tool}: ${one.count}`),
  ),
]

/** lost.md: what compaction n dropped, then everything its span held. */
export const renderLost = (report: LostReport, header: LostHeader): string =>
  [
    `# What compaction #${header.n} (${header.trigger}) dropped`,
    '',
    headerLine(header),
    '',
    'The summary is lossy. First what the compacted span held that the context after it no longer says, then',
    `everything the span held. Heuristic: candidates, not a judgement. The full record is ${header.beforePath}.`,
    '',
    ...glance(report, header.n),
    ...promptsSection(report),
    ...unnamedSection(report),
    ...detailsSection(report),
    ...everything(report, header.tokensBefore),
  ].join('\n')
