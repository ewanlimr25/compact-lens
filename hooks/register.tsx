// The hooks module. Every call on `$` lives in this file (the engine's validator follows `$`
// only into functions declared here); the pure parts are in the sibling modules.
import { atom, read, update } from 'claude-code'
import type {
  EngineInterface, HookFailure, PromptSubmitInput, PromptSubmitResult, Register,
  RenderInput, SessionCompactInput, SessionCompactResult, SessionMessage,
} from 'claude-code'

import type { CompactLensPin, CompactLensRecord } from '../types'
import { buildEditDraft, editHeader, editReply, editStarted, fileStamp, isPersonsOwn, judgeEdit, looksLikeEdit, parseEditHeader } from './editor'
import type { CurrentSummary, EditSubmission, NextSubmit, SavedEdit } from './editor'
import { computeLost, renderLost } from './lost'
import type { WarningFigures } from './notes'
import { buildApplyNote, buildNote, figuresOf, fillPercent, buildPinnedDirective, buildPromptSection, buildWarning, mergeInstructions, plural, renderPinned } from './notes'
import {
  COMMAND, COMPACT_COMMAND, COMPACT_FILL, compactionFiles, draftFile, EDIT_CLEAR_DELAY_MS, EDIT_FILL_DELAY_MS, FREE_NAME_TRIES,
  KEEP_TOOL, lensRoot, pad2, PANE_ID, pinnedFile, sessionDirOf,
} from './paths'
import type { CompactionFiles } from './paths'
import type { NextCompact, RecordCompactionArgs } from './records'
import { buildRecord, buildUnseenRecord, findRecordedSummary, heldLists, insertAfter, isRecordedSummary, replaceAt, summaryIn, userMessage } from './records'
import { contextText, findSummaryIndex, renderTranscript, toJson, transcriptChars } from './snapshot'
import {
  APPLY_DESCRIPTION, ARGUMENT_HINT, EDIT_STARTED_TOAST, failureText, formatList, formatShown, formatStatus, HELP, KEEP_DESCRIPTION,
  OFFER_TOAST, paneLine, parseShow, readConfig, RUN_COMPACT_TOAST, SHOWN_RECORDS, statusLineText, storeKey, unseenBefore, unseenLost,
} from './texts'
import type { Config } from './texts'

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
const editingAtom = atom({ plugin: 'compact-lens', key: 'editing' } as const, NO_NUMBER)

// ---------------------------------------------------------------- config and small helpers

/** A dim transcript line; the engine prints it under the plugin's name. */
const log = ($: EngineInterface, line: string): void => $.ui.log(line)


const isoNow = async ($: EngineInterface): Promise<string> => new Date(await $.clock.now()).toISOString()

// ---------------------------------------------------------------- the store mirror

/** Mirrors the session's pins and records to the store, so a resumed session finds them. */
const persist = async ($: EngineInterface): Promise<void> => {
  const id = await $.session.id()
  const [pinned, compactions] = await Promise.all([read($, pinsAtom), read($, recordsAtom)])
  await $.store.set(storeKey(id), { pinned, compactions })
}

