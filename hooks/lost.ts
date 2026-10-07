import type { SessionMessage, ToolUseSummary } from 'claude-code'

import { IDENTIFIER_CAP, LIST_CAP, PROMPT_CAP, PROMPT_LIST_CAP } from './paths'
import { cut, estimateTokens, fmtTokens, isPrompt, stripReminders, transcriptChars } from './snapshot'

export type LostIdentifier = { id: string; count: number }

export type LostReport = {
  messages: number
  chars: number
  tokens: number
  toolUses: number
  prompts: string[]
  filesEdited: string[]
  filesRead: string[]
  commands: string[]
  agents: string[]
  toolCounts: Array<{ tool: string; count: number }>
  identifiersFound: number
  identifiersKept: number
  /** How many identifiers the context no longer mentions, uncapped. */
  identifiersLostTotal: number
  /** The first IDENTIFIER_CAP of them, most seen first. */
  identifiersLost: LostIdentifier[]
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const COMMAND_CAP = 160
/** How many identifiers, by count, go through the substring merge. */
const MERGE_CAP = 600
const MIN_IDENTIFIER_CHARS = 4
/** Each field of a tool input is mined up to this many characters (a pasted file, a data URI). */
const MINED_FIELD_CAP = 20_000

/**
 * What counts as an identifier: a path, a file name, a git hash, a URL, a code span, a constant, a
 * reference. The relative-path and file-name patterns start at a lookbehind, not `\b`: with `\b` a
 * long dash- or dot-joined run (a data URI, a kebab chain) restarts the scan at every boundary and
 * goes quadratic, past the hook's budget on 80k characters.
 */
const PATTERNS: readonly RegExp[] = [
  /(?:~|\.{1,2})?\/[\w.@+-]+(?:\/[\w.@+-]+)+/g,
  /(?<![\w./-])[\w.-]+(?:\/[\w.-]+)+\.\w{1,8}\b/g,
  /(?<![\w-])[\w-]+\.(?:tsx?|jsx?|mjs|cjs|py|md|json|ya?ml|toml|sh|go|rs|kt|java|css|html|sql|csv|parquet|pine|txt|lock)\b/g,
  /\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g,
  /https?:\/\/[^\s)>\]"']+/g,
  /`([^`\n]{3,80})`/g,
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g,
  /(?<![\w&#])#\d{2,6}\b/g,
]

/** What a sentence leaves after a path or a URL; a code span keeps its own closing characters. */
const TRAILING_PUNCTUATION = /[.,:;'")\]]+$/

const isWorth = (id: string): boolean => id.length >= MIN_IDENTIFIER_CHARS && !/^[\d.]+$/.test(id)

const fieldText = (value: unknown): string => {
  if (typeof value === 'string') return value.slice(0, MINED_FIELD_CAP)
  try {
    return JSON.stringify(value).slice(0, MINED_FIELD_CAP)
  } catch {
    return ''
  }
}

/** A tool input's fields, each cut, so a path beside a pasted file is still seen. */
const stringOfInput = (use: ToolUseSummary): string => Object.values(use.input).map(fieldText).join('\n')

/** What was said in a message: its text (reminders stripped) and its tool inputs; never its tool results. */
const spokenText = (m: SessionMessage): string =>
  [m.role === 'user' ? stripReminders(m.text) : m.text, ...m.toolUses.map(stringOfInput)].join('\n')

export const extractIdentifiers = (text: string): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const pattern of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[1] ?? match[0].replace(TRAILING_PUNCTUATION, '')
      if (!isWorth(raw)) continue
      counts.set(raw, (counts.get(raw) ?? 0) + 1)
    }
  }
  return counts
}

/** Folds an identifier into a longer one that contains it, so a path is listed once, not per segment. */
export const mergeSubstrings = (counts: Map<string, number>): LostIdentifier[] => {
  const byCount = [...counts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
    .slice(0, MERGE_CAP)
    .sort((a, b) => b.id.length - a.id.length)
  return byCount.reduce<LostIdentifier[]>((kept, one) => {
    const at = kept.findIndex(k => k.id.includes(one.id))
    return at < 0 ? [...kept, one] : kept.map((k, i) => (i === at ? { ...k, count: k.count + one.count } : k))
  }, [])
}

const pathOf = (use: ToolUseSummary): string | undefined => {
  const { file_path, notebook_path } = use.input
  if (typeof file_path === 'string') return file_path
  if (typeof notebook_path === 'string') return notebook_path
  return undefined
}

const firstLine = (text: string): string => text.split('\n')[0] ?? ''

const unique = (items: readonly (string | undefined)[], cap: number): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    if (item === undefined || item === '' || seen.has(item)) continue
    seen.add(item)
    out.push(item)
    if (out.length >= cap) break
  }
  return out
}

const describeAgent = (use: ToolUseSummary): string => {
  const description = typeof use.input.description === 'string' ? use.input.description : '(no description)'
  return use.agentId === undefined ? description : `${description} (agent ${use.agentId})`
}

/** What the compacted span held that the context after it does not mention. Heuristic: candidates, not a judgement. */
export const computeLost = (before: readonly SessionMessage[], afterText: string): LostReport => {
  const uses = before.flatMap(m => m.toolUses)
  const counts = extractIdentifiers(before.map(spokenText).join('\n'))
  const merged = mergeSubstrings(counts)
  const lostAll = merged.filter(one => !afterText.includes(one.id)).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
  const lost = lostAll.slice(0, IDENTIFIER_CAP)
  const toolCounts = new Map<string, number>()
  for (const use of uses) toolCounts.set(use.tool, (toolCounts.get(use.tool) ?? 0) + 1)
  const chars = transcriptChars(before)

  return {
    messages: before.length,
    chars,
    tokens: estimateTokens(chars),
    toolUses: uses.length,
    prompts: before.filter(isPrompt).map(m => cut(stripReminders(m.text), PROMPT_CAP)).slice(0, PROMPT_LIST_CAP),
    filesEdited: unique(uses.filter(u => EDIT_TOOLS.has(u.tool)).map(pathOf), LIST_CAP),
    filesRead: unique(uses.filter(u => u.tool === 'Read').map(pathOf), LIST_CAP),
    commands: unique(
      uses.filter(u => u.tool === 'Bash').map(u => (typeof u.input.command === 'string' ? cut(firstLine(u.input.command), COMMAND_CAP) : undefined)),
      LIST_CAP,
    ),
    agents: unique(uses.filter(u => u.tool === 'Agent').map(describeAgent), LIST_CAP),
    toolCounts: [...toolCounts.entries()].map(([tool, count]) => ({ tool, count })).sort((a, b) => b.count - a.count),
    identifiersFound: merged.length,
    identifiersKept: merged.length - lostAll.length,
    identifiersLostTotal: lostAll.length,
    identifiersLost: lost,
  }
}

const list = (title: string, items: readonly string[]): string[] =>
  items.length === 0 ? [] : [`## ${title} (${items.length})`, ...items.map(item => `- ${item}`), '']

