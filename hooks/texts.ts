// The command's help and replies, the tools' descriptions and the fixed texts (pure). The engine prints
// a command's reply and a log line under the plugin's name, so neither repeats it.
import type { HookFailure } from 'claude-code'

import type { CompactLensContext, CompactLensPin, CompactLensRecord } from '../types'
import { contextPhrase, plural } from './notes'
import { COMMAND, COMPACT_COMMAND, compactionFiles, pad2, SHOW_CAP } from './paths'
import { tokensOf } from './records'
import { shortTime } from './report'
import { cut } from './snapshot'

/** A failed hook's reason, as a `.catch` handler reads it. */
export const failureText = (failure: HookFailure): string => failure.message ?? failure.kind

/** The store key a session's pins are kept under. */
export const storeKey = (sessionId: string): string => `session:${sessionId}`

// Toasts show under the plugin's name too.
export const EDIT_STARTED_TOAST = `the summary is in the prompt box; edit it there and keep the first line. Enter saves it, then ${COMPACT_COMMAND} applies it`
export const OFFER_TOAST = `${COMPACT_COMMAND} is in the prompt box; Enter applies the edited summary, with no summariser`
export const RUN_COMPACT_TOAST = `run ${COMPACT_COMMAND} to apply the edited summary; the mod answers it with no summariser`

export const HELP = [
  `/${COMMAND}                       open the pane: every compaction, what it dropped, restore and edit`,
  `/${COMMAND} lost [n]              print what compaction n dropped (the latest when n is left out)`,
  `/${COMMAND} restore [n]           give Claude back your prompts from compaction n, verbatim`,
  `/${COMMAND} restore [n] <words>   give Claude back the compacted passages that mention <words>`,
  `/${COMMAND} edit                  put the summary in the prompt box; Enter saves it, then ${COMPACT_COMMAND} applies it`,
  `/${COMMAND} show [what] [n]       print after, summary, before, lost or pinned of compaction n`,
  `/${COMMAND} list                  list every compaction of this session, its folder and its counts`,
  `/${COMMAND} keep <text>           pin a fact so it survives every compaction verbatim`,
  `/${COMMAND} unpin <n>             remove pinned note n`,
  `/${COMMAND} apply                 ready an edited summary.md; ${COMPACT_COMMAND} then applies it`,
  `/${COMMAND} cancel                drop a waiting apply; the edit stays in its file`,
].join('\n')

export const ARGUMENT_HINT = '[lost [n] | restore [n] [words] | edit | show [what] [n] | list | keep <text> | unpin <n> | apply | cancel]'

export const KEEP_DESCRIPTION =
  'Pin a fact so it survives every compaction of this session verbatim: a decision, a path, a number, a name, a rule. ' +
  "The note is put into the summariser's instructions and written, word for word, into the note that follows every summary. Keep each note short and self-contained."

export const APPLY_DESCRIPTION =
  'Ready the edited summary.md of the latest compaction (its path is in the note after the summary and in the Compact Lens section) to replace the current summary. ' +
  `Edit the file first with Edit, then call this. The replacement rides on the person's next ${COMPACT_COMMAND}, which the mod answers with the edited text and no summariser call: ` +
  `when this turn ends ${COMPACT_COMMAND} is put in their prompt box, so tell them to press Enter on it. The transcript after the summary is kept as it is.`

export const RECALL_DESCRIPTION =
  "Search what earlier compactions of this session took out of your context: the session's own transcript before each summary. " +
  'Returns the passages that hold every word of `query` (put a phrase in double quotes to keep it whole), verbatim, newest first, each named by its compaction and transcript line. ' +
  "Use it when the summary lacks an exact detail you need: a path, a number, a command's output, a decision, or the person's own words. `compaction` limits the search to one compaction's span."

/** What a waiting apply reads as, in the status reply and the pane. */
export const PENDING_TEXT = `an edited summary waits: ${COMPACT_COMMAND} with nothing after it applies it, /${COMMAND} cancel drops it`

export type StatusLineFields = { context: CompactLensContext | null; records: readonly CompactLensRecord[]; pinCount: number; isPending: boolean }

/** The line under the prompt; it names the plugin itself, as nothing else there does. */
export const statusLineText = ({ context, records, pinCount, isPending }: StatusLineFields): string =>
  `compact-lens: ${context === null ? '–' : contextPhrase(context)} · ${plural(records.length, 'compaction')} · ${pinCount} pinned${isPending ? ` · ${COMPACT_COMMAND} applies the edit` : ''}`

/** How a record was learned of, for the list and the pane. */
const howSeen = (r: CompactLensRecord): string =>
  r.trigger === 'unseen' ? 'summary only' : r.source === 'transcript' ? (r.hasDetail === false ? 'from the transcript, not read yet' : 'from the transcript') : 'seen live'

export type StatusFields = StatusLineFields & { dir: string | null; transcript: 'read' | 'missing' | 'unreadable' }

/** The command's status reply: the context, the counts, the folder and the latest compaction. */
export const formatStatus = ({ context, records, pinCount, dir, isPending, transcript }: StatusFields): string => {
  const latest = records.at(-1)
  return [
    `context ${context === null ? 'not measured yet' : contextPhrase(context)}; ${plural(records.length, 'compaction')}; ${pinCount} pinned`,
    ...(isPending ? [PENDING_TEXT] : []),
    `snapshots: ${dir ?? '(unset)'}`,
    ...(transcript === 'unreadable' ? ["the session's transcript could not be read here (the dim log line says why), so only the compactions the mod saw run are listed"] : []),
    ...(latest === undefined ? [] : [`latest: #${latest.n} (${latest.trigger}, ${howSeen(latest)}) at ${shortTime(latest.at)}: ${tokensOf(latest)} tokens, ${latest.dir}`]),
    `/${COMMAND} lost shows what it dropped; /${COMMAND} restore gives your prompts back to Claude.`,
  ].join('\n')
}

