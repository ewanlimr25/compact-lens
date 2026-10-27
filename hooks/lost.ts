// What a compaction dropped (pure): the span's prompts, files, commands and identifiers, set against
// the text the context holds after it. Heuristic: candidates, not a judgement.
import type { SessionMessage, ToolUseSummary } from 'claude-code'

import { IDENTIFIER_CAP, LIST_CAP, MIN_JUDGED_WORDS, PROMPT_CAP, PROMPT_LIST_CAP, WEAK_COVERAGE } from './paths'
import { cut, estimateTokens, isPrompt, stripReminders, transcriptChars } from './snapshot'

export type LostIdentifier = { id: string; count: number }

/** One of the person's prompts: its text, when it was sent, and how much of it the summary keeps. */
export type LostPrompt = {
  text: string
  at?: string
  /** The share of its distinct words the context after the compaction holds; null for a prompt too short to judge. */
  coverage: number | null
}

/** A file the span touched that the context after the compaction never names. */
export type UnnamedFile = { path: string; how: 'edited' | 'read' }

export type LostReport = {
  messages: number
  chars: number
  tokens: number
  toolUses: number
  prompts: LostPrompt[]
  /** How many prompts the summary barely reflects (coverage under WEAK_COVERAGE). */
  promptsWeak: number
  /** The slash commands the person ran, as `/name args`. */
  slashCommands: string[]
  filesEdited: string[]
  filesRead: string[]
  filesUnnamed: UnnamedFile[]
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

/** A message of the span: the engine's, or one read from the transcript with its time and whether the person typed it. */
export type LostInput = SessionMessage & { at?: string; isPrompt?: boolean }

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

/** A slash command's echo, in the person's name: `<command-name>/x</command-name>` and its arguments. */
export const COMMAND_ROW = /^<command-(?:name|message)>/
/** Rows the engine writes in the person's name that the person did not type: a command's output, a skill's body. */
export const ENGINE_ROW =
  /^(?:<local-command-(?:stdout|stderr|caveat)>|Caveat: The messages below were generated by the user while running local commands|Base directory for this skill:)/

/** A slash command as the person typed it, where the transcript keeps no echo: `/compact`, `/model opus`. */
export const SLASH_ROW = /^\/[A-Za-z][\w:.-]*(?=\s|$)/

/** The mod's own blocks, which the engine writes as plain user rows: the note after a summary, the warning, a restore, a recall. */
export const LENS_ROW = /^<compact-lens(?:-restore|-recall)?[\s>]/

/** Whether a user row's text is a command, the engine's or the mod's, not a prompt: an echo, a typed slash command, a command's output, a skill's body, a note of the mod's. */
export const isCommandText = (text: string): boolean => {
  const opening = text.trimStart()
  return COMMAND_ROW.test(opening) || ENGINE_ROW.test(opening) || SLASH_ROW.test(opening) || LENS_ROW.test(opening)
}

/** A command row as the person typed it: `/name args`. */
const commandOf = (text: string): string => {
  const name = /<command-name>\/?([^<]*)<\/command-name>/.exec(text)?.[1]?.trim() ?? '?'
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? ''
  return args === '' ? `/${name}` : `/${name} ${args}`
}

/** Plain readers: a Bash command led by one of these reads the files it names. */
const READ_COMMANDS = new Set(['cat', 'head', 'tail', 'sed', 'less', 'more', 'bat', 'nl', 'wc', 'grep', 'rg', 'awk', 'diff', 'jq'])
const MIN_PATH_CHARS = 4

/** An argument that names a file: a path or a name with an extension, never a flag, a pattern, a variable, a folder or /dev. */
const looksLikeFile = (word: string): boolean =>
  word.length >= MIN_PATH_CHARS &&
  !word.startsWith('-') &&
  !word.startsWith('/dev/') &&
  !word.endsWith('/') &&
  !/["'`$*?<>(){}=\\]/.test(word) &&
  (word.includes('/') || /\.[A-Za-z][\w]{0,7}$/.test(word))

/** A here-document: from `<<` to its closing delimiter line, the rest of the opening line (a redirection) included. */
const HEREDOC = /<<-?[ \t]*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g

/** A segment's arguments up to its first redirection: what follows `>` is written, not read. */
const beforeRedirect = (words: readonly string[]): readonly string[] => {
  const at = words.findIndex(word => /^(?:\d*>|&>|<)/.test(word))
  return at < 0 ? words : words.slice(0, at)
}

/** A shell word with its quotes: a quoted part stays whole, so a pattern with spaces is one word, and its quotes keep it from passing for a file. */
const SHELL_WORD = /(?:'[^']*'|"(?:\\.|[^"\\])*"|[^\s'"]|['"])+/g
/** Readers whose first plain argument is a pattern or a program, not a file. */
const PATTERN_FIRST = new Set(['grep', 'rg', 'sed', 'awk', 'jq'])
/** Flags that take the pattern as their value, leaving every plain argument a file. */
const PATTERN_FLAGS = new Set(['-e', '-f', '--regexp', '--file'])

