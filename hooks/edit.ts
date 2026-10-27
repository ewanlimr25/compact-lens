// Editing the summary in Claude Code's own prompt box: the summary goes in under a header line, the
// person's Enter is caught before the model sees it, saved to summary.md, and /compact offered to apply it.
import type { EngineInterface, HookFailure, PromptSubmitInput, PromptSubmitResult } from 'claude-code'

import { scheduleOffer, setPending, fillFree } from './apply'
import { buildEditDraft, editHeader, editReply, fileStamp, isPersonsOwn, judgeEdit, looksLikeEdit, parseEditHeader } from './editor'
import type { CurrentSummary, EditSubmission, NextSubmit, SavedEdit } from './editor'
import { summaryNow, syncHistory } from './history'
import { COMMAND, COMPACT_COMMAND, compactionFiles, EDIT_CLEAR_DELAY_MS, EDIT_FILL_DELAY_MS, FREE_NAME_TRIES, pad2 } from './paths'
import { ensureSession, isoNow, log } from './session'
import { getEditing, getRecords, getSessionDir, isApplyPending, setEditing } from './state'
import { failureText } from './texts'

/** The latest compaction's summary.md, one the mod did not see run included; the reason there is none to edit otherwise. */
export async function currentSummary($: EngineInterface): Promise<CurrentSummary | string> {
  await syncHistory($)
  const dir = await ensureSession($)
  const latest = (await getRecords($)).at(-1)
  if (latest === undefined) return 'no compaction has run yet, so there is no summary to edit'
  const files = compactionFiles(dir, latest.n)
  if (!(await $.fs.exists(files.summary))) return `${files.summary} is missing, so there is no summary to edit`
  return { n: latest.n, files, text: await $.fs.read(files.summary) }
}

/** Puts the summary in the prompt box under its header and opens the edit; the reason when it did not go in. */
async function fillEditor($: EngineInterface): Promise<string | undefined> {
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
  await setEditing($, current.n)
  return undefined
}

function reportEditFailure($: EngineInterface, failure: string): void {
  log($, `edit: ${failure}`)
  $.ui.toast(failure)
}

/** Fills the box and says so; any failure is reported, never thrown. */
export async function startEdit($: EngineInterface, success?: string): Promise<void> {
  try {
    const failure = await fillEditor($)
    if (failure !== undefined) reportEditFailure($, failure)
    else if (success !== undefined) $.ui.toast(success)
  } catch (error) {
    reportEditFailure($, `the summary could not go into the prompt box (${String(error)})`)
  }
}

/** The command's way: a moment later, once the engine has emptied the box for the Enter that ran the command. */
export function scheduleEdit($: EngineInterface): void {
  $.clock.after(EDIT_FILL_DELAY_MS, () => void startEdit($))
}

async function closeEdit($: EngineInterface): Promise<void> {
  if ((await getEditing($)) !== null) await setEditing($, null)
}

/** Empties the box if the engine put the caught prompt back in it; anything else there is left alone. */
function scheduleClear($: EngineInterface, submitted: string): void {
  $.clock.after(EDIT_CLEAR_DELAY_MS, () => void fillFree($, '', submitted).catch(error => log($, `edit: the prompt box was not emptied (${String(error)})`)))
}

/** A path for a kept-aside text that holds nothing yet: `<stem>.md`, else `<stem>-2.md`, and so on. */
async function freePath($: EngineInterface, stem: string): Promise<string> {
  for (let i = 1; i <= FREE_NAME_TRIES; i += 1) {
    const path = i === 1 ? `${stem}.md` : `${stem}-${i}.md`
    if (!(await $.fs.exists(path))) return path
  }
  throw new Error(`no free name for ${stem}.md`)
}

/** The edit in a submitted prompt: by its header, or, while an edit is open, by the open summary's own lines. */
async function recognizeEdit($: EngineInterface, text: string): Promise<EditSubmission | undefined> {
  const byHeader = parseEditHeader(text)
  if (byHeader !== undefined) return byHeader
  const [n, dir] = await Promise.all([getEditing($), getSessionDir($)])
  if (n === null || dir === null) return undefined
  const path = compactionFiles(dir, n).summary
  const summary = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
  return looksLikeEdit(text, summary) ? { n, body: text.trim() } : undefined
}

/** A caught edit: saved to summary.md for the apply, kept aside when there is no summary or a newer one, or dropped when empty or unchanged. */
async function saveEdit($: EngineInterface, edit: EditSubmission, isTurnRunning: boolean): Promise<SavedEdit> {
  const [records, dir] = await Promise.all([getRecords($), getSessionDir($)])
  if (dir === null) throw new Error('the snapshot folder is not set')
  const latestN = records.at(-1)?.n
  const summaryPath = compactionFiles(dir, latestN ?? edit.n).summary
  const verdict = judgeEdit(edit, latestN, await summaryNow($, records))
  const isKeptAside = verdict === 'none' || verdict === 'stale'
  const keptPath = isKeptAside ? await freePath($, `${compactionFiles(dir, edit.n).dir}/edit-unapplied-${fileStamp(await isoNow($))}`) : ''
  if (isKeptAside) await $.fs.write(keptPath, edit.body)
  const isApplyDropped = verdict === 'unchanged' && (await isApplyPending($))
  if (verdict === 'apply' || isApplyDropped) await $.fs.write(summaryPath, edit.body)
  if (verdict === 'apply' || isApplyDropped) await setPending($, verdict === 'apply')
  log($, `the edit of #${pad2(edit.n)} in the prompt box: ${verdict}`)
  return { reply: editReply({ verdict, n: edit.n, latestN, summaryPath, keptPath, isTurnRunning, isApplyDropped }), isApply: verdict === 'apply' }
}

/** When the edit hook fails on an edit: its text kept in a file where possible, and where. */
async function rescueEdit($: EngineInterface, text: string): Promise<string> {
  try {
    const dir = await getSessionDir($)
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
export async function handleSubmit($: EngineInterface, e: PromptSubmitInput, next: NextSubmit): Promise<PromptSubmitResult> {
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
export async function handleSubmitFailure($: EngineInterface, e: PromptSubmitInput, failure: HookFailure, next: NextSubmit): Promise<PromptSubmitResult> {
  const reason = failureText(failure)
  log($, `the edit hook failed: ${reason}`)
  const isEditOpen = await getEditing($).then(n => n !== null, () => true)
  if (!isPersonsOwn(e) || (parseEditHeader(e.text) === undefined && !isEditOpen)) return next(e)
  const kept = await rescueEdit($, e.text)
  await closeEdit($).catch(error => log($, `edit: the open edit was not closed (${String(error)})`))
  return { drop: `compact-lens: the edit could not be saved (${reason}), so nothing was applied.${kept} The prompt was not sent to the model.` }
}
