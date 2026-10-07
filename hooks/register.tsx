// The hooks module. Every call on `$` lives in this file (the engine's validator follows `$`
// only into functions declared here); the pure parts are in the sibling modules.
import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  PluginOptions,
  Register,
  RenderInput,
  SessionCompactInput,
  SessionCompactResult,
  SessionMessage,
  Timer,
} from 'claude-code'

import type { CompactLensPin, CompactLensRecord } from '../types'
import { computeLost, renderLost } from './lost'
import type { LostReport } from './lost'
import {
  buildApplyNote,
  buildNote,
  buildPinnedDirective,
  buildPromptSection,
  buildWarning,
  mergeInstructions,
  renderPinned,
} from './notes'
import {
  APPLY_DELAY_MS,
  APPLY_RETRIES,
  COMMAND,
  compactionFiles,
  draftFile,
  KEEP_TOOL,
  lensRoot,
  pad2,
  PANE_ID,
  pinnedFile,
  sessionDirOf,
  SUMMARY_HEAD_CHARS,
} from './paths'
import type { CompactionFiles } from './paths'
import { contextText, estimateTokens, findSummaryIndex, fmtTokens, renderTranscript, toJson, transcriptChars } from './snapshot'

// ---------------------------------------------------------------- state (declared here: the validator reads atoms in this file alone)

const EMPTY_RECORDS: CompactLensRecord[] = []
const EMPTY_PINS: CompactLensPin[] = []
const NO_NUMBER: number | null = null
const NO_TEXT: string | null = null

const recordsAtom = atom({ plugin: 'compact-lens', key: 'compactions' } as const, EMPTY_RECORDS)
const pinsAtom = atom({ plugin: 'compact-lens', key: 'pinned' } as const, EMPTY_PINS)
const warnedAtAtom = atom({ plugin: 'compact-lens', key: 'warnedAt' } as const, NO_NUMBER)
const pendingApplyAtom = atom({ plugin: 'compact-lens', key: 'pendingApply' } as const, false)
const sessionDirAtom = atom({ plugin: 'compact-lens', key: 'sessionDir' } as const, NO_TEXT)
const fillAtom = atom({ plugin: 'compact-lens', key: 'fill' } as const, NO_NUMBER)
const draftAtom = atom({ plugin: 'compact-lens', key: 'draft' } as const, NO_TEXT)

// ---------------------------------------------------------------- config and small helpers

type Config = { warnAtPercent: number; dir: string; openPane: boolean; statusLine: boolean }

const DEFAULT_WARN_AT = 70
const SHOWN_RECORDS = 10

const readConfig = (options: PluginOptions): Config => ({
  warnAtPercent: typeof options.warnAtPercent === 'number' ? options.warnAtPercent : DEFAULT_WARN_AT,
  dir: typeof options.dir === 'string' ? options.dir : '',
  openPane: options.openPane === true,
  statusLine: options.statusLine !== false,
})

const log = ($: EngineInterface, line: string): void => $.ui.log(`compact-lens: ${line}`)

const isoNow = async ($: EngineInterface): Promise<string> => new Date(await $.clock.now()).toISOString()

const userMessage = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })

const replaceAt = (messages: readonly SessionMessage[], index: number, message: SessionMessage): SessionMessage[] =>
  messages.map((one, i) => (i === index ? message : one))

const insertAfter = (messages: readonly SessionMessage[], index: number, message: SessionMessage): SessionMessage[] => [
  ...messages.slice(0, index + 1),
  message,
  ...messages.slice(index + 1),
]

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

// ---------------------------------------------------------------- the store mirror

const storeKey = (sessionId: string): string => `session:${sessionId}`

/** Mirrors the session's pins and records to the store, so a resumed session finds them. */
const persist = async ($: EngineInterface): Promise<void> => {
  const id = await $.session.id()
  const [pinned, compactions] = await Promise.all([read($, pinsAtom), read($, recordsAtom)])
  await $.store.set(storeKey(id), { pinned, compactions })
}