/** The arguments a reader names as files: for grep, sed and the like, less the pattern (the first plain argument, or the value of -e). */
const operandsOf = (name: string, words: readonly string[]): string[] => {
  if (!PATTERN_FIRST.has(name)) return [...words]
  const values = new Set(words.flatMap((word, i) => (PATTERN_FLAGS.has(word) ? [i, i + 1] : [])))
  const plain = words.filter((word, i) => !word.startsWith('-') && !values.has(i))
  return values.size > 0 ? plain : plain.slice(1)
}

/** The files a Bash command reads with a plain reader (cat, head, sed …), as written; never a here-document's body, a redirection's target or `sed -i`'s file. Heuristic, like the rest. */
export const bashReads = (command: string): string[] =>
  command
    .replace(HEREDOC, '')
    .split(/&&|\|\||[;|\n]/)
    .flatMap(segment => {
      const [name = '', ...rest] = segment.trim().match(SHELL_WORD) ?? []
      if (!READ_COMMANDS.has(name) || (name === 'sed' && rest.some(word => word.startsWith('-i')))) return []
      return operandsOf(name, beforeRedirect(rest)).filter(looksLikeFile)
    })

const describeAgent = (use: ToolUseSummary): string => {
  const description = typeof use.input.description === 'string' ? use.input.description : '(no description)'
  return use.agentId === undefined ? description : `${description} (agent ${use.agentId})`
}

