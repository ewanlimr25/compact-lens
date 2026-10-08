// The options, the command's help and replies, the tools' descriptions and the fixed texts (pure).
// The engine prints a command's reply and a log line under the plugin's name, so neither repeats it.
import type { HookFailure, PluginOptions } from 'claude-code'

import type { CompactLensPin, CompactLensRecord } from '../types'
import { plural } from './notes'
import { COMMAND, COMPACT_COMMAND, compactionFiles, pad2, SHOW_CAP } from './paths'
import { tokensOf } from './records'
import { cut } from './snapshot'

/** A failed hook's reason, as a `.catch` handler reads it. */
export const failureText = (failure: HookFailure): string => failure.message ?? failure.kind

/** The store key a session's pins and records are mirrored under. */
export const storeKey = (sessionId: string): string => `session:${sessionId}`

export type Config = { warnAtPercent: number; dir: string; openPane: boolean; statusLine: boolean }

const DEFAULT_WARN_AT = 70

/** How many compactions the pane lists, newest last. */
export const SHOWN_RECORDS = 10

export const readConfig = (options: PluginOptions): Config => ({
  warnAtPercent: typeof options.warnAtPercent === 'number' ? options.warnAtPercent : DEFAULT_WARN_AT,
  dir: typeof options.dir === 'string' ? options.dir : '',
  openPane: options.openPane === true,
  statusLine: options.statusLine !== false,
})

// Toasts show under the plugin's name too.
export const EDIT_STARTED_TOAST = `the summary is in the prompt box; edit it there and keep the first line. Enter saves it, then ${COMPACT_COMMAND} applies it`
export const OFFER_TOAST = `${COMPACT_COMMAND} is in the prompt box; Enter applies the edited summary, with no summariser`
export const RUN_COMPACT_TOAST = `run ${COMPACT_COMMAND} to apply the edited summary; the mod answers it with no summariser`

export const HELP = [
  `/${COMMAND}                 open the pane and show the status`,
  `/${COMMAND} edit            put the summary in the prompt box; Enter saves it, then ${COMPACT_COMMAND} applies it`,
  `/${COMMAND} show [what] [n] print lost (the default), after, summary, before or pinned of compaction n`,
  `/${COMMAND} list            list the compactions, their folders and the pinned notes`,
  `/${COMMAND} keep <text>     pin a fact so it survives every compaction verbatim`,
  `/${COMMAND} unpin <n>       remove pinned note n`,
  `/${COMMAND} apply           ready an edited summary.md; ${COMPACT_COMMAND} then applies it`,
  `/${COMMAND} cancel          drop a waiting apply; the edit stays in its file`,
].join('\n')

export const ARGUMENT_HINT = '[edit | show [lost|after|summary|before|pinned] [n] | list | keep <text> | unpin <n> | apply | cancel]'

export const KEEP_DESCRIPTION =
  'Pin a fact so it survives every compaction of this session verbatim: a decision, a path, a number, a name, a rule. ' +
  "The note is put into the summariser's instructions and written, word for word, into the note that follows every summary. Keep each note short and self-contained."

export const APPLY_DESCRIPTION =
  'Ready the edited summary.md of the latest compaction (its path is in the note after the summary and in the Compact Lens section) to replace the current summary. ' +
  `Edit the file first with Edit, then call this. The replacement rides on the person's next ${COMPACT_COMMAND}, which the mod answers with the edited text and no summariser call: ` +
  `when this turn ends ${COMPACT_COMMAND} is put in their prompt box, so tell them to press Enter on it. The transcript after the summary is kept as it is.`

/** What a waiting apply reads as, in the status reply and the pane. */
export const PENDING_TEXT = `an edited summary waits: ${COMPACT_COMMAND} with nothing after it applies it, /${COMMAND} cancel drops it`

export type StatusLineFields = { fill: number | null; records: readonly CompactLensRecord[]; pinCount: number; isPending: boolean }

/** The line under the prompt; it names the plugin itself, as nothing else there does. */
export const statusLineText = ({ fill, records, pinCount, isPending }: StatusLineFields): string =>
  `compact-lens: ${fill === null ? '–' : `${fill}%`} · ${plural(records.length, 'compaction')} · ${pinCount} pinned${isPending ? ` · ${COMPACT_COMMAND} applies the edit` : ''}`

export type StatusFields = { fill: number | null; records: readonly CompactLensRecord[]; pinCount: number; dir: string | null; isPending: boolean }