type Held = { pinned?: unknown; compactions?: unknown }

/** Fills empty state from the store: a resumed session in a new process. */
const restore = async ($: EngineInterface): Promise<void> => {
  const held = await $.store.get(storeKey(await $.session.id()))
  if (held === undefined || held === null || typeof held !== 'object') return
  const { pinned, compactions } = held as Held
  if (Array.isArray(compactions) && compactions.length > 0 && (await read($, recordsAtom)).length === 0) {
    await update($, recordsAtom, () => compactions as CompactLensRecord[])
  }
  if (Array.isArray(pinned) && pinned.length > 0 && (await read($, pinsAtom)).length === 0) {
    await update($, pinsAtom, () => pinned as CompactLensPin[])
  }
}

// ---------------------------------------------------------------- pinned notes

const mirrorPins = async ($: EngineInterface, pins: readonly CompactLensPin[]): Promise<void> => {
  const dir = await read($, sessionDirAtom)
  if (dir !== null) await $.fs.write(pinnedFile(dir), renderPinned(pins))
  await persist($)
}

const pin = async ($: EngineInterface, text: string): Promise<{ id: number; count: number }> => {
  const at = await isoNow($)
  const pins = await update($, pinsAtom, list => [...list, { id: (list.at(-1)?.id ?? 0) + 1, text, at }])
  await mirrorPins($, pins)
  return { id: pins.at(-1)?.id ?? 0, count: pins.length }
}

const unpin = async ($: EngineInterface, id: number): Promise<boolean> => {
  const before = await read($, pinsAtom)
  if (!before.some(p => p.id === id)) return false
  const pins = await update($, pinsAtom, list => list.filter(p => p.id !== id))
  await mirrorPins($, pins)
  return true
}

// ---------------------------------------------------------------- the apply of an edited summary

const requestApply = async ($: EngineInterface): Promise<void> => {
  await update($, pendingApplyAtom, () => true)
}

type ApplyOutcome = { kind: 'applied' | 'skipped' | 'refused'; text: string }

// The one apply in flight and the one timer waiting, whichever route asked; a reload drops both.
let applying: Promise<ApplyOutcome> | undefined
let applyTimer: Timer | undefined

const cancelApplyTimer = (): void => {
  applyTimer?.cancel()
  applyTimer = undefined
}

/**
 * Runs the pending apply: a plugin-triggered compaction our own hook answers. The engine refuses
 * it from a hook that holds the turn (a command, a tool call) and allows it from `turn.complete`.
 * Two routes asking at once share one run, so a second dispatch never reaches the summariser.
 */
const applyNow = ($: EngineInterface): Promise<ApplyOutcome> => {
  if (applying !== undefined) return applying
  cancelApplyTimer()
  const run = async (): Promise<ApplyOutcome> => {
    try {
      const ran = await $.session.compact()
      return ran.skip === undefined
        ? { kind: 'applied', text: 'the summary was replaced from summary.md' }
        : { kind: 'skipped', text: `not applied: ${ran.skip}` }
    } catch (error) {
      return { kind: 'refused', text: `could not run now (${String(error)})` }
    } finally {
      applying = undefined
    }
  }
  applying = run()
  return applying
}

/** Tries the pending apply from a timer of its own, again while the engine refuses it: the command's and the pane's way. */
const scheduleApply = ($: EngineInterface, attempt = 0): void => {
  cancelApplyTimer()
  applyTimer = $.clock.after(APPLY_DELAY_MS, () => {
    applyTimer = undefined
    void (async () => {
      if (!(await read($, pendingApplyAtom))) return
      const outcome = await applyNow($)
      if (outcome.kind === 'refused' && attempt < APPLY_RETRIES) {
        scheduleApply($, attempt + 1)
        return
      }
      log($, `apply: ${outcome.text}${outcome.kind === 'refused' ? '; it runs when the next turn ends' : ''}`)
      $.ui.toast(`compact-lens: ${outcome.text}`)
    })()
  })
}

