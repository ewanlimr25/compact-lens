// Editing the summary in the prompt box (pure): the header line, finding an edit in a submitted
// prompt, judging it, and the replies.
import { COMMAND, EDIT_DISTINCT_LINE_CHARS, EDIT_HEAD_PROBE_CHARS, EDIT_MIN_DISTINCT_LINES, pad2 } from './paths'

// The header's prefix, anything up to its closing bracket, and the end of its line: a trailing
// space, or an editor that wraps the line, still matches; a one-line prompt that only starts with
// the header does not.
const HEADER = /^\s*\[compact-lens edit #(\d+)[^\]]{0,300}\][ \t]*(?:\r?\n|$)/

/** The first line of the edit in the prompt box: which summary it is, and what Enter does. Short, so editors do not wrap it. */
export const editHeader = (n: number): string => `[compact-lens edit #${pad2(n)}: Enter applies this summary; an empty box cancels]`

export const buildEditDraft = (n: number, summary: string): string => `${editHeader(n)}\n${summary.trim()}`

export type EditSubmission = { n: number; body: string }

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

/** What becomes of a submitted edit: nothing when empty, kept aside when there is no summary or a newer one, else applied. */
export type EditVerdict = 'empty' | 'none' | 'stale' | 'apply'

export const judgeEdit = (edit: EditSubmission, latestN: number | undefined): EditVerdict =>
  edit.body === '' ? 'empty' : latestN === undefined ? 'none' : edit.n === latestN ? 'apply' : 'stale'

/** An ISO time as a file-name stamp, to the millisecond: 2026-10-07T13:53:42.706Z → 20261007-135342-706. */
export const fileStamp = (iso: string): string => iso.replace(/[-:]/g, '').replace('T', '-').replace('.', '-').slice(0, 19)

export type EditReplyArgs = {
  verdict: EditVerdict
  n: number
  latestN: number | undefined
  summaryPath: string
  keptPath: string
  isTurnRunning: boolean
}

const NOT_SENT = 'The prompt was not sent to the model.'

/** The line the person sees in place of the prompt, which never reaches the model. */
export const editReply = ({ verdict, n, latestN, summaryPath, keptPath, isTurnRunning }: EditReplyArgs): string => {
  switch (verdict) {
    case 'empty':
      return `compact-lens: the summary in the box was empty, so nothing was applied. ${NOT_SENT}`
    case 'none':
      return `compact-lens: no compaction has run in this session, so there is no summary to replace. Your text is kept at ${keptPath}. ${NOT_SENT}`
    case 'stale':
      return `compact-lens: that edit was of compaction #${pad2(n)}, but #${pad2(latestN ?? 0)} is the latest now, so it was not applied. Your text is kept at ${keptPath}; /${COMMAND} edit loads the current summary. ${NOT_SENT}`
    case 'apply':
      return `compact-lens: your edit is saved to ${summaryPath} and replaces the summary ${isTurnRunning ? 'when the running turn ends' : 'in a moment'}. ${NOT_SENT}`
  }
}

export const editStarted = (n: number): string =>
  `compact-lens: the summary of compaction #${pad2(n)} goes into the prompt box now. Edit it there, or press ctrl+g to edit it in your editor. Keep the first line: Enter then applies it. An empty box cancels.`