const countsOf = (r: CompactLensRecord): string =>
  `${r.promptsInSpan} prompts${r.promptsWeak === undefined ? '' : ` (${r.promptsWeak} barely in the summary)`}, ${r.filesInSpan} files${r.filesUnnamed === undefined ? '' : ` (${r.filesUnnamed} never named)`}, ${r.identifiersLost} details dropped`

const listLine = (r: CompactLensRecord, dir: string | null): string => {
  const files = compactionFiles(dir ?? '', r.n)
  if (r.trigger === 'unseen') return `  #${r.n} unseen, noticed ${shortTime(r.at)}: the mod did not see it run, so its summary alone is recorded; ${files.summary}`
  const counts = r.hasDetail === false ? `${howSeen(r)} (/${COMMAND} lost ${r.n} reads it)` : `${countsOf(r)}; ${howSeen(r)}`
  return `  #${r.n} ${r.trigger} ${shortTime(r.at)}: ${tokensOf(r)} tokens; ${counts}; ${files.dir}`
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

/** One compaction as the pane's picker draws it. */
export const pickerLabel = (r: CompactLensRecord): string =>
  r.trigger === 'unseen'
    ? `#${pad2(r.n)} unseen · noticed ${shortTime(r.at)} · summary only`
    : `#${pad2(r.n)} ${r.trigger} · ${shortTime(r.at)} · ${tokensOf(r)} tokens${r.source === 'transcript' ? ' · from the transcript' : ''}`

export const SHOW_KINDS = ['lost', 'after', 'summary', 'before', 'pinned'] as const
export type ShowKind = (typeof SHOW_KINDS)[number]
export type ShowRequest = { kind: ShowKind; n: number | undefined }

const isShowKind = (word: string): word is ShowKind => (SHOW_KINDS as readonly string[]).includes(word)
export const isNumberWord = (word: string): boolean => /^#?\d+$/.test(word)
export const numberOf = (word: string): number => Number(word.replace('#', ''))

/** `show [what] [n]`, in either order; the reason when the words are neither. */
export const parseShow = (tail: string): ShowRequest | string => {
  const words = tail.split(/\s+/).filter(word => word !== '')
  const kind = words.find(isShowKind)
  const number = words.find(isNumberWord)
  const other = words.find(word => word !== kind && word !== number)
  if (other !== undefined) return `show takes one of ${SHOW_KINDS.join(', ')} and a compaction number, as in /${COMMAND} show lost 2`
  return { kind: kind ?? 'lost', n: number === undefined ? undefined : numberOf(number) }
}

/** `restore [n] [prompts | words…]`: which compaction, and the words to search for (none: the prompts). */
export type RestoreRequest = { n: number | undefined; query: string }

export const parseRestore = (tail: string): RestoreRequest => {
  const words = tail.split(/\s+/).filter(word => word !== '')
  const first = words[0]
  const n = first !== undefined && isNumberWord(first) ? numberOf(first) : undefined
  const rest = (n === undefined ? words : words.slice(1)).join(' ').trim()
  return { n, query: rest === 'prompts' ? '' : rest }
}

/** A file printed as the command's reply: its path, then its text, cut at SHOW_CAP. */
export const formatShown = (path: string, text: string): string => `${path}\n\n${cut(text.trimEnd(), SHOW_CAP)}`

/** The toast after a look at the transcript found compactions the mod had not seen run. */
export const foundToast = (added: readonly CompactLensRecord[]): string => {
  const first = added[0]
  if (added.length === 1 && first !== undefined) return `compaction #${first.n} (${first.trigger}) ran without the mod's hook; it is recorded from the transcript. /${COMMAND} lost ${first.n} shows what it dropped`
  return `found ${added.length} earlier compactions in this session's transcript; /${COMMAND} shows what each one dropped`
}

/** The toast after a live compaction: what it dropped, in a line. */
export const compactedToast = (r: CompactLensRecord): string =>
  `compaction #${r.n}: ${tokensOf(r)} tokens; ${r.promptsInSpan} of your prompts${r.promptsWeak === undefined || r.promptsWeak === 0 ? '' : ` (${r.promptsWeak} barely kept)`}, ${r.filesUnnamed ?? r.filesInSpan} files and ${r.identifiersLost} details not in the summary. /${COMMAND} to review or restore`

export const RECALL_UNAVAILABLE = `the session's transcript cannot be read here (the mod reads it with grep and sed), so there is nothing to search; the lost report and before.md of each compaction the mod saw run are under its folder`

/** before.md of a compaction the mod did not see run, where the transcript could not be read. */
export const unseenBefore = (n: number, at: string): string =>
  [
    `# before — compaction #${n} (unseen), noticed at ${at}`,
    '',
    'compact-lens did not see this compaction run and could not read the session\'s transcript, so the',
    "transcript that went in was not saved here; the session's own transcript file (under ~/.claude/projects/)",
    'still holds it. summary.md holds its summary, and after.md the conversation from that summary on.',
    '',
  ].join('\n')

/** lost.md of a compaction the mod did not see run, where the transcript could not be read. */
export const unseenLost = (n: number, at: string): string =>
  [`# lost — compaction #${n} (unseen), noticed at ${at}`, '', 'Not computed: the mod did not see what went into this compaction. See before.md.', ''].join('\n')

/** Why an unseen compaction an earlier version numbered apart from the transcript is not read from it. */
export const UNPAIRED = (n: number): string =>
  `compaction #${n} was recorded by an earlier version of compact-lens, numbered apart from the transcript, so nothing is read from there into its folder; its files stay as they were`