// ---------------------------------------------------------------- the fill, the status line, the warning

const refreshStatus = async ($: EngineInterface, config: Config): Promise<void> => {
  if (!config.statusLine) {
    $.ui.status(undefined)
    return
  }
  const [fill, records, pins] = await Promise.all([read($, fillAtom), read($, recordsAtom), read($, pinsAtom)])
  $.ui.status(`compact-lens: ${fill === null ? '–' : `${fill}%`} · ${plural(records.length, 'compaction')} · ${pins.length} pinned`)
}

/** The context fill as a percent of the window, from the free usage call; undefined before the first response. */
const readFill = async ($: EngineInterface): Promise<number | undefined> => {
  const { context } = await $.session.usage()
  const percent =
    context.percent ??
    (context.tokens === undefined || context.window <= 0 ? undefined : Math.round((100 * context.tokens) / context.window))
  if (percent === undefined) return undefined
  await update($, fillAtom, () => percent)
  return percent
}

type WarningFigures = { percent: number; thresholdPercent: number | undefined }

/**
 * The fill and the auto-compaction line on one base: the breakdown's compaction window when the
 * engine answers one (it may be smaller than the model's window), else the plain fill alone.
 */
const warningFigures = async ($: EngineInterface, percent: number): Promise<WarningFigures> => {
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    const breakdown = context.breakdown
    if (breakdown === undefined || breakdown.autoCompactThreshold === undefined || breakdown.rawMaxTokens <= 0) {
      return { percent, thresholdPercent: undefined }
    }
    return {
      percent: Math.round(breakdown.percentage),
      thresholdPercent: Math.round((100 * breakdown.autoCompactThreshold) / breakdown.rawMaxTokens),
    }
  } catch {
    return { percent, thresholdPercent: undefined }
  }
}

/** After a main-loop model step: the fill, the status line, and the one warning per window. */
const afterStep = async ($: EngineInterface, config: Config): Promise<void> => {
  const percent = await readFill($)
  await refreshStatus($, config)
  if (percent === undefined || config.warnAtPercent <= 0 || percent < config.warnAtPercent) return
  if ((await read($, warnedAtAtom)) !== null) return
  await update($, warnedAtAtom, () => percent)
  const sessionDir = (await read($, sessionDirAtom)) ?? '(unset)'
  const figures = await warningFigures($, percent)
  const text = buildWarning({ ...figures, sessionDir })
  const failure = await appendNote($, text)
  if (failure !== undefined) {
    log($, `the warning note was not appended (${failure}); it is tried again at the next step`)
    await update($, warnedAtAtom, () => null)
    return
  }
  $.ui.toast(`compact-lens: context at ${figures.percent}%; the model was told where the snapshots go`)
}

/** Appends a hidden user-role note; the reason when it could not be. */
const appendNote = async ($: EngineInterface, text: string): Promise<string | undefined> => {
  try {
    const appended = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
    return appended.deny
  } catch (error) {
    return String(error)
  }
}

// ---------------------------------------------------------------- compaction

type NextCompact = (e: SessionCompactInput) => Promise<SessionCompactResult>

type RecordArgs = {
  n: number
  trigger: CompactLensRecord['trigger']
  at: string
  files: CompactionFiles
  before: readonly SessionMessage[]
  after: readonly SessionMessage[]
  summary: string
  lost: LostReport
  tokensBefore?: number
  tokensAfter?: number
}

const buildRecord = (args: RecordArgs): CompactLensRecord => ({
  n: args.n,
  trigger: args.trigger,
  at: args.at,
  dir: args.files.dir,
  messagesBefore: args.before.length,
  messagesAfter: args.after.length,
  charsBefore: transcriptChars(args.before),
  charsAfter: transcriptChars(args.after),
  tokensBefore: args.tokensBefore ?? null,
  tokensAfter: args.tokensAfter ?? null,
  summaryHead: args.summary.slice(0, SUMMARY_HEAD_CHARS),
  promptsInSpan: args.lost.prompts.length,
  filesInSpan: args.lost.filesEdited.length + args.lost.filesRead.length,
  identifiersLost: args.lost.identifiersLostTotal,
})

