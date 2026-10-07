import type { CompactLensPin, CompactLensRecord } from '../types'
import type { CompactionFiles } from './paths'
import { APPLY_TOOL, COMMAND, KEEP_TOOL } from './paths'
import { estimateTokens, fmtTokens } from './snapshot'

/** The summariser's instruction for the pinned notes; undefined with none. */
export const buildPinnedDirective = (pins: readonly CompactLensPin[]): string | undefined =>
  pins.length === 0
    ? undefined
    : ['Keep these pinned facts in the summary, verbatim and complete:', ...pins.map(p => `- ${p.text}`)].join('\n')

export const mergeInstructions = (own: string | undefined, directive: string | undefined): string | undefined => {
  const joined = [own, directive].filter((part): part is string => part !== undefined && part.trim() !== '').join('\n\n')
  return joined === '' ? undefined : joined
}

const tokensIn = (record: CompactLensRecord): string =>
  record.tokensBefore === null ? `~${fmtTokens(estimateTokens(record.charsBefore))} tokens, estimated` : `${fmtTokens(record.tokensBefore)} tokens`

const tokensOut = (record: CompactLensRecord): string =>
  record.tokensAfter === null ? `~${fmtTokens(estimateTokens(record.charsAfter))} tokens, estimated` : `${fmtTokens(record.tokensAfter)} tokens`

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

const pinsBlock = (pins: readonly CompactLensPin[]): string[] =>
  pins.length === 0 ? [] : ['Pinned notes (kept verbatim through every compaction):', ...pins.map(p => `${p.id}. ${p.text}`)]

export type NoteArgs = { record: CompactLensRecord; files: CompactionFiles; pins: readonly CompactLensPin[]; keptCount: number }

/** The user-role message inserted after a summary: the counts, the files and the pinned notes. */
export const buildNote = ({ record, files, pins, keptCount }: NoteArgs): string =>
  [
    `<compact-lens n="${record.n}" trigger="${record.trigger}">`,
    `Compaction #${record.n} (${record.trigger}) ran at ${record.at}. ${record.messagesBefore} messages (${tokensIn(record)}) went in; the summary above and ${keptCount} kept message${keptCount === 1 ? '' : 's'} (${tokensOut(record)}) came out.`,
    'Files, written by compact-lens (read them with Read or search them with Grep when the summary lacks something):',
    `- before.md   ${files.before}   the whole transcript that was compacted, every tool call with its input and result`,
    `- lost.md     ${files.lost}   the span's ${plural(record.promptsInSpan, 'prompt')} verbatim and its ${plural(record.filesInSpan, 'file')}, and the ${plural(record.identifiersLost, 'identifier')} the context no longer mentions`,
    `- summary.md  ${files.summary}   the summary's text; edit it with Edit, then call ${APPLY_TOOL} to replace the summary above with it (after an apply, the newest folder's summary.md is the one to edit); the person can edit it in the prompt box with /${COMMAND} edit`,
    ...pinsBlock(pins),
    `Pin a fact for the next compaction with ${KEEP_TOOL}.`,
    '</compact-lens>',
  ].join('\n')

/** The user-role message inserted after an apply: what changed. */
export const buildApplyNote = (record: CompactLensRecord, files: CompactionFiles): string =>
  [
    `<compact-lens n="${record.n}" trigger="apply">`,
    `The summary above was replaced at ${record.at} with an edited summary.md. The next apply reads ${files.summary}; the earlier summaries and transcripts stay under their own folders.`,
    '</compact-lens>',
  ].join('\n')

export type WarningArgs = { percent: number; thresholdPercent: number | undefined; sessionDir: string }

/** The one hidden note the model gets when the context fill crosses the warning line. */
export const buildWarning = ({ percent, thresholdPercent, sessionDir }: WarningArgs): string =>
  [
    '<compact-lens>',
    `Context is at ${percent}% of the window${thresholdPercent === undefined ? '' : `; auto-compaction runs near ${thresholdPercent}%`}. When it compacts, the whole transcript is saved under ${sessionDir}/ and the summary comes with a note of what it dropped (before.md, lost.md, summary.md). If a detail must survive verbatim (a decision, a path, a number, a name), pin it now with ${KEEP_TOOL}.`,
    '</compact-lens>',
  ].join('\n')

export type SectionArgs = { sessionDir: string; records: readonly CompactLensRecord[]; pinnedCount: number }

/** The session-scoped system-prompt section: where the snapshots are and what the tools do. */
export const buildPromptSection = ({ sessionDir, records, pinnedCount }: SectionArgs): string => {
  const latest = records.at(-1)
  return [
    '# Compact Lens',
    `This session records every compaction under ${sessionDir}/<nn>/: before.md (the whole transcript that was compacted), lost.md (what the summary does not mention), summary.md (the summary's text, editable), after.md (what the context held right after). Compactions so far: ${records.length}${latest === undefined ? '' : `; latest: ${latest.dir} (${latest.trigger}, ${latest.at})`}. Pinned notes: ${pinnedCount}.`,
    `Tools: ${KEEP_TOOL} pins a fact so it survives every compaction verbatim; ${APPLY_TOOL} replaces the current summary with the edited summary.md once the turn ends. The person runs /${COMMAND} edit to edit the summary in the prompt box (Enter applies it), /${COMMAND} for the pane, /${COMMAND} apply, /${COMMAND} keep <text>.`,
  ].join('\n')
}

export const renderPinned = (pins: readonly CompactLensPin[]): string =>
  ['# pinned notes', '', ...(pins.length === 0 ? ['(none)'] : pins.map(p => `${p.id}. ${p.text}  (${p.at})`)), ''].join('\n')