export type LostHeader = { n: number; trigger: string; at: string; beforePath: string }

export const renderLost = (report: LostReport, header: LostHeader): string =>
  [
    `# lost — compaction #${header.n} (${header.trigger}) at ${header.at}`,
    '',
    "What the compacted span held (the person's prompts, the files, the commands, the agents: all of",
    'them, whether or not the summary covers them), and the identifiers of the span that the context',
    `after the compaction no longer mentions. Heuristic: candidates, not a judgement. The record is ${header.beforePath}.`,
    '',
    '## Numbers',
    `- messages compacted: ${report.messages}, about ${fmtTokens(report.tokens)} tokens (${report.chars} characters)`,
    `- tool calls: ${report.toolUses}; the person's prompts: ${report.prompts.length}`,
    `- identifiers found in the span: ${report.identifiersFound}; still mentioned: ${report.identifiersKept}; no longer mentioned: ${report.identifiersLostTotal}${report.identifiersLostTotal > report.identifiersLost.length ? ` (the first ${report.identifiersLost.length} listed)` : ''}`,
    '',
    ...(report.prompts.length === 0
      ? []
      : [`## The person's prompts, verbatim (cut at ${PROMPT_CAP} characters)`, ...report.prompts.map((p, i) => `${i + 1}. ${p.replace(/\n/g, '\n   ')}`), '']),
    ...list('Files edited or written', report.filesEdited),
    ...list('Files read', report.filesRead),
    ...list('Commands run', report.commands),
    ...list('Agents spawned', report.agents),
    ...list(
      'Tool calls by tool',
      report.toolCounts.map(one => `${one.tool}: ${one.count}`),
    ),
    ...list(
      'Identifiers the context no longer mentions (times seen in the span)',
      report.identifiersLost.map(one => `\`${one.id}\` ×${one.count}`),
    ),
  ].join('\n')