const writeRecord = async (
  $: EngineInterface,
  record: CompactLensRecord,
  files: CompactionFiles,
  after: readonly SessionMessage[],
): Promise<void> => {
  const title = `after — compaction #${record.n} (${record.trigger}) at ${record.at}`
  await $.fs.write(files.after, renderTranscript(after, { title, lines: [`${after.length} messages; what the context held right after the compaction.`] }))
  await $.fs.write(files.meta, JSON.stringify(record, null, 2))
  await update($, recordsAtom, list => [...list, record])
  if (record.trigger !== 'apply') {
    await update($, warnedAtAtom, () => null)
    await update($, fillAtom, () => null)
  }
  await persist($)
}

/** The draft the person edited, if draft.md differs from what the mod wrote there; undefined otherwise. */
const readEditedDraft = async ($: EngineInterface, dir: string, remembered: string): Promise<string | undefined> => {
  const path = draftFile(dir)
  if (!(await $.fs.exists(path))) return undefined
  const edited = (await $.fs.read(path)).trim()
  return edited !== '' && edited !== remembered.trim() ? edited : undefined
}

const clearDraft = async ($: EngineInterface, dir: string): Promise<void> => {
  if ((await read($, draftAtom)) === null) return
  await $.fs.write(draftFile(dir), '')
  await update($, draftAtom, () => null)
}

/**
 * The person's edited draft, to use as the summary when the engine reused the draft it was edited
 * from; an edit the engine passed over is kept beside the record, never wiped.
 */
const takeEditedDraft = async ($: EngineInterface, dir: string, files: CompactionFiles, engineText: string): Promise<string | undefined> => {
  const remembered = await read($, draftAtom)
  if (remembered === null) return undefined
  const edited = await readEditedDraft($, dir, remembered)
  await clearDraft($, dir)
  if (edited === undefined) return undefined
  if (engineText.trim() === remembered.trim()) return edited
  const kept = `${files.dir}/draft-unused.md`
  await $.fs.write(kept, edited)
  log($, `draft.md was edited, but the engine's summary moved on; the edit is kept at ${kept}`)
  return undefined
}

const snapshotBefore = async ($: EngineInterface, messages: readonly SessionMessage[], files: CompactionFiles, title: string, line: string): Promise<void> => {
  await $.fs.write(files.before, renderTranscript(messages, { title, lines: [line] }))
  await $.fs.write(files.beforeJson, toJson(messages))
}

type RecordCompactionArgs = {
  n: number
  trigger: CompactLensRecord['trigger']
  at: string
  files: CompactionFiles
  before: readonly SessionMessage[]
  withSummary: readonly SessionMessage[]
  summaryIndex: number
  pins: readonly CompactLensPin[]
  tokensBefore?: number
  tokensAfter?: number
}

/** The summary, the lost report, the record and the note: what every real compaction leaves. */
const recordCompaction = async ($: EngineInterface, args: RecordCompactionArgs): Promise<SessionMessage[]> => {
  const { n, trigger, at, files, before, withSummary, summaryIndex, pins } = args
  const summary = withSummary[summaryIndex] ?? userMessage('')
  const lost = computeLost(before, contextText(withSummary))
  const record = buildRecord({ n, trigger, at, files, before, after: withSummary, summary: summary.text, lost, tokensBefore: args.tokensBefore, tokensAfter: args.tokensAfter })
  await $.fs.write(files.summary, summary.text)
  await $.fs.write(files.lost, renderLost(lost, { n, trigger, at, beforePath: files.before }))
  const note = userMessage(buildNote({ record, files, pins, keptCount: withSummary.length - 1 }))
  const messages = insertAfter(withSummary, summaryIndex, note)
  await writeRecord($, record, files, messages)
  return messages
}

