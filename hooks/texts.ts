// The options, the command's help, the tools' descriptions and the toasts' fixed texts (pure).
import type { PluginOptions } from 'claude-code'

import type { CompactLensPin, CompactLensRecord } from '../types'
import { plural } from './notes'
import { COMMAND, compactionFiles } from './paths'

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

export const EDIT_STARTED_TOAST = 'compact-lens: the summary is in the prompt box; edit it there, keep the first line, and Enter applies it'

export const HELP = [
  `/${COMMAND}            open the pane and show the status`,
  `/${COMMAND} edit       put the summary in the prompt box to edit; Enter applies it`,
  `/${COMMAND} list       list the compactions, their folders and the pinned notes`,
  `/${COMMAND} keep <t>   pin a fact so it survives every compaction verbatim`,
  `/${COMMAND} unpin <n>  remove pinned note n`,
  `/${COMMAND} apply      replace the current summary with the edited summary.md`,
].join('\n')

export const ARGUMENT_HINT = '[edit | list | keep <text> | unpin <n> | apply]'

export const KEEP_DESCRIPTION =
  'Pin a fact so it survives every compaction of this session verbatim: a decision, a path, a number, a name, a rule. ' +
  "The note is put into the summariser's instructions and written, word for word, into the note that follows every summary. Keep each note short and self-contained."

export const APPLY_DESCRIPTION =
  'Replace the current compaction summary with the edited summary.md of the latest compaction (its path is in the note after the summary and in the Compact Lens section). ' +
  'Edit the file first with Edit, then call this; the replacement runs once this turn ends, with no summariser call. The transcript after the summary is kept as it is.'

export type StatusFields = { fill: number | null; records: readonly CompactLensRecord[]; pinCount: number; dir: string | null; isPending: boolean }

/** The command's status reply: the fill, the counts, the folder and the latest compaction. */
export const formatStatus = ({ fill, records, pinCount, dir, isPending }: StatusFields): string => {
  const latest = records.at(-1)
  const fillText = fill === null ? 'not measured yet' : `${fill}%`
  return [
    `compact-lens: context ${fillText}; ${plural(records.length, 'compaction')}; ${pinCount} pinned${isPending ? '; an apply is pending' : ''}`,
    `snapshots: ${dir ?? '(unset)'}`,
    ...(latest === undefined
      ? []
      : [`latest: #${latest.n} (${latest.trigger}) at ${latest.at}: ${latest.messagesBefore} → ${latest.messagesAfter} messages, ${latest.dir}`]),
  ].join('\n')
}

/** The command's list reply: every compaction with its folder and counts, then the pinned notes. */
export const formatList = (records: readonly CompactLensRecord[], pins: readonly CompactLensPin[], dir: string | null): string =>
  [
    `compactions (${records.length}):`,
    ...(records.length === 0 ? ['  none yet'] : []),
    ...records.map(r => {
      const files = compactionFiles(dir ?? '', r.n)
      return `  #${r.n} ${r.trigger} ${r.at}: ${r.messagesBefore} → ${r.messagesAfter} messages; ${files.before}; the span held ${r.promptsInSpan} prompts and ${r.filesInSpan} files; ${r.identifiersLost} identifiers no longer mentioned`
    }),
    `pinned (${pins.length}):`,
    ...(pins.length === 0 ? ['  none'] : pins.map(p => `  ${p.id}. ${p.text}`)),
  ].join('\n')