/** The command's status reply: the fill, the counts, the folder and the latest compaction. */
export const formatStatus = ({ fill, records, pinCount, dir, isPending }: StatusFields): string => {
  const latest = records.at(-1)
  const fillText = fill === null ? 'not measured yet' : `${fill}%`
  return [
    `context ${fillText}; ${plural(records.length, 'compaction')}; ${pinCount} pinned`,
    ...(isPending ? [PENDING_TEXT] : []),
    `snapshots: ${dir ?? '(unset)'}`,
    ...(latest === undefined
      ? []
      : [`latest: #${latest.n} (${latest.trigger}) at ${latest.at}: ${latest.messagesBefore} → ${latest.messagesAfter} messages, ${latest.dir}`]),
  ].join('\n')
}

const listLine = (r: CompactLensRecord, dir: string | null): string => {
  const files = compactionFiles(dir ?? '', r.n)
  return r.trigger === 'unseen'
    ? `  #${r.n} unseen, noticed ${r.at}: the mod did not see it run, so its summary alone is recorded; ${files.summary}`
    : `  #${r.n} ${r.trigger} ${r.at}: ${r.messagesBefore} → ${r.messagesAfter} messages; ${files.before}; the span held ${r.promptsInSpan} prompts and ${r.filesInSpan} files; ${r.identifiersLost} identifiers no longer mentioned`
}

/** The command's list reply: every compaction with its folder and counts, then the pinned notes. */
export const formatList = (records: readonly CompactLensRecord[], pins: readonly CompactLensPin[], dir: string | null): string =>
  [
    `compactions (${records.length}):`,
    ...(records.length === 0 ? ['  none yet'] : []),
    ...records.map(r => listLine(r, dir)),
    `pinned (${pins.length}):`,
    ...(pins.length === 0 ? ['  none'] : pins.map(p => `  ${p.id}. ${p.text}`)),
  ].join('\n')

/** One compaction's line in the pane. */
export const paneLine = (r: CompactLensRecord): string =>
  r.trigger === 'unseen'
    ? `#${pad2(r.n)} unseen, noticed ${r.at.slice(11, 19)}: summary only ${r.dir}`
    : `#${pad2(r.n)} ${r.trigger} ${r.at.slice(11, 19)} ${r.messagesBefore}→${r.messagesAfter} msgs ${tokensOf(r)} ${r.dir}`

export const SHOW_KINDS = ['lost', 'after', 'summary', 'before', 'pinned'] as const
export type ShowKind = (typeof SHOW_KINDS)[number]
export type ShowRequest = { kind: ShowKind; n: number | undefined }

const isShowKind = (word: string): word is ShowKind => (SHOW_KINDS as readonly string[]).includes(word)
const isNumberWord = (word: string): boolean => /^#?\d+$/.test(word)

/** `show [what] [n]`, in either order; the reason when the words are neither. */
export const parseShow = (tail: string): ShowRequest | string => {
  const words = tail.split(/\s+/).filter(word => word !== '')
  const kind = words.find(isShowKind)
  const number = words.find(isNumberWord)
  const other = words.find(word => word !== kind && word !== number)
  if (other !== undefined) return `show takes one of ${SHOW_KINDS.join(', ')} and a compaction number, as in /${COMMAND} show lost 2`
  return { kind: kind ?? 'lost', n: number === undefined ? undefined : Number(number.replace('#', '')) }
}

/** A file printed as the command's reply: its path, then its text, cut at SHOW_CAP. */
export const formatShown = (path: string, text: string): string => `${path}\n\n${cut(text.trimEnd(), SHOW_CAP)}`

/** before.md of a compaction the mod did not see run. */
export const unseenBefore = (n: number, at: string): string =>
  [
    `# before — compaction #${n} (unseen), noticed at ${at}`,
    '',
    'compact-lens did not see this compaction run, so the transcript that went in was not saved here and',
    "nothing could be compared; the session's own transcript file (under ~/.claude/projects/) still holds it.",
    'summary.md holds its summary, and after.md the conversation from that summary on, as the mod found it.',
    '',
  ].join('\n')

/** lost.md of a compaction the mod did not see run. */
export const unseenLost = (n: number, at: string): string =>
  [`# lost — compaction #${n} (unseen), noticed at ${at}`, '', 'Not computed: the mod did not see what went into this compaction. See before.md.', ''].join('\n')