/** A real compaction: snapshot what goes in, let the engine summarise, snapshot what comes out, insert the note. */
const handleReal = async ($: EngineInterface, e: SessionCompactInput, next: NextCompact, dir: string): Promise<SessionCompactResult> => {
  const [records, pins] = await Promise.all([read($, recordsAtom), read($, pinsAtom)])
  const n = records.length + 1
  const files = compactionFiles(dir, n)
  const at = await isoNow($)
  const trigger = e.trigger === 'precompute' ? 'auto' : e.trigger
  const beforeLine = `${e.messages.length} messages, ${transcriptChars(e.messages)} characters; the whole transcript the engine compacted.`
  await snapshotBefore($, e.messages, files, `before — compaction #${n} (${trigger}) at ${at}`, beforeLine)

  const instructions = mergeInstructions(e.instructions, buildPinnedDirective(pins))
  const result = await next(instructions === undefined ? e : { ...e, instructions })
  if (result.skip !== undefined) {
    log($, `compaction #${n} skipped: ${result.skip}`)
    return result
  }
  const summaryIndex = findSummaryIndex(result.messages)
  if (summaryIndex < 0) {
    log($, `compaction #${n}: no summary message found in the result; nothing recorded beyond ${files.before}`)
    return result
  }
  const engineSummary = result.messages[summaryIndex] ?? userMessage('')
  const edited = await takeEditedDraft($, dir, files, engineSummary.text)
  const withSummary = replaceAt(result.messages, summaryIndex, edited === undefined ? engineSummary : userMessage(edited))
  const messages = await recordCompaction($, { n, trigger, at, files, before: e.messages, withSummary, summaryIndex, pins, tokensBefore: result.tokensBefore, tokensAfter: result.tokensAfter })

  const draftNote = edited === undefined ? '' : ', the edited draft.md used as the summary'
  log($, `compaction #${n} (${trigger}): ${e.messages.length} → ${messages.length} messages${draftNote}; snapshots in ${files.dir}`)
  $.ui.toast(`compact-lens: compaction #${n} recorded in ${files.dir}`)
  return { ...result, messages }
}

/** A precomputed summary: keep its draft on disk so it can be read, or edited, before the compaction lands. */
const handlePrecompute = async ($: EngineInterface, e: SessionCompactInput, next: NextCompact, dir: string): Promise<SessionCompactResult> => {
  const result = await next(e)
  if (result.skip !== undefined) return result
  const index = findSummaryIndex(result.messages)
  const text = result.messages[index]?.text
  if (index < 0 || text === undefined) return result
  const remembered = await read($, draftAtom)
  const inProgress = remembered === null ? undefined : await readEditedDraft($, dir, remembered)
  if (inProgress !== undefined) {
    log($, `a summary was precomputed again, but ${draftFile(dir)} holds an edit; it was left as it is`)
    return result
  }
  await $.fs.write(draftFile(dir), text)
  await update($, draftAtom, () => text)
  log($, `a summary was precomputed ahead of the compaction; its draft is at ${draftFile(dir)}`)
  return result
}

