// `/compact-lens [verb] [rest]`: the person's side of the mod. The engine prints each reply under the
// plugin's name, and the model reads a reply too; `context` entries go to the model alone.
import type { CommandRunResult, EngineInterface, PromptOrigin } from 'claude-code'

import { refreshStatus } from './ahead'
import { checkApplicable, scheduleOffer, setPending } from './apply'
import { editStarted } from './editor'
import { doctorText } from './doctor'
import { currentSummary, scheduleEdit } from './edit'
import { materialize, needsReading, recordFor, syncHistory } from './history'
import { COMMAND, COMPACT_COMMAND, compactionFiles, EDIT_FILL_DELAY_MS, PANE_ID, pinnedFile } from './paths'
import { pin, unpin } from './pins'
import { pruneText } from './prune'
import { recallPassages, restorePrompts } from './restore'
import { ensureSession } from './session'
import { getContext, getPins, getRecords, isApplyPending } from './state'
import { statuslineText } from './statusline'
import { formatList, formatShown, formatStatus, HELP, isNumberWord, numberOf, parseRestore, parseShow } from './texts'
import type { ShowKind } from './texts'

async function statusText($: EngineInterface): Promise<string> {
  const synced = await syncHistory($)
  const dir = await ensureSession($)
  const [context, records, pins, isPending] = await Promise.all([getContext($), getRecords($), getPins($), isApplyPending($)])
  return formatStatus({ context, records, pinCount: pins.length, dir, isPending, transcript: synced.transcript })
}

async function listText($: EngineInterface): Promise<string> {
  await syncHistory($)
  const dir = await ensureSession($)
  const [records, pins] = await Promise.all([getRecords($), getPins($)])
  return formatList(records, pins, dir)
}

/** A snapshot file of compaction n, read from the transcript first when only its boundary was known, or when its folder went (a prune from another session). */
async function snapshotText($: EngineInterface, kind: Exclude<ShowKind, 'pinned'>, n: number | undefined): Promise<string> {
  const record = await recordFor($, n)
  if (typeof record === 'string') return `nothing to show: ${record}`
  const path = compactionFiles(await ensureSession($), record.n)[kind]
  const isGone = kind !== 'summary' && !needsReading(record) && !(await $.fs.exists(path))
  const read = (needsReading(record) || isGone) && kind !== 'summary' ? await materialize($, record.n, isGone) : record
  if (typeof read === 'string') return `nothing to show: ${read}`
  return (await $.fs.exists(path)) ? formatShown(path, await $.fs.read(path)) : `${path} does not exist`
}

/** `show [what] [n]`: a snapshot file printed as the reply, so neither the person nor the model has to open it. */
async function showText($: EngineInterface, tail: string): Promise<string> {
  const request = parseShow(tail)
  if (typeof request === 'string') return request
  if (request.kind !== 'pinned') return snapshotText($, request.kind, request.n)
  const path = pinnedFile(await ensureSession($))
  return (await $.fs.exists(path)) ? formatShown(path, await $.fs.read(path)) : `${path} does not exist`
}

/** `lost [n]`: what compaction n dropped. */
async function lostText($: EngineInterface, tail: string): Promise<string> {
  const words = tail.split(/\s+/).filter(word => word !== '')
  const first = words[0]
  if (words.length > 1 || (first !== undefined && !isNumberWord(first))) return `lost takes a compaction number, as in /${COMMAND} lost 2`
  return snapshotText($, 'lost', first === undefined ? undefined : numberOf(first))
}

/** `restore [n] [words]`: the person's prompts, or the passages that mention the words, handed to the model. */
async function restoreReply($: EngineInterface, tail: string): Promise<CommandRunResult> {
  const { n, query } = parseRestore(tail)
  const restored = query === '' ? await restorePrompts($, n, true) : await recallPassages($, query, n)
  if (typeof restored === 'string') return { text: `nothing restored: ${restored}.` }
  return {
    text: `Claude now has ${restored.summary}, verbatim (${restored.chars} characters), and reads them with your next message.`,
    context: [restored.block],
  }
}

/** `apply`: the edited summary.md readied, and /compact offered to apply it. */
async function applyText($: EngineInterface): Promise<string> {
  const applicable = await checkApplicable($)
  if (typeof applicable === 'string') return `nothing to apply: ${applicable}.`
  await setPending($, true)
  scheduleOffer($, EDIT_FILL_DELAY_MS)
  return `${applicable.path} is ready. Press Enter on ${COMPACT_COMMAND}, which goes into the prompt box now: the mod answers it with the edited summary, and no summariser runs.`
}

async function cancelText($: EngineInterface): Promise<string> {
  if (!(await isApplyPending($))) return 'no apply is waiting.'
  await setPending($, false)
  return `the waiting apply is dropped; the edit stays in its summary.md, and /${COMMAND} apply readies it again.`
}

async function keepText($: EngineInterface, tail: string): Promise<string> {
  if (tail === '') return `keep needs a note: /${COMMAND} keep <text>`
  const { id, count } = await pin($, tail)
  return `pinned note ${id} (${count} pinned). It is kept verbatim through every compaction of this session.`
}

async function unpinText($: EngineInterface, tail: string): Promise<string> {
  const id = Number(tail)
  if (tail === '' || !Number.isInteger(id)) return `unpin needs a number: /${COMMAND} unpin <n>`
  return (await unpin($, id)) ? `note ${id} removed.` : `no pinned note ${id}.`
}

async function editText($: EngineInterface): Promise<string> {
  const current = await currentSummary($)
  if (typeof current === 'string') return `${current}.`
  scheduleEdit($)
  return editStarted(current.n)
}

/** `/compact-lens [verb] [rest]`. */
export async function runCommand($: EngineInterface, args: string, origin: PromptOrigin): Promise<CommandRunResult> {
  const trimmed = args.trim()
  const verb = trimmed.split(/\s+/)[0] ?? ''
  const tail = trimmed.slice(verb.length).trim()
  switch (verb) {
    case '':
    case 'open':
    case 'status':
      await $.ui.open({ id: PANE_ID, title: 'Compact Lens', focus: true })
      return { text: await statusText($) }
    case 'lost':
      return { text: await lostText($, tail) }
    case 'restore':
      return restoreReply($, tail)
    case 'edit':
      return { text: await editText($) }
    case 'show':
      return { text: await showText($, tail) }
    case 'list':
      return { text: await listText($) }
    case 'keep':
    case 'pin':
      return { text: await keepText($, tail) }
    case 'unpin':
      return { text: await unpinText($, tail) }
    case 'apply':
      return { text: await applyText($) }
    case 'cancel':
      return { text: await cancelText($) }
    case 'doctor':
      return { text: await doctorText($) }
    case 'prune':
      return { text: await pruneText($, tail, origin) }
    case 'statusline': {
      const text = await statuslineText($)
      await refreshStatus($)
      return { text }
    }
    default:
      return { text: HELP }
  }
}