/** Words too common to say whether a summary kept a prompt. */
const COMMON_WORDS = new Set(
  'this that with from have what when then them they there their will would should could just also into your about these those which where while been were make made like more some than only over such very even here after before each other because does doing done want need please lets okay sure yeah thanks thank'.split(' '),
)
const WORD = /[\p{L}\p{N}][\p{L}\p{N}_'.-]*/gu

/** A text's distinct words worth comparing: four letters or more, not among the common ones. */
export const wordsOf = (text: string): Set<string> =>
  new Set((text.toLowerCase().match(WORD) ?? []).map(word => word.replace(/[.'-]+$/, '')).filter(word => word.length >= 4 && !COMMON_WORDS.has(word)))

/** How much of a prompt the context keeps: the share of its words found there; null below MIN_JUDGED_WORDS. */
export const coverageOf = (prompt: string, kept: ReadonlySet<string>): number | null => {
  const words = [...wordsOf(prompt)]
  if (words.length < MIN_JUDGED_WORDS) return null
  return words.filter(word => kept.has(word)).length / words.length
}

const isWeak = (prompt: LostPrompt): boolean => prompt.coverage !== null && prompt.coverage < WEAK_COVERAGE

const baseName = (path: string): string => path.split('/').filter(part => part !== '').at(-1) ?? path

/** The files the span touched that the context after the compaction never names, by path or by file name. */
const unnamedFiles = (edited: readonly string[], read: readonly string[], afterText: string): UnnamedFile[] => {
  const isNamed = (path: string): boolean => afterText.includes(path) || afterText.includes(baseName(path))
  const editedSet = new Set(edited)
  return [
    ...edited.filter(path => !isNamed(path)).map(path => ({ path, how: 'edited' as const })),
    ...read.filter(path => !editedSet.has(path) && !isNamed(path)).map(path => ({ path, how: 'read' as const })),
  ]
}

/** The person's prompts, oldest first: the rows they typed, less slash commands and what the engine wrote in their name. */
const promptsOf = (before: readonly LostInput[], kept: ReadonlySet<string>): LostPrompt[] =>
  before
    .filter(m => m.isPrompt ?? isPrompt(m))
    .map(m => ({ text: stripReminders(m.text), at: m.at }))
    .filter(p => !isCommandText(p.text))
    .slice(0, PROMPT_LIST_CAP)
    .map(p => ({ text: cut(p.text, PROMPT_CAP), ...(p.at === undefined || p.at === '' ? {} : { at: p.at }), coverage: coverageOf(p.text, kept) }))

/** The slash commands the person ran, from their echo rows or as typed (neither is a prompt), as `/name args`. */
const slashCommandsOf = (before: readonly LostInput[]): string[] =>
  unique(
    before
      .filter(m => m.role === 'user' && (m.toolResults ?? []).length === 0)
      .map(m => stripReminders(m.text).trim())
      .filter(text => COMMAND_ROW.test(text) || SLASH_ROW.test(text))
      .map(text => cut(COMMAND_ROW.test(text) ? commandOf(text) : firstLine(text), PROMPT_CAP)),
    LIST_CAP,
  )

/** What the compacted span held that the context after it does not mention. Heuristic: candidates, not a judgement. */
export const computeLost = (before: readonly LostInput[], afterText: string): LostReport => {
  const uses = before.flatMap(m => m.toolUses)
  const counts = extractIdentifiers(before.map(spokenText).join('\n'))
  const merged = mergeSubstrings(counts)
  const lostAll = merged.filter(one => !afterText.includes(one.id)).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
  const toolCounts = new Map<string, number>()
  for (const use of uses) toolCounts.set(use.tool, (toolCounts.get(use.tool) ?? 0) + 1)
  const chars = transcriptChars(before)
  const prompts = promptsOf(before, wordsOf(afterText))
  const filesEdited = unique(uses.filter(u => EDIT_TOOLS.has(u.tool)).map(pathOf), LIST_CAP)
  const filesRead = unique(
    uses.flatMap(u => (u.tool === 'Read' ? [pathOf(u)] : u.tool === 'Bash' && typeof u.input.command === 'string' ? bashReads(u.input.command) : [])),
    LIST_CAP,
  )

  return {
    messages: before.length,
    chars,
    tokens: estimateTokens(chars),
    toolUses: uses.length,
    prompts,
    promptsWeak: prompts.filter(isWeak).length,
    slashCommands: slashCommandsOf(before),
    filesEdited,
    filesRead,
    filesUnnamed: unnamedFiles(filesEdited, filesRead, afterText),
    commands: unique(
      uses.filter(u => u.tool === 'Bash').map(u => (typeof u.input.command === 'string' ? cut(firstLine(u.input.command), COMMAND_CAP) : undefined)),
      LIST_CAP,
    ),
    agents: unique(uses.filter(u => u.tool === 'Agent').map(describeAgent), LIST_CAP),
    toolCounts: [...toolCounts.entries()].map(([tool, count]) => ({ tool, count })).sort((a, b) => b.count - a.count),
    identifiersFound: merged.length,
    identifiersKept: merged.length - lostAll.length,
    identifiersLostTotal: lostAll.length,
    identifiersLost: lostAll.slice(0, IDENTIFIER_CAP),
  }
}