/** An apply: the edited summary.md replaces the current summary; no summariser runs. */
const handleApply = async ($: EngineInterface, e: SessionCompactInput, dir: string): Promise<SessionCompactResult> => {
  await update($, pendingApplyAtom, () => false)
  const records = await read($, recordsAtom)
  const latest = records.at(-1)
  if (latest === undefined) return { skip: 'compact-lens: nothing to apply, no compaction has run yet' }
  const current = compactionFiles(dir, latest.n)
  if (!(await $.fs.exists(current.summary))) return { skip: `compact-lens: ${current.summary} is missing` }
  const edited = (await $.fs.read(current.summary)).trim()
  if (edited === '') return { skip: `compact-lens: ${current.summary} is empty` }
  const index = e.messages.findIndex(m => m.role === 'user' && m.text.startsWith(latest.summaryHead))
  if (index < 0) return { skip: 'compact-lens: the current summary was not found in the transcript' }
  const old = e.messages[index] ?? userMessage('')
  if (old.text.trim() === edited) return { skip: `compact-lens: ${current.summary} is unchanged` }

  const n = records.length + 1
  const files = compactionFiles(dir, n)
  const at = await isoNow($)
  const withSummary = replaceAt(e.messages, index, userMessage(edited))
  const lost = computeLost([old], contextText(withSummary))
  const record = buildRecord({ n, trigger: 'apply', at, files, before: e.messages, after: withSummary, summary: edited, lost })
  await snapshotBefore($, e.messages, files, `before — apply #${n} at ${at}`, 'The transcript as it stood when the edited summary replaced the summary.')
  await $.fs.write(files.summary, edited)
  await $.fs.write(files.lost, renderLost(lost, { n, trigger: 'apply', at, beforePath: current.summary }))
  const messages = insertAfter(withSummary, index, userMessage(buildApplyNote(record, files)))
  await writeRecord($, record, files, messages)
  log($, `apply #${n}: the summary was replaced from ${current.summary}; snapshots in ${files.dir}`)
  return { messages }
}

/** The session.compact hook: the engine's own compactions are recorded, an apply is answered by the mod. */
const handleCompact = async ($: EngineInterface, e: SessionCompactInput, next: NextCompact): Promise<SessionCompactResult> => {
  if (e.agentId !== undefined) return next(e)
  if (!Array.isArray(e.messages)) {
    log($, `a compaction arrived without its messages (trigger ${String(e.trigger)}); passed through`)
    return next(e)
  }
  const dir = await read($, sessionDirAtom)
  if (dir === null) return next(e)
  if (e.trigger === 'precompute') return handlePrecompute($, e, next, dir)
  if (e.trigger === 'plugin' && (await read($, pendingApplyAtom))) return handleApply($, e, dir)
  return handleReal($, e, next, dir)
}

// ---------------------------------------------------------------- the slash command

const HELP = [
  `/${COMMAND}            open the pane and show the status`,
  `/${COMMAND} list       list the compactions, their folders and the pinned notes`,
  `/${COMMAND} keep <t>   pin a fact so it survives every compaction verbatim`,
  `/${COMMAND} unpin <n>  remove pinned note n`,
  `/${COMMAND} apply      replace the current summary with the edited summary.md`,
].join('\n')

const statusText = async ($: EngineInterface): Promise<string> => {
  const [fill, records, pins, dir, pending] = await Promise.all([
    read($, fillAtom),
    read($, recordsAtom),
    read($, pinsAtom),
    read($, sessionDirAtom),
    read($, pendingApplyAtom),
  ])
  const latest = records.at(-1)
  const fillText = fill === null ? 'not measured yet' : `${fill}%`
  return [
    `compact-lens: context ${fillText}; ${plural(records.length, 'compaction')}; ${pins.length} pinned${pending ? '; an apply is pending' : ''}`,
    `snapshots: ${dir ?? '(unset)'}`,
    ...(latest === undefined
      ? []
      : [`latest: #${latest.n} (${latest.trigger}) at ${latest.at}: ${latest.messagesBefore} → ${latest.messagesAfter} messages, ${latest.dir}`]),
  ].join('\n')
}

const listText = async ($: EngineInterface): Promise<string> => {
  const [records, pins, dir] = await Promise.all([read($, recordsAtom), read($, pinsAtom), read($, sessionDirAtom)])
  return [
    `compactions (${records.length}):`,
    ...(records.length === 0 ? ['  none yet'] : []),
    ...records.map(r => {
      const files = compactionFiles(dir ?? '', r.n)
      return `  #${r.n} ${r.trigger} ${r.at}: ${r.messagesBefore} → ${r.messagesAfter} messages; ${files.before}; the span held ${r.promptsInSpan} prompts and ${r.filesInSpan} files; ${r.identifiersLost} identifiers no longer mentioned`
    }),
    `pinned (${pins.length}):`,
    ...(pins.length === 0 ? ['  none'] : pins.map(p => `  ${p.id}. ${p.text}`)),
  ].join('\n')
}

