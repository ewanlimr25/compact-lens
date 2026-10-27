// The texts the model reads (pure): the note after a summary, the warning ahead of a compaction, the
// system-prompt section, and the pinned notes' directive for the summariser.
import type { CompactLensContext, CompactLensPin, CompactLensRecord } from '../types'
import type { CompactionFiles } from './paths'
import { APPLY_TOOL, COMMAND, COMPACT_COMMAND, KEEP_TOOL, RECALL_TOOL } from './paths'
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

/** What the span held that the summary may not: the counts the lost report gives. */
const droppedLine = (record: CompactLensRecord): string => {
  const weak = record.promptsWeak === undefined || record.promptsInSpan === 0 ? '' : ` (${record.promptsWeak} barely in the summary)`
  const unnamed = record.filesUnnamed === undefined ? '' : ` (${record.filesUnnamed} never named again)`
  return `The summary is lossy: the span held ${record.promptsInSpan} of the person's prompts${weak}, ${plural(record.filesInSpan, 'file')}${unnamed} and ${plural(record.identifiersLost, 'identifier')} the context no longer mentions.`
}

export type NoteArgs = { record: CompactLensRecord; files: CompactionFiles; pins: readonly CompactLensPin[]; keptCount: number }

/** The user-role message inserted after a summary: the counts, how to get a detail back, the files and the pinned notes. */
export const buildNote = ({ record, files, pins, keptCount }: NoteArgs): string =>
  [
    `<compact-lens n="${record.n}" trigger="${record.trigger}">`,
    `Compaction #${record.n} (${record.trigger}) ran at ${record.at}. ${record.messagesBefore} messages (${tokensIn(record)}) went in; the summary above and ${plural(keptCount, 'kept message')} (${tokensOut(record)}) came out. ${droppedLine(record)}`,
    `To get an exact detail back (a path, a number, a decision, the person's words), call ${RECALL_TOOL} with words to search for: it returns the matching passages of the compacted transcript verbatim. Files written by compact-lens (read them with Read, search them with Grep):`,
    `- before.md   ${files.before}   the whole transcript that was compacted, every tool call with its input and result`,
    `- lost.md     ${files.lost}   what the summary dropped: the person's prompts verbatim, the files, the identifiers`,
    `- summary.md  ${files.summary}   the summary's text; edit it with Edit, then call ${APPLY_TOOL} and ask the person to press Enter on ${COMPACT_COMMAND}, which the mod answers with the edited text in place of the summary above (after an apply, the newest folder's summary.md is the one to edit); the person can edit it in the prompt box with /${COMMAND} edit`,
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

/** How far along the context is, as a whole percent: of the way to auto-compaction when that is known, else of the window. */
export const progressPercent = (context: CompactLensContext): number => {
  const base = context.threshold ?? context.window
  return base <= 0 ? 0 : Math.round((100 * context.tokens) / base)
}

/** The context in a few words: `412k of 470k before auto-compaction (88%)`, or of the window when the line is not known. */
export const contextPhrase = (context: CompactLensContext): string =>
  context.threshold === null
    ? `${fmtTokens(context.tokens)} of a ${fmtTokens(context.window)} window (${progressPercent(context)}%)`
    : `${fmtTokens(context.tokens)} of ${fmtTokens(context.threshold)} before auto-compaction (${progressPercent(context)}%)`

export type WarningArgs = { context: CompactLensContext; sessionDir: string }

/** The one hidden note the model gets when the context crosses the warning line. */
export const buildWarning = ({ context, sessionDir }: WarningArgs): string =>
  [
    '<compact-lens>',
    `Context is at ${contextPhrase(context)}. When it compacts, the summary will be lossy; compact-lens saves the whole transcript under ${sessionDir}/ and lists what the summary dropped (before.md, lost.md, summary.md), and ${RECALL_TOOL} finds an exact detail again. If a detail must survive verbatim (a decision, a path, a number, a name), pin it now with ${KEEP_TOOL}.`,
    '</compact-lens>',
  ].join('\n')

export type SectionArgs = { sessionDir: string; records: readonly CompactLensRecord[]; pinnedCount: number }

/** The session-scoped system-prompt section: where the snapshots are, how to get a detail back, what the tools do. */
export const buildPromptSection = ({ sessionDir, records, pinnedCount }: SectionArgs): string => {
  const latest = records.at(-1)
  return [
    '# Compact Lens',
    `This session records every compaction under ${sessionDir}/<nn>/: before.md (the whole transcript that was compacted), lost.md (what the summary dropped), summary.md (the summary's text, editable), after.md (what the context held right after). Compactions so far: ${records.length}${latest === undefined ? '' : `; latest: ${latest.dir} (${latest.trigger}, ${latest.at})`}. Pinned notes: ${pinnedCount}.`,
    `When you need a detail from before a compaction (an exact path, number, decision, or the person's own words) and the summary lacks it, call ${RECALL_TOOL} with words to search for: it searches the session's transcript before the summary and returns the matching passages verbatim. ${KEEP_TOOL} pins a fact so it survives every compaction verbatim; ${APPLY_TOOL} readies the edited summary.md, and the person's next ${COMPACT_COMMAND} puts it in place of the current summary (the mod answers that ${COMPACT_COMMAND}; no summariser runs). The person runs /${COMMAND} to see what each compaction dropped and restore it, /${COMMAND} edit to edit the summary in the prompt box, /${COMMAND} keep <text> to pin.`,
  ].join('\n')
}

export const renderPinned = (pins: readonly CompactLensPin[]): string =>
  ['# pinned notes', '', ...(pins.length === 0 ? ['(none)'] : pins.map(p => `${p.id}. ${p.text}  (${p.at})`)), ''].join('\n')