/** Fills empty state from the store: a resumed session in a new process. */
const restore = async ($: EngineInterface): Promise<void> => {
  const { pinned, compactions } = heldLists(await $.store.get(storeKey(await $.session.id())))
  if (compactions.length > 0 && (await read($, recordsAtom)).length === 0) await update($, recordsAtom, () => compactions)
  if (pinned.length > 0 && (await read($, pinsAtom)).length === 0) await update($, pinsAtom, () => pinned)
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

// The engine never runs a plugin's own session.compact hook for a compaction that plugin asked for
// with $.session.compact(): its summariser runs instead. So an apply rides on the person's /compact,
// which the hook answers with the edited summary.

/** Sets whether an edit waits, and redraws the status line, which says so. */
const setPending = async ($: EngineInterface, isPending: boolean): Promise<void> => {
  await update($, pendingApplyAtom, () => isPending)
  await refreshStatus($)
}

const requestApply = ($: EngineInterface): Promise<void> => setPending($, true)

// The model's apply offers /compact when its turn ends; a reload forgets it, and the status line still says an apply waits.
let isOfferDue = false

/** Puts `text` in the prompt box when the box is empty or holds only `replaced` (a caught prompt the engine put back); whether the box holds `text` now. */
const fillFree = async ($: EngineInterface, text: string, replaced?: string): Promise<boolean> => {
  const box = (await $.prompt.read()).text.trim()
  const isFree = box === '' || (replaced !== undefined && box === replaced.trim())
  if (!isFree || box === text.trim()) return box === text.trim()
  return (await $.prompt.fill({ text, mode: 'replace' })).isFilled
}

/** Puts /compact in the prompt box when the box is free, else says to run it; never throws. */
const offerCompact = async ($: EngineInterface, replaced?: string): Promise<void> => {
  const isOffered = await fillFree($, COMPACT_FILL, replaced).catch(error => {
    log($, `apply: ${COMPACT_COMMAND} did not go into the prompt box (${String(error)})`)
    return false
  })
  $.ui.toast(isOffered ? OFFER_TOAST : RUN_COMPACT_TOAST)
}

const scheduleOffer = ($: EngineInterface, delayMs: number, replaced?: string): void => {
  $.clock.after(delayMs, () => void offerCompact($, replaced))
}

/** The summary.md an apply would use, when it differs from the summary the conversation runs on; the reason otherwise. */
const checkApplicable = async ($: EngineInterface): Promise<{ path: string } | string> => {
  await syncUnseen($)
  const [records, dir] = await Promise.all([read($, recordsAtom), read($, sessionDirAtom)])
  const latest = records.at(-1)
  if (latest === undefined || dir === null) return 'no compaction has run yet, so there is no summary to replace'
  const path = compactionFiles(dir, latest.n).summary
  if (!(await $.fs.exists(path))) return `${path} is missing`
  const edited = (await $.fs.read(path)).trim()
  if (edited === '') return `${path} is empty`
  const inUse = await summaryNow($, records)
  if (inUse === undefined || !isRecordedSummary(inUse, latest)) return `the summary of #${pad2(latest.n)} is not the one in use now, so there is nothing for ${path} to replace`
  if (inUse.trim() === edited) return `${path} is the summary in use; edit it first`
  return { path }
}

/** A compaction other than the person's /compact ran while an edit waited: the edit is of a summary no longer in use. */
const supersedeApply = async ($: EngineInterface): Promise<void> => {
  await setPending($, false)
  const text = `a compaction ran before the edited summary was applied, so it was not; the edit stays in the previous folder's summary.md, and /${COMMAND} edit loads the new summary`
  log($, text)
  $.ui.toast(text)
}

// ---------------------------------------------------------------- a compaction the mod did not see

/** The summary the conversation runs on: the engine puts it first in the next request; undefined before any compaction. */
const summaryNow = async ($: EngineInterface, records: readonly CompactLensRecord[]): Promise<string | undefined> =>
  summaryIn(await $.session.messages({ as: 'api' }), await $.session.messages(), records.map(r => r.summaryHead))

/**
 * Records the compaction the conversation's summary came from when the mod did not see it run (a
 * reload, the mod not loaded): its summary and what follows, so it can be shown, edited and applied.
 */
const syncUnseen = ($: EngineInterface): Promise<void> => {
  syncing ??= adoptUnseen($).finally(() => (syncing = undefined))
  return syncing
}

// One look at a time: two at once (a command and its timer) would record the same compaction twice.
let syncing: Promise<void> | undefined

const adoptUnseen = async ($: EngineInterface): Promise<void> => {
  const [records, dir] = await Promise.all([read($, recordsAtom), read($, sessionDirAtom)])
  if (dir === null) return
  const text = await summaryNow($, records)
  if (text === undefined || records.some(r => isRecordedSummary(text, r))) return
  const rows = await $.session.messages()
  const index = rows.findIndex(m => m.role === 'user' && m.text === text)
  const after = index < 0 ? [userMessage(text)] : rows.slice(index)
  const n = records.length + 1
  const files = compactionFiles(dir, n)
  const at = await isoNow($)
  await $.fs.write(files.before, unseenBefore(n, at))
  await $.fs.write(files.summary, text)
  await $.fs.write(files.lost, unseenLost(n, at))
  await writeRecord($, buildUnseenRecord({ n, at, files, after, summary: text }), files, after)
  log($, `compaction #${n} ran unseen; its summary is recorded in ${files.summary}`)
}

// ---------------------------------------------------------------- editing the summary in the prompt box

/** The latest compaction's summary.md, one the mod did not see run included; the reason there is none to edit otherwise. */
const currentSummary = async ($: EngineInterface): Promise<CurrentSummary | string> => {
  await syncUnseen($)
  const [records, dir] = await Promise.all([read($, recordsAtom), read($, sessionDirAtom)])
  const latest = records.at(-1)
  if (latest === undefined || dir === null) return 'no compaction has run yet, so there is no summary to edit'
  const files = compactionFiles(dir, latest.n)
  if (!(await $.fs.exists(files.summary))) return `${files.summary} is missing, so there is no summary to edit`
  return { n: latest.n, files, text: await $.fs.read(files.summary) }
}

/** Puts the summary in the prompt box under its header and opens the edit; the reason when it did not go in. */
const fillEditor = async ($: EngineInterface): Promise<string | undefined> => {
  const current = await currentSummary($)
  if (typeof current === 'string') return current
  const box = await $.prompt.read()
  if (box.text.trim() !== '') {
    return parseEditHeader(box.text) === undefined
      ? 'the prompt box holds a draft of yours; send or clear it, then ask for the edit again'
      : 'an edit is already in the prompt box; Enter applies it, or empty the box and ask again to start over'
  }
  const header = editHeader(current.n)
  const text = buildEditDraft(current.n, current.text)
  const filled = await $.prompt.fill({ text, mode: 'replace', decorations: [{ start: 0, end: header.length, dimColor: true }] })
  if (!filled.isFilled) {
    const cause = filled.refusal === undefined ? '' : ` (${filled.refusal})`
    return `the prompt box did not take the summary${cause}; edit ${current.files.summary}, run /${COMMAND} apply, then ${COMPACT_COMMAND}`
  }
  await update($, editingAtom, () => current.n)
  return undefined
}

const reportEditFailure = ($: EngineInterface, failure: string): void => {
  log($, `edit: ${failure}`)
  $.ui.toast(failure)
}

/** Fills the box and says so; any failure is reported, never thrown. */
const startEdit = async ($: EngineInterface, success?: string): Promise<void> => {
  try {
    const failure = await fillEditor($)
    if (failure !== undefined) reportEditFailure($, failure)
    else if (success !== undefined) $.ui.toast(success)
  } catch (error) {
    reportEditFailure($, `the summary could not go into the prompt box (${String(error)})`)
  }
}

/** The command's way: a moment later, once the engine has emptied the box for the Enter that ran the command. */
const scheduleEdit = ($: EngineInterface): void => {
  $.clock.after(EDIT_FILL_DELAY_MS, () => void startEdit($))
}

const closeEdit = async ($: EngineInterface): Promise<void> => {
  if ((await read($, editingAtom)) !== null) await update($, editingAtom, () => null)
}

/** Empties the box if the engine put the caught prompt back in it; anything else there is left alone. */
const scheduleClear = ($: EngineInterface, submitted: string): void => {
  $.clock.after(EDIT_CLEAR_DELAY_MS, () => void fillFree($, '', submitted).catch(error => log($, `edit: the prompt box was not emptied (${String(error)})`)))
}

/** A path for a kept-aside text that holds nothing yet: `<stem>.md`, else `<stem>-2.md`, and so on. */
const freePath = async ($: EngineInterface, stem: string): Promise<string> => {
  for (let i = 1; i <= FREE_NAME_TRIES; i += 1) {
    const path = i === 1 ? `${stem}.md` : `${stem}-${i}.md`
    if (!(await $.fs.exists(path))) return path
  }
  throw new Error(`no free name for ${stem}.md`)
}

/** The edit in a submitted prompt: by its header, or, while an edit is open, by the open summary's own lines. */
const recognizeEdit = async ($: EngineInterface, text: string): Promise<EditSubmission | undefined> => {
  const byHeader = parseEditHeader(text)
  if (byHeader !== undefined) return byHeader
  const [n, dir] = await Promise.all([read($, editingAtom), read($, sessionDirAtom)])
  if (n === null || dir === null) return undefined
  const path = compactionFiles(dir, n).summary
  const summary = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
  return looksLikeEdit(text, summary) ? { n, body: text.trim() } : undefined
}

/** A caught edit: saved to summary.md for the apply, kept aside when there is no summary or a newer one, or dropped when empty or unchanged. */
const saveEdit = async ($: EngineInterface, edit: EditSubmission, isTurnRunning: boolean): Promise<SavedEdit> => {
  const [records, dir] = await Promise.all([read($, recordsAtom), read($, sessionDirAtom)])
  if (dir === null) throw new Error('the snapshot folder is not set')
  const latestN = records.at(-1)?.n
  const summaryPath = compactionFiles(dir, latestN ?? edit.n).summary
  const verdict = judgeEdit(edit, latestN, await summaryNow($, records))
  const keptPath = verdict === 'none' || verdict === 'stale' ? await freePath($, `${compactionFiles(dir, edit.n).dir}/edit-unapplied-${fileStamp(await isoNow($))}`) : ''
  if (verdict === 'none' || verdict === 'stale') await $.fs.write(keptPath, edit.body)
  const isApplyDropped = verdict === 'unchanged' && (await read($, pendingApplyAtom))
  if (verdict === 'apply' || isApplyDropped) await $.fs.write(summaryPath, edit.body)
  if (verdict === 'apply' || isApplyDropped) await setPending($, verdict === 'apply')
  log($, `the edit of #${pad2(edit.n)} in the prompt box: ${verdict}`)
  return { reply: editReply({ verdict, n: edit.n, latestN, summaryPath, keptPath, isTurnRunning, isApplyDropped }), isApply: verdict === 'apply' }
}

/** When the edit hook fails on an edit: its text kept in a file where possible, and where. */
const rescueEdit = async ($: EngineInterface, text: string): Promise<string> => {
  try {
    const dir = await read($, sessionDirAtom)
    if (dir === null) return ''
    const path = await freePath($, `${dir}/edit-unsaved-${fileStamp(await isoNow($))}`)
    await $.fs.write(path, text)
    return ` Your text is kept at ${path}.`
  } catch {
    return ''
  }
}

/**
 * The person's Enter on an edit in the prompt box, caught before the model sees it. Any other prompt
 * passes; one typed at the terminal closes an open edit, since it replaced the edit in the box.
 */
const handleSubmit = async ($: EngineInterface, e: PromptSubmitInput, next: NextSubmit): Promise<PromptSubmitResult> => {
  if (!isPersonsOwn(e)) return next(e)
  const edit = await recognizeEdit($, e.text)
  if (edit === undefined) {
    if (e.origin.kind === 'composer') await closeEdit($)
    return next(e)
  }
  const saved = await saveEdit($, edit, e.turnId !== undefined)
  await closeEdit($)
  if (saved.isApply) scheduleOffer($, EDIT_CLEAR_DELAY_MS, e.text)
  else scheduleClear($, e.text)
  return { drop: saved.reply }
}

/**
 * The edit hook failed: an edit, or any prompt while an edit is open, is kept out of the model's
 * sight and saved aside, and the edit is closed, so a failure that persists costs one prompt, not all.
 */
const handleSubmitFailure = async ($: EngineInterface, e: PromptSubmitInput, failure: HookFailure, next: NextSubmit): Promise<PromptSubmitResult> => {
  const reason = failureText(failure)
  log($, `the edit hook failed: ${reason}`)
  const isEditOpen = await read($, editingAtom).then(n => n !== null, () => true)
  if (!isPersonsOwn(e) || (parseEditHeader(e.text) === undefined && !isEditOpen)) return next(e)
  const kept = await rescueEdit($, e.text)
  await closeEdit($).catch(error => log($, `edit: the open edit was not closed (${String(error)})`))
  return { drop: `compact-lens: the edit could not be saved (${reason}), so nothing was applied.${kept} The prompt was not sent to the model.` }
}

// ---------------------------------------------------------------- the fill, the status line, the warning

// The statusLine option, as register read it; a reload reads it again.
let isStatusLineOn = true

const refreshStatus = async ($: EngineInterface): Promise<void> => {
  if (!isStatusLineOn) {
    $.ui.status(undefined)
    return
  }
  const [fill, records, pins, isPending] = await Promise.all([read($, fillAtom), read($, recordsAtom), read($, pinsAtom), read($, pendingApplyAtom)])
  $.ui.status(statusLineText({ fill, records, pinCount: pins.length, isPending }))
}

/** The context fill as a percent of the window, from the free usage call; undefined before the first response. */
const readFill = async ($: EngineInterface): Promise<number | undefined> => {
  const percent = fillPercent((await $.session.usage()).context)
  if (percent === undefined) return undefined
  await update($, fillAtom, () => percent)
  return percent
}

/**
 * The fill and the auto-compaction line on one base: the breakdown's compaction window when the
 * engine answers one (it may be smaller than the model's window), else the plain fill alone.
 */
const warningFigures = async ($: EngineInterface, percent: number): Promise<WarningFigures> => {
  try {
    return figuresOf((await $.session.usage({ breakdown: 'summary' })).context.breakdown, percent)
  } catch {
    return { percent, thresholdPercent: undefined }
  }
}

/** After a main-loop model step: the fill, the status line, and the one warning per window. */
const afterStep = async ($: EngineInterface, config: Config): Promise<void> => {
  const percent = await readFill($)
  await refreshStatus($)
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
  $.ui.toast(`context at ${figures.percent}%; the model was told where the snapshots go`)
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

const writeRecord = async ($: EngineInterface, record: CompactLensRecord, files: CompactionFiles, after: readonly SessionMessage[]): Promise<void> => {
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

/** The summary, the lost report, the record and the note: what every real compaction leaves. */
const recordCompaction = async ($: EngineInterface, args: RecordCompactionArgs): Promise<SessionMessage[]> => {
  const { n, trigger, at, files, before, withSummary, summaryIndex, pins } = args
  const summary = withSummary[summaryIndex] ?? userMessage('')
  const lost = computeLost(before, contextText(withSummary))
  const record = buildRecord({ n, trigger, at, files, before, after: withSummary, summary: summary.text, lost, tokensBefore: args.tokensBefore, tokensAfter: args.tokensAfter })
  await $.fs.write(files.summary, summary.text)
  await $.fs.write(files.lost, renderLost(lost, { n, trigger, at, beforePath: files.before, tokensBefore: args.tokensBefore }))
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
  $.ui.toast(`compaction #${n} recorded in ${files.dir}`)
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

/** An apply: the edited summary.md replaces the current summary; no summariser runs. A skip drops the waiting edit and says why. */
const handleApply = async ($: EngineInterface, e: SessionCompactInput, dir: string): Promise<SessionCompactResult> => {
  const skip = async (reason: string): Promise<SessionCompactResult> => {
    await setPending($, false)
    return { skip: `compact-lens: ${reason}; run ${COMPACT_COMMAND} again to compact as usual` }
  }
  const records = await read($, recordsAtom)
  const latest = records.at(-1)
  if (latest === undefined) return skip('nothing to apply, no compaction has run yet')
  const current = compactionFiles(dir, latest.n)
  const edited = (await $.fs.exists(current.summary)) ? (await $.fs.read(current.summary)).trim() : ''
  if (edited === '') return skip(`${current.summary} is missing or empty, so nothing was applied`)
  const index = findRecordedSummary(e.messages, latest)
  if (index < 0) return skip(`the summary of #${pad2(latest.n)} is not in the conversation now, so the edit was not applied; it stays in ${current.summary}`)
  const old = e.messages[index] ?? userMessage('')
  if (old.text.trim() === edited) return skip(`${current.summary} is the summary in use, so there was nothing to apply`)

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
  await setPending($, false)
  log($, `apply #${n}: the summary was replaced from ${current.summary}; snapshots in ${files.dir}`)
  $.ui.toast(`your edited summary is in place (#${pad2(n)})`)
  return { messages }
}

// Set while the hook answers an apply: if it throws, its .catch must skip, never hand the compaction to the summariser.
let isApplying = false

/** The session.compact hook: the engine's compactions are recorded; the person's /compact with an edit waiting is answered by the mod. */
const handleCompact = async ($: EngineInterface, e: SessionCompactInput, next: NextCompact): Promise<SessionCompactResult> => {
  if (e.agentId !== undefined) return next(e)
  if (!Array.isArray(e.messages)) {
    log($, `a compaction arrived without its messages (trigger ${String(e.trigger)}); passed through`)
    return next(e)
  }
  const dir = await read($, sessionDirAtom)
  if (dir === null) return next(e)
  if (e.trigger === 'precompute') return handlePrecompute($, e, next, dir)
  const isPending = await read($, pendingApplyAtom)
  if (isPending && e.trigger === 'manual' && (e.instructions ?? '').trim() === '') {
    isApplying = true
    const applied = await handleApply($, e, dir)
    isApplying = false
    return applied
  }
  const result = await handleReal($, e, next, dir)
  if (isPending && result.skip === undefined) await supersedeApply($)
  return result
}

// ---------------------------------------------------------------- the slash command

const statusText = async ($: EngineInterface): Promise<string> => {
  await syncUnseen($)
  const [fill, records, pins] = await Promise.all([read($, fillAtom), read($, recordsAtom), read($, pinsAtom)])
  const [dir, isPending] = await Promise.all([read($, sessionDirAtom), read($, pendingApplyAtom)])
  return formatStatus({ fill, records, pinCount: pins.length, dir, isPending })
}

const listText = async ($: EngineInterface): Promise<string> => {
  await syncUnseen($)
  const [records, pins, dir] = await Promise.all([read($, recordsAtom), read($, pinsAtom), read($, sessionDirAtom)])
  return formatList(records, pins, dir)
}

/** `show [what] [n]`: a snapshot file printed as the reply, so neither the person nor the model has to open it. */
const showText = async ($: EngineInterface, tail: string): Promise<string> => {
  const request = parseShow(tail)
  if (typeof request === 'string') return request
  await syncUnseen($)
  const [records, dir] = await Promise.all([read($, recordsAtom), read($, sessionDirAtom)])
  const n = request.n ?? records.at(-1)?.n
  if (dir === null) return 'the snapshot folder is not set'
  if (request.kind !== 'pinned' && n === undefined) return 'no compaction has run yet, so there is nothing to show'
  const path = request.kind === 'pinned' ? pinnedFile(dir) : compactionFiles(dir, n ?? 0)[request.kind]
  return (await $.fs.exists(path)) ? formatShown(path, await $.fs.read(path)) : `${path} does not exist`
}

/** `apply`: the edited summary.md readied, and /compact offered to apply it. */
const applyText = async ($: EngineInterface): Promise<string> => {
  const applicable = await checkApplicable($)
  if (typeof applicable === 'string') return `nothing to apply: ${applicable}.`
  await requestApply($)
  scheduleOffer($, EDIT_FILL_DELAY_MS)
  return `${applicable.path} is ready. Press Enter on ${COMPACT_COMMAND}, which goes into the prompt box now: the mod answers it with the edited summary, and no summariser runs.`
}

const cancelText = async ($: EngineInterface): Promise<string> => {
  if (!(await read($, pendingApplyAtom))) return 'no apply is waiting.'
  await setPending($, false)
  return `the waiting apply is dropped; the edit stays in its summary.md, and /${COMMAND} apply readies it again.`
}

/** `/compact-lens [verb] [rest]`: the person's side of the mod. The engine prints each reply under the plugin's name. */
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
    case 'edit': {
      const current = await currentSummary($)
      if (typeof current === 'string') return { text: `${current}.` }
      scheduleEdit($)
      return { text: editStarted(current.n) }
    }
    case 'show':
      return { text: await showText($, tail) }
    case 'list':
      return { text: await listText($) }
    case 'keep':
    case 'pin': {
      if (tail === '') return { text: `keep needs a note: /${COMMAND} keep <text>` }
      const { id, count } = await pin($, tail)
      return { text: `pinned note ${id} (${count} pinned). It is kept verbatim through every compaction of this session.` }
    }
    case 'unpin': {
      const id = Number(tail)
      if (!Number.isInteger(id)) return { text: `unpin needs a number: /${COMMAND} unpin <n>` }
      return { text: (await unpin($, id)) ? `note ${id} removed.` : `no pinned note ${id}.` }
    }
    case 'apply':
      return { text: await applyText($) }
    case 'cancel':
      return { text: await cancelText($) }
    default:
      return { text: HELP }
  }
}

// ---------------------------------------------------------------- the pane

const applyFromPane = async ($: EngineInterface): Promise<void> => {
  const applicable = await checkApplicable($)
  if (typeof applicable === 'string') {
    $.ui.toast(`nothing to apply: ${applicable}`)
    return
  }
  await requestApply($)
  await offerCompact($)
}

/** The pane: the fill, the compactions, the pinned notes and the two actions. */
const renderPane = async ($: EngineInterface, e: RenderInput<'Pane'>) => {
  const { Box, Text, Button } = $.ui.resolve(e)
  const [records, pins, fill] = await Promise.all([read($, recordsAtom), read($, pinsAtom), read($, fillAtom)])
  const [dir, pending] = await Promise.all([read($, sessionDirAtom), read($, pendingApplyAtom)])
  const shown = records.slice(-SHOWN_RECORDS)

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold>Compact Lens</Text>
        <Text dimColor>
          context {fill === null ? '–' : `${fill}%`} · {plural(records.length, 'compaction')} · {pins.length} pinned
          {pending ? ` · ${COMPACT_COMMAND} applies the edit` : ''}
        </Text>
        <Text dimColor wrap="truncate-start">
          {dir ?? '(unset)'}
        </Text>
      </Box>
      <Box flexDirection="column">
        <Text bold>Compactions</Text>
        {shown.length === 0 && <Text dimColor>none yet</Text>}
        {shown.map(r => (
          <Text wrap="truncate-end">{paneLine(r)}</Text>
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
        <Button key="edit" label="Edit summary" hotkey="e" onPress={() => void startEdit($, EDIT_STARTED_TOAST)} />
        <Button key="apply" label="Apply summary.md" hotkey="a" onPress={() => void applyFromPane($).catch(error => log($, `apply: ${String(error)}`))} />
        <Button key="refresh" label="Refresh" hotkey="r" onPress={() => void readFill($)} />
        <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE_ID })} />
      </Box>
    </Box>
  )
}

// ---------------------------------------------------------------- registration

export const register: Register = (on, options) => {
  const config = readConfig(options)
  isStatusLineOn = config.statusLine

  on('session.start', async ($, e, next) => {
    const home = (await $.env.get('HOME')) ?? ''
    const dir = sessionDirOf(lensRoot(home, config.dir), await $.session.id())
    await update($, sessionDirAtom, () => dir)
    await restore($)
    await syncUnseen($).catch(error => log($, `a compaction the mod did not see could not be recorded (${String(error)})`))
    await $.tool.register({
      name: 'keep',
      description: KEEP_DESCRIPTION,
      inputSchema: { type: 'object', properties: { note: { type: 'string', description: 'The fact to keep, verbatim.' } }, required: ['note'] },
    })
    await $.tool.register({ name: 'apply', description: APPLY_DESCRIPTION, inputSchema: { type: 'object', properties: {} } })
    await $.command.register({
      name: COMMAND,
      description: 'Compact Lens: edit the summary, pin notes, open the pane.',
      argumentHint: ARGUMENT_HINT,
    })
    await refreshStatus($)
    if (config.openPane && e.isInteractive) void $.ui.open({ id: PANE_ID, title: 'Compact Lens' })
    return next(e)
  })

  on('session.compact', ($, e, next) => handleCompact($, e, next)).catch(($, e, next) => {
    if (!isApplying || e.trigger !== 'manual' || e.agentId !== undefined) {
      log($, `the compaction hook failed and stood aside: ${failureText(next.error)}`)
      return next(e)
    }
    isApplying = false
    return { skip: `compact-lens: the edit could not be applied (${failureText(next.error)}), so nothing changed; it still waits: ${COMPACT_COMMAND} tries again, /${COMMAND} cancel drops it` }
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId === undefined) await afterStep($, config)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && isOfferDue) {
      isOfferDue = false
      if (await read($, pendingApplyAtom)) await offerCompact($)
    }
    return result
  })

  on('tool.call', { tool: 'mcp__compact-lens__keep' }, async ($, e) => {
    const note = typeof e.note === 'string' ? e.note.trim() : ''
    if (note === '') return { deny: 'compact-lens: the note is empty' }
    const { id, count } = await pin($, note)
    return { result: `Pinned note ${id} (${count} pinned). It is kept verbatim through every compaction of this session.` }
  }).catch(($, e, next) => ({ deny: `compact-lens: keep failed: ${failureText(next.error)}` }))

  on('tool.call', { tool: 'mcp__compact-lens__apply' }, async $ => {
    const applicable = await checkApplicable($)
    if (typeof applicable === 'string') return { deny: `compact-lens: ${applicable}` }
    await requestApply($)
    isOfferDue = true
    return {
      result: `${applicable.path} is ready. The person applies it with ${COMPACT_COMMAND}: when this turn ends, ${COMPACT_COMMAND} goes into their prompt box, and the mod answers it with the edited summary (no summariser runs; the messages after the summary stay). Tell them to press Enter on it.`,
    }
  }).catch(($, e, next) => ({ deny: `compact-lens: apply failed: ${failureText(next.error)}` }))

  on('command.run', { command: 'compact-lens' }, ($, e) => runCommand($, e.args)).catch(($, e, next) => ({
    text: `the command failed: ${failureText(next.error)}`,
  }))

  on('prompt.submit', ($, e, next) => handleSubmit($, e, next)).catch(($, e, next) => handleSubmitFailure($, e, next.error, next))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes(KEEP_TOOL)) return composed
    const [dir, records, pins] = await Promise.all([read($, sessionDirAtom), read($, recordsAtom), read($, pinsAtom)])
    const text = buildPromptSection({ sessionDir: dir ?? '(unset)', records, pinnedCount: pins.length })
    return { sections: [...composed.sections, { id: 'compact-lens:lens', text, scope: 'session' }] }
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, ($, e) => renderPane($, e))
}