/** `/compact-lens [verb] [rest]`: the person's side of the mod. */
const runCommand = async ($: EngineInterface, args: string): Promise<{ text: string }> => {
  const trimmed = args.trim()
  const verb = trimmed.split(/\s+/)[0] ?? ''
  const tail = trimmed.slice(verb.length).trim()

  switch (verb) {
    case '':
    case 'open':
    case 'status': {
      await $.ui.open({ id: PANE_ID, title: 'Compact Lens', focus: true })
      return { text: await statusText($) }
    }
    case 'list':
      return { text: await listText($) }
    case 'keep':
    case 'pin': {
      if (tail === '') return { text: `compact-lens: keep needs a note: /${COMMAND} keep <text>` }
      const { id, count } = await pin($, tail)
      return { text: `compact-lens: pinned note ${id} (${count} pinned). It is kept verbatim through every compaction of this session.` }
    }
    case 'unpin': {
      const id = Number(tail)
      if (!Number.isInteger(id)) return { text: `compact-lens: unpin needs a number: /${COMMAND} unpin <n>` }
      return { text: (await unpin($, id)) ? `compact-lens: note ${id} removed.` : `compact-lens: no pinned note ${id}.` }
    }
    case 'apply': {
      await requestApply($)
      scheduleApply($)
      return { text: 'compact-lens: the edited summary.md replaces the summary in a moment, or when the running turn ends.' }
    }
    default:
      return { text: HELP }
  }
}

// ---------------------------------------------------------------- the pane

const tokensOf = (record: CompactLensRecord): string => {
  const before = record.tokensBefore ?? estimateTokens(record.charsBefore)
  const after = record.tokensAfter ?? estimateTokens(record.charsAfter)
  return `${fmtTokens(before)} → ${fmtTokens(after)}`
}

const applyFromPane = async ($: EngineInterface): Promise<void> => {
  await requestApply($)
  scheduleApply($)
  $.ui.toast('compact-lens: the edited summary.md replaces the summary in a moment, or when the running turn ends')
}

/** The pane: the fill, the compactions, the pinned notes and the two actions. */
const renderPane = async ($: EngineInterface, e: RenderInput<'Pane'>) => {
  const { Box, Text, Button } = $.ui.resolve(e)
  const [records, pins, fill, dir, pending] = await Promise.all([
    read($, recordsAtom),
    read($, pinsAtom),
    read($, fillAtom),
    read($, sessionDirAtom),
    read($, pendingApplyAtom),
  ])
  const shown = records.slice(-SHOWN_RECORDS)

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold>Compact Lens</Text>
        <Text dimColor>
          context {fill === null ? '–' : `${fill}%`} · {plural(records.length, 'compaction')} · {pins.length} pinned
          {pending ? ' · apply pending' : ''}
        </Text>
        <Text dimColor wrap="truncate-start">
          {dir ?? '(unset)'}
        </Text>
      </Box>
      <Box flexDirection="column">
        <Text bold>Compactions</Text>
        {shown.length === 0 && <Text dimColor>none yet</Text>}
        {shown.map(r => (
          <Text wrap="truncate-end">
            #{pad2(r.n)} {r.trigger} {r.at.slice(11, 19)} {r.messagesBefore}→{r.messagesAfter} msgs {tokensOf(r)} {r.dir}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column">
        <Text bold>Pinned</Text>
        {pins.length === 0 && <Text dimColor>none; the model pins with {KEEP_TOOL}, you with /{COMMAND} keep</Text>}
        {pins.map(p => (
          <Text wrap="wrap">
            {p.id}. {p.text}
          </Text>
        ))}
      </Box>
      <Box gap={1}>
        <Button key="apply" label="Apply summary.md" hotkey="a" onPress={() => void applyFromPane($)} />
        <Button key="refresh" label="Refresh" hotkey="r" onPress={() => void readFill($)} />
        <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE_ID })} />
      </Box>
    </Box>
  )
}

