// Editing the summary in the prompt box (pure): the header line, finding an edit in a submitted
// prompt, judging it, and the replies.
import type { PromptSubmitInput, PromptSubmitResult } from 'claude-code'

import type { CompactionFiles } from './paths'
import { COMMAND, COMPACT_COMMAND, EDIT_DISTINCT_LINE_CHARS, EDIT_HEAD_PROBE_CHARS, EDIT_MIN_DISTINCT_LINES, pad2 } from './paths'

// The header's prefix, anything up to its closing bracket, and the end of its line: a trailing
// space, or an editor that wraps the line, still matches; a one-line prompt that only starts with
// the header does not.
const HEADER = /^\s*\[compact-lens edit #(\d+)[^\]]{0,300}\][ \t]*(?:\r?\n|$)/

/** The first line of the edit in the prompt box: which summary it is, and what Enter does. Short, so editors do not wrap it. */
export const editHeader = (n: number): string => `[compact-lens edit #${pad2(n)}: Enter saves, ${COMPACT_COMMAND} applies, an empty box cancels]`

export const buildEditDraft = (n: number, summary: string): string => `${editHeader(n)}\n${summary.trim()}`

export type EditSubmission = { n: number; body: string }

/** The summary an edit opens on: its compaction's number, folder and text. */
export type CurrentSummary = { n: number; files: CompactionFiles; text: string }

/** A caught edit's outcome: the line the person sees, and whether an apply now waits. */
export type SavedEdit = { reply: string; isApply: boolean }

export type NextSubmit = (e: PromptSubmitInput) => Promise<PromptSubmitResult>

/** A prompt the person sent: typed at the terminal, or through Remote Control; never another plugin's or the SDK's. */
export const isPersonsOwn = (e: PromptSubmitInput): boolean => e.origin.kind === 'composer' || e.origin.kind === 'bridge'

/** The edit in a submitted prompt, found by its header line; undefined without one. */
export const parseEditHeader = (text: string): EditSubmission | undefined => {
  const match = HEADER.exec(text)
  return match === null ? undefined : { n: Number(match[1]), body: text.slice(match[0].length).trim() }
}

/** The summary's lines long enough to tell it from another session's: the headings and boilerplate every summary shares are shorter, or few. */
const distinctLines = (summary: string): string[] => [
  ...new Set(summary.split('\n').map(line => line.trim()).filter(line => line.length >= EDIT_DISTINCT_LINE_CHARS)),
]

/**
 * Whether a prompt without the header is the open edit of `summary`: it keeps at least half of the
 * summary's distinct lines word for word, or, for a summary too short to have them, starts with its opening.
 */
export const looksLikeEdit = (text: string, summary: string): boolean => {
  const lines = distinctLines(summary)
  if (lines.length < EDIT_MIN_DISTINCT_LINES) {
    const probe = summary.trim().slice(0, EDIT_HEAD_PROBE_CHARS)
    return probe !== '' && text.trimStart().startsWith(probe)
  }
  const sent = new Set(text.split('\n').map(line => line.trim()))
  return 2 * lines.filter(line => sent.has(line)).length >= lines.length
}

/**
 * What becomes of a submitted edit: nothing when empty or unchanged, kept aside when there is no
 * summary or a newer one, else saved for the apply. `current` is the summary.md the edit started from.
 */
export type EditVerdict = 'empty' | 'none' | 'stale' | 'unchanged' | 'apply'

export const judgeEdit = (edit: EditSubmission, latestN: number | undefined, current?: string): EditVerdict => {
  if (edit.body === '') return 'empty'
  if (latestN === undefined) return 'none'
  if (edit.n !== latestN) return 'stale'
  return current !== undefined && edit.body === current.trim() ? 'unchanged' : 'apply'
}

/** An ISO time as a file-name stamp, to the millisecond: 2026-10-07T13:53:42.706Z → 20261007-135342-706. */
export const fileStamp = (iso: string): string => iso.replace(/[-:]/g, '').replace('T', '-').replace('.', '-').slice(0, 19)

export type EditReplyArgs = {
  verdict: EditVerdict
  n: number
  latestN: number | undefined
  summaryPath: string
  keptPath: string
  isTurnRunning: boolean
  /** True when an unchanged edit dropped an apply that waited with other text. */
  isApplyDropped?: boolean
}

const NOT_SENT = 'The prompt was not sent to the model.'

/** The line the person sees in place of the prompt, which never reaches the model. */
export const editReply = ({ verdict, n, latestN, summaryPath, keptPath, isTurnRunning, isApplyDropped = false }: EditReplyArgs): string => {
  switch (verdict) {
    case 'empty':
      return `compact-lens: the summary in the box was empty, so nothing was applied. ${NOT_SENT}`
    case 'none':
      return `compact-lens: no compaction has run in this session, so there is no summary to replace. Your text is kept at ${keptPath}. ${NOT_SENT}`
    case 'stale':
      return `compact-lens: that edit was of compaction #${pad2(n)}, but #${pad2(latestN ?? 0)} is the latest now, so it was not applied. Your text is kept at ${keptPath}; /${COMMAND} edit loads the current summary. ${NOT_SENT}`
    case 'unchanged':
      return `compact-lens: the summary in the box is the one in use, so there is nothing to apply${isApplyDropped ? `; the apply that waited with other text is dropped, and ${summaryPath} holds the summary in use again` : ''}. ${NOT_SENT}`
    case 'apply':
      return `compact-lens: your edit is saved to ${summaryPath}. To apply it, press Enter on ${COMPACT_COMMAND} in the prompt box${isTurnRunning ? ' once the running turn has ended' : ''}: the mod answers that ${COMPACT_COMMAND} with your summary, so no summariser runs and the messages after the summary stay. ${NOT_SENT}`
  }
}

/** The command's reply; the engine prints it under the plugin's name. */
export const editStarted = (n: number): string =>
  `the summary of compaction #${pad2(n)} goes into the prompt box now. Edit it there, or press ctrl+g to edit it in your editor. Keep the first line. Enter saves it, then ${COMPACT_COMMAND} applies it with no summariser; an empty box cancels.`