// ---------------------------------------------------------------- registration

const KEEP_DESCRIPTION =
  'Pin a fact so it survives every compaction of this session verbatim: a decision, a path, a number, a name, a rule. ' +
  "The note is put into the summariser's instructions and written, word for word, into the note that follows every summary. Keep each note short and self-contained."

const APPLY_DESCRIPTION =
  'Replace the current compaction summary with the edited summary.md of the latest compaction (its path is in the note after the summary and in the Compact Lens section). ' +
  'Edit the file first with Edit, then call this; the replacement runs once this turn ends, with no summariser call. The transcript after the summary is kept as it is.'

export const register: Register = (on, options) => {
  const config = readConfig(options)

  on('session.start', async ($, e, next) => {
    const home = (await $.env.get('HOME')) ?? ''
    const dir = sessionDirOf(lensRoot(home, config.dir), await $.session.id())
    await update($, sessionDirAtom, () => dir)
    await restore($)
    await $.tool.register({
      name: 'keep',
      description: KEEP_DESCRIPTION,
      inputSchema: { type: 'object', properties: { note: { type: 'string', description: 'The fact to keep, verbatim.' } }, required: ['note'] },
    })
    await $.tool.register({ name: 'apply', description: APPLY_DESCRIPTION, inputSchema: { type: 'object', properties: {} } })
    await $.command.register({
      name: COMMAND,
      description: 'Compact Lens: the pane, the pinned notes and the edited summary.',
      argumentHint: '[list | keep <text> | unpin <n> | apply]',
    })
    await refreshStatus($, config)
    if (config.openPane && e.isInteractive) void $.ui.open({ id: PANE_ID, title: 'Compact Lens' })
    return next(e)
  })

  on('session.compact', ($, e, next) => handleCompact($, e, next)).catch(($, e, next) => {
    log($, `the compaction hook failed and stood aside: ${String(next.error)}`)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId === undefined) await afterStep($, config)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && (await read($, pendingApplyAtom))) {
      const outcome = await applyNow($)
      log($, `apply at the turn's end: ${outcome.text}`)
      $.ui.toast(`compact-lens: ${outcome.text}`)
    }
    return result
  })

  on('tool.call', { tool: 'mcp__compact-lens__keep' }, async ($, e) => {
    const note = typeof e.note === 'string' ? e.note.trim() : ''
    if (note === '') return { deny: 'compact-lens: the note is empty' }
    const { id, count } = await pin($, note)
    return { result: `Pinned note ${id} (${count} pinned). It is kept verbatim through every compaction of this session.` }
  }).catch(($, e, next) => ({ deny: `compact-lens: keep failed: ${String(next.error)}` }))

  on('tool.call', { tool: 'mcp__compact-lens__apply' }, async $ => {
    const records = await read($, recordsAtom)
    const latest = records.at(-1)
    if (latest === undefined) return { deny: 'compact-lens: no compaction has run yet, so there is no summary to replace' }
    await requestApply($)
    return { result: `The edited ${latest.dir}/summary.md replaces the summary once this turn ends. End the turn to let it run.` }
  }).catch(($, e, next) => ({ deny: `compact-lens: apply failed: ${String(next.error)}` }))

  on('command.run', { command: 'compact-lens' }, ($, e) => runCommand($, e.args)).catch(($, e, next) => ({
    text: `compact-lens: the command failed: ${String(next.error)}`,
  }))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes(KEEP_TOOL)) return composed
    const [dir, records, pins] = await Promise.all([read($, sessionDirAtom), read($, recordsAtom), read($, pinsAtom)])
    const text = buildPromptSection({ sessionDir: dir ?? '(unset)', records, pinnedCount: pins.length })
    return { sections: [...composed.sections, { id: 'compact-lens:lens', text, scope: 'session' }] }
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, ($, e) => renderPane($, e))
}
