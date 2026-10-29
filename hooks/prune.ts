// Old snapshots: the session folders under the snapshot root, how old and how big each is, and which may
// go. A folder goes only when everything in it is the mod's (a session id for its name; compaction
// folders holding the files the mod writes, and its own files beside them), it is not this session's,
// neither it nor its session's transcript nor its status-line script's files changed for the days asked,
// and it holds no edit of the person's. Where the transcript is gone (Claude Code deletes it after
// cleanupPeriodDays), the snapshots may be the only copy: a prune says so, and keepDays never removes them.
import type { EngineInterface, FsEntry, PromptOrigin } from 'claude-code'

import { config } from './config'
import { plural } from './notes'
import type { CompactLensRecord } from '../types'
import { DAY_MS, DEFAULT_CLEANUP_DAYS, projectsDir, SUMMARY_HEAD_CHARS } from './paths'
import { hashOf, isRecordedSummary, parseRecord } from './records'
import { shortTime } from './report'
import { NotStarted, runSystem } from './run'
import { log, snapshotRoot } from './session'
import { COMMAND_LINE, sizeText } from './texts'

/** A session id as Claude Code spells one: no other folder is ever removed. */
const SESSION_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const SESSION_NAME = new RegExp(`^${SESSION_ID}$`)
/** A status file the mod or its script keeps for a session under `.statusline/`, or the script's temporary copy of one. */
const STATUS_FILE = new RegExp(`^(${SESSION_ID})\\.(?:json|count)(?:\\.\\d+)?$`)
/** A compaction's folder, as the mod numbers them. */
const COMPACTION_FOLDER = /^\d{2,}$/
const RECORD_FILE = 'meta.json'
const SUMMARY_FILE = 'summary.md'
const MARK_FILE = 'summary.hash'
const AFTER_FILE = 'after.md'
const UNUSED_DRAFT = 'draft-unused.md'
/** Every file any version of the mod writes in a compaction folder. */
const COMPACTION_FILES: readonly string[] = ['before.md', 'before.json', SUMMARY_FILE, AFTER_FILE, 'lost.md', RECORD_FILE, MARK_FILE, UNUSED_DRAFT]
/** An edit kept aside: beside a compaction's files when it was not applied, or beside the folders when it could not be saved. */
const KEPT_EDIT = /^edit-(?:unapplied|unsaved)-\d{8}-\d{6}-\d{3}(?:-\d+)?\.md$/
/** The files the mod keeps beside the compaction folders, and Finder's, which says nothing of whose a folder is. */
const DRAFT_FILE = 'draft.md'
const MOD_FILES: readonly string[] = ['pinned.md', DRAFT_FILE]
const FINDER_FILE = '.DS_Store'
const TRANSCRIPT_SUFFIX = '.jsonl'
/** The prompts that are the person's own: the prompt box, and their Remote Control. A `claude -p`, which the model can run, is not. */
const PERSONAL_ORIGINS: ReadonlyArray<PromptOrigin['kind']> = ['composer', 'bridge']
/** Where a refused confirm came from, in words; any other kind is named as the engine names it. */
const ORIGIN_NAMES: Partial<Record<PromptOrigin['kind'], string>> = {
  sdk: 'claude -p or the Agent SDK',
  peer: 'another Claude session',
  'peer-send-message': 'another Claude session',
  plugin: 'a plugin',
}
/** How many hex digits of the listed names' hash a confirm carries. */
const CODE_DIGITS = 6
const CONFIRM_CODE = new RegExp(`^[0-9a-f]{${CODE_DIGITS}}$`)

/** A compaction folder: its number's name and the names of its files. */
type Compaction = { name: string; files: readonly string[] }

/** One folder under the snapshot root. */
export type SnapshotFolder = {
  name: string
  path: string
  /** Its newest file's time, the compaction folders' files included. */
  newestMs: number
  bytes: number
  /** Whether everything in it is the mod's: compaction folders holding the mod's files alone, its own files beside them. */
  isModFolder: boolean
  /** Whether anything in it is the mod's, or looks it (a numbered folder): one that is not wholly the mod's is listed apart, never removed. */
  hasModEntry: boolean
  /** Its compaction folders, lowest number first. */
  compactions: readonly Compaction[]
  /** Whether draft.md holds a draft, or an edit was kept aside in it. */
  hasDraftOrKeptEdit: boolean
}

const isCompactionFile = (entry: FsEntry): boolean =>
  entry.kind === 'file' && (COMPACTION_FILES.includes(entry.name) || KEPT_EDIT.test(entry.name) || entry.name === FINDER_FILE)

/** A compaction folder of the mod's: numbered, and holding nothing but files the mod writes there. */
const isCompactionFolder = (entry: FsEntry, inner: readonly FsEntry[] | undefined): boolean =>
  entry.kind === 'dir' && COMPACTION_FOLDER.test(entry.name) && inner !== undefined && inner.every(isCompactionFile)

const isModFile = (entry: FsEntry): boolean => entry.kind === 'file' && (MOD_FILES.includes(entry.name) || KEPT_EDIT.test(entry.name))
const isFinderFile = (entry: FsEntry): boolean => entry.kind === 'file' && entry.name === FINDER_FILE

/** Whether a folder's entries hold a draft or an edit kept aside. */
const holdsDraftOrKeptEdit = (entries: readonly FsEntry[], compactions: readonly Compaction[]): boolean =>
  entries.some(entry => entry.kind === 'file' && ((entry.name === DRAFT_FILE && entry.size > 0) || KEPT_EDIT.test(entry.name))) ||
  compactions.some(compaction => compaction.files.some(name => name === UNUSED_DRAFT || KEPT_EDIT.test(name)))

/** A folder under the snapshot root: its files and those of the folders in it. */
export async function snapshotFolder($: EngineInterface, root: string, name: string): Promise<SnapshotFolder> {
  const path = `${root}/${name}`
  const entries = (await $.fs.list(path).catch(() => undefined)) ?? []
  const inner = await Promise.all(entries.map(entry => (entry.kind === 'dir' ? $.fs.list(`${path}/${entry.name}`).catch(() => undefined) : Promise.resolve([]))))
  const files = [...entries, ...inner.flatMap(list => list ?? [])].filter(entry => entry.kind === 'file')
  const compactions = entries
    .flatMap((entry, i) => (isCompactionFolder(entry, inner[i]) ? [{ name: entry.name, files: (inner[i] ?? []).map(file => file.name) }] : []))
    .sort((a, b) => Number(a.name) - Number(b.name))
  const isOwn = (entry: FsEntry, i: number): boolean => isCompactionFolder(entry, inner[i]) || isModFile(entry)
  return {
    name,
    path,
    newestMs: files.reduce((newest, file) => Math.max(newest, file.mtimeMs), 0),
    bytes: files.reduce((sum, file) => sum + file.size, 0),
    isModFolder: entries.some(isOwn) && entries.every((entry, i) => isOwn(entry, i) || isFinderFile(entry)),
    hasModEntry: entries.some(entry => isModFile(entry) || (entry.kind === 'dir' && COMPACTION_FOLDER.test(entry.name))),
    compactions,
    hasDraftOrKeptEdit: holdsDraftOrKeptEdit(entries, compactions),
  }
}

/** The folders under the snapshot root, but the hidden ones; undefined when the root is not there yet. */
export async function snapshotFolders($: EngineInterface, root: string): Promise<SnapshotFolder[] | undefined> {
  const entries = await $.fs.list(root).catch(() => undefined)
  if (entries === undefined) return undefined
  const folders = entries.filter(entry => entry.kind === 'dir' && !entry.name.startsWith('.'))
  return Promise.all(folders.map(entry => snapshotFolder($, root, entry.name)))
}

/** Whether a name is a session id, as the session folders are named. */
export const isSessionName = (name: string): boolean => SESSION_NAME.test(name)

/** Claude Code's cleanupPeriodDays, a whole number of days from 1 up; its default where the settings hold none. Read from the merged object: 2.1.299's read of one key passes no hook. */
export async function cleanupDaysOf($: EngineInterface): Promise<number> {
  const days = (await $.settings.read().catch(() => undefined))?.['cleanupPeriodDays']
  return typeof days === 'number' && Number.isInteger(days) && days > 0 ? days : DEFAULT_CLEANUP_DAYS
}

/** Each session's transcript time, or the folder that could not be listed: then any session there could look old. */
type Transcripts = { times: ReadonlyMap<string, number> } | { unlisted: string }

/** The transcripts in one projects folder, each project folder in it listed. */
async function transcriptsIn($: EngineInterface, projects: string): Promise<Transcripts> {
  const folders = await $.fs.list(projects).catch(() => undefined)
  if (folders === undefined) return { unlisted: projects }
  const listed = await Promise.all(
    folders.filter(entry => entry.kind !== 'file').map(async entry => ({ entry, files: await $.fs.list(`${projects}/${entry.name}`).catch(() => undefined) })),
  )
  const failed = listed.find(({ entry, files }) => entry.kind === 'dir' && files === undefined)
  if (failed !== undefined) return { unlisted: `${projects}/${failed.entry.name}` }
  const times = new Map<string, number>()
  for (const file of listed.flatMap(({ files }) => files ?? [])) {
    if (file.kind === 'dir' || !file.name.endsWith(TRANSCRIPT_SUFFIX)) continue
    const id = file.name.slice(0, -TRANSCRIPT_SUFFIX.length)
    // A transcript that is a link: its own time says nothing of the session's, so it counts as in use.
    times.set(id, Math.max(times.get(id) ?? 0, file.kind === 'file' ? file.mtimeMs : Number.POSITIVE_INFINITY))
  }
  return { times }
}

/** Every projects folder Claude Code may keep transcripts in: this session's config folder's, the default one's, and each `.claude*` folder's in the home folder. */
async function projectsFolders($: EngineInterface): Promise<string[]> {
  const home = (await $.env.get('HOME')) ?? ''
  const configs = ((await $.fs.list(home).catch(() => undefined)) ?? []).filter(entry => entry.kind === 'dir' && entry.name.startsWith('.claude'))
  return [...new Set([projectsDir(home, await $.env.get('CLAUDE_CONFIG_DIR')), projectsDir(home, undefined), ...configs.map(entry => `${home}/${entry.name}/projects`)])]
}

/** Every transcript Claude Code keeps in those folders. */
async function transcriptTimes($: EngineInterface): Promise<Transcripts> {
  const merged = new Map<string, number>()
  for (const folder of await projectsFolders($)) {
    if (!(await $.fs.exists(folder))) continue
    const found = await transcriptsIn($, folder)
    if ('unlisted' in found) return found
    for (const [id, at] of found.times) merged.set(id, Math.max(merged.get(id) ?? 0, at))
  }
  return { times: merged }
}

/** The session a status file under `.statusline/` belongs to; '' for anything else. */
const statusIdOf = (entry: FsEntry): string => (entry.kind === 'file' ? (STATUS_FILE.exec(entry.name)?.[1] ?? '') : '')

/** The status files under `.statusline/`; undefined when the folder is there and cannot be listed. */
async function statusEntries($: EngineInterface, root: string): Promise<FsEntry[] | undefined> {
  const folder = `${root}/.statusline`
  const entries = await $.fs.list(folder).catch(() => undefined)
  if (entries !== undefined) return entries
  return (await $.fs.exists(folder)) ? undefined : []
}

/** One compaction folder's number and path, its summary.md, its record and its mark, as far as they are there and could be read. */
type SummaryFacts = {
  n: number
  dir: string
  summary: string
  /** summary.md is there and could not be read: it may hold an edit. */
  isUnreadable: boolean
  record: CompactLensRecord | undefined
  mark: string | undefined
  hasAfter: boolean
}

async function summaryFacts($: EngineInterface, folder: SnapshotFolder, compaction: Compaction): Promise<SummaryFacts> {
  const dir = `${folder.path}/${compaction.name}`
  // null: the file is there and could not be read; undefined: it is not there.
  const readIf = (name: string): Promise<string | null | undefined> =>
    compaction.files.includes(name) ? $.fs.read(`${dir}/${name}`).catch(() => null) : Promise.resolve(undefined)
  const [summary, meta, mark] = await Promise.all([readIf(SUMMARY_FILE), readIf(RECORD_FILE), readIf(MARK_FILE)])
  return {
    n: Number(compaction.name),
    dir,
    summary: summary ?? '',
    isUnreadable: summary === null,
    record: typeof meta === 'string' ? parseRecord(meta) : undefined,
    mark: mark ?? undefined,
    hasAfter: compaction.files.includes(AFTER_FILE),
  }
}

/** Whether a text is the whole summary a record names by its hash, as written or trimmed, as an apply sends it. */
const isNamedBy = (text: string, record: CompactLensRecord): boolean =>
  record.summaryHash !== undefined && (isRecordedSummary(text, record) || isRecordedSummary(text.trim(), record))

/** How far before a message's text its heading is looked for: `## <k> · user` and the blank line after it. */
const HEADING_REACH = 40

/**
 * Whether after.md, as 0.1.0 and 0.2.0 wrote it (each message under `## <k> · <role>`, its text trimmed,
 * the next heading or the file's end after it), holds `text` as the whole of a user message: a summary cut
 * short still stands in it, but never followed by the next message's heading, which comes once only.
 * A summary that quotes that heading, cut where the quote begins, is followed by it twice.
 */
const holdsWholeMessage = (after: string, text: string): boolean => {
  const body = `\n\n${text.trim()}\n`
  for (let at = after.indexOf(body); at >= 0; at = after.indexOf(body, at + 1)) {
    const heading = /## (\d+) · user$/.exec(after.slice(Math.max(0, at - HEADING_REACH), at))
    if (heading === null) continue
    const rest = after.slice(at + body.length)
    const next = `\n## ${Number(heading[1]) + 1} · `
    if (rest === '' || (rest.startsWith(next) && rest.indexOf(next, 1) < 0)) return true
  }
  return false
}

/**
 * Whether a summary.md is the summary its compaction wrote. A record with a hash names it whole. A record
 * from before 0.3.0 names its first SUMMARY_HEAD_CHARS characters alone, so the text must be all of a
 * shorter opening, or the whole of the summary's message in after.md, where those versions wrote it.
 * Without a record, the mark written beside it names it.
 */
async function isAsWritten($: EngineInterface, { dir, summary, record, mark, hasAfter }: SummaryFacts): Promise<boolean> {
  if (record === undefined) return mark !== undefined && mark.trim() === hashOf(summary)
  if (record.summaryHash !== undefined) return isNamedBy(summary, record)
  if (summary === record.summaryHead && summary.length < SUMMARY_HEAD_CHARS) return true
  if (!hasAfter || !summary.startsWith(record.summaryHead)) return false
  const after = await $.fs.read(`${dir}/${AFTER_FILE}`).catch(() => undefined)
  return after !== undefined && holdsWholeMessage(after, summary)
}

/**
 * Whether a folder may hold an edit of the person's: a draft, an edit kept aside, a summary.md that could
 * not be read, or one in any compaction folder that is not the summary that compaction wrote and that no
 * later compaction applied.
 */
async function holdsEdit($: EngineInterface, folder: SnapshotFolder): Promise<boolean> {
  if (folder.hasDraftOrKeptEdit) return true
  const facts = await Promise.all(folder.compactions.map(compaction => summaryFacts($, folder, compaction)))
  if (facts.some(fact => fact.isUnreadable)) return true
  const records = facts.flatMap(fact => (fact.record === undefined ? [] : [fact.record]))
  const isApplied = (fact: SummaryFacts): boolean => records.some(later => later.n > fact.n && isNamedBy(fact.summary, later))
  const open = facts.filter(fact => fact.summary.trim() !== '' && !isApplied(fact))
  const written = await Promise.all(open.map(fact => isAsWritten($, fact)))
  return written.some(isWritten => !isWritten)
}

/** What a prune would remove, and what it keeps, and why. */
export type PrunePlan = {
  days: number
  /** Claude Code's cleanupPeriodDays: a transcript older counts as gone, as Claude Code deletes it. */
  cleanupDays: number
  /** Old folders whose session's transcript is still there. */
  copies: readonly SnapshotFolder[]
  /** Old folders whose session's transcript is not found, or older than cleanupDays: the snapshots may be the only copy. */
  onlyCopies: readonly SnapshotFolder[]
  /** Old folders kept, as each may hold an edit of the person's. */
  edited: readonly SnapshotFolder[]
  /** Old session folders kept, as each holds files the mod did not write. */
  foreign: readonly SnapshotFolder[]
  /** The status files of sessions idle that long. */
  statusFiles: readonly string[]
}

const byName = (a: SnapshotFolder, b: SnapshotFolder): number => a.name.localeCompare(b.name)
const goingOf = (plan: PrunePlan): SnapshotFolder[] => [...plan.copies, ...plan.onlyCopies]
const keptCount = (plan: PrunePlan): number => plan.edited.length + plan.foreign.length
const unlistedText = (path: string): string => `nothing was removed: ${path} could not be listed, so a session still in use there would look old`

/** What a prune of everything untouched for `days` days would remove; the reason it cannot tell otherwise. */
async function planPrune($: EngineInterface, days: number): Promise<PrunePlan | string> {
  const root = await snapshotRoot($)
  const folders = await snapshotFolders($, root)
  if (folders === undefined) return `there are no snapshots yet: ${root} is not there`
  const [found, statuses, cleanupDays] = await Promise.all([transcriptTimes($), statusEntries($, root), cleanupDaysOf($)])
  if ('unlisted' in found) return unlistedText(found.unlisted)
  if (statuses === undefined) return unlistedText(`${root}/.statusline`)
  const nowMs = await $.clock.now()
  const cutoffMs = nowMs - days * DAY_MS
  // A transcript that old goes at Claude Code's next cleanup: the snapshots are then the only copy.
  const isCopy = (folder: SnapshotFolder): boolean => (found.times.get(folder.name) ?? 0) >= nowMs - cleanupDays * DAY_MS
  const currentId = await $.session.id()
  const onScreen = new Set(statuses.filter(entry => entry.mtimeMs >= cutoffMs).map(statusIdOf))
  const isIdle = (id: string): boolean => id !== '' && id !== currentId && !onScreen.has(id) && (found.times.get(id) ?? 0) < cutoffMs
  const old = folders.filter(folder => isSessionName(folder.name) && folder.newestMs < cutoffMs && isIdle(folder.name)).sort(byName)
  const own = old.filter(folder => folder.isModFolder)
  const holds = await Promise.all(own.map(folder => holdsEdit($, folder)))
  const free = own.filter((_, i) => !holds[i])
  return {
    days,
    cleanupDays,
    copies: free.filter(isCopy),
    onlyCopies: free.filter(folder => !isCopy(folder)),
    edited: own.filter((_, i) => holds[i]),
    foreign: old.filter(folder => !folder.isModFolder && folder.hasModEntry),
    statusFiles: statuses.filter(entry => entry.mtimeMs < cutoffMs && isIdle(statusIdOf(entry))).map(entry => `${root}/.statusline/${entry.name}`),
  }
}

/** Removes a path with the host's rm; rejects with the reason when rm fails. */
async function removePath($: EngineInterface, path: string): Promise<void> {
  await runSystem($, 'rm', ['-rf', '--', path])
}

/** What a prune did: the folders removed, those it could not remove, with the reason, and whether rm could not start at all. */
type Removal = { removed: readonly SnapshotFolder[]; failed: ReadonlyArray<{ path: string; reason: string }>; isUnavailable: boolean }

/** Removes the folders, one by one, then the status files; a status file left behind is harmless. Where rm cannot start, it stops at once. */
async function carryOut($: EngineInterface, folders: readonly SnapshotFolder[], statusFiles: readonly string[]): Promise<Removal> {
  const removed: SnapshotFolder[] = []
  const failed: Array<{ path: string; reason: string }> = []
  for (const folder of folders) {
    try {
      await removePath($, folder.path)
      removed.push(folder)
    } catch (error) {
      if (error instanceof NotStarted) return { removed, failed, isUnavailable: true }
      failed.push({ path: folder.path, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  for (const path of statusFiles) await removePath($, path).catch(() => undefined)
  return { removed, failed, isUnavailable: false }
}

const totalOf = (folders: readonly SnapshotFolder[]): number => folders.reduce((sum, folder) => sum + folder.bytes, 0)
const folderLine = (folder: SnapshotFolder): string => `  ${folder.name} · last written ${shortTime(new Date(folder.newestMs).toISOString())} · ${sizeText(folder.bytes)}`

/** The code a confirm carries: a hash of the folders that would go and the group each was listed in, so a confirm removes only what the list showed, as it showed it. */
export const confirmCode = (plan: PrunePlan): string => {
  const listed = [...plan.copies.map(folder => `copy ${folder.name}`), ...plan.onlyCopies.map(folder => `only ${folder.name}`)]
  const hash = hashOf(listed.join('\n'))
  return hash.slice(hash.indexOf('-') + 1).padStart(CODE_DIGITS, '0').slice(0, CODE_DIGITS)
}

/** A group of the preview: its heading and a line a folder; nothing when it is empty. */
const group = (heading: string, folders: readonly SnapshotFolder[]): string[] => (folders.length === 0 ? [] : [heading, ...folders.map(folderLine)])

const nothingText = (plan: PrunePlan): string => {
  const kept = keptCount(plan)
  return kept > 0
    ? `no session's snapshots can go: the ${kept === 1 ? 'one' : kept} older than ${plan.days} days ${kept === 1 ? 'is' : 'are'} kept, as ${COMMAND_LINE} prune ${plan.days} lists`
    : `no session's snapshots can go: none older than ${plan.days} days is compact-lens's alone and idle (this session's folder, and one whose transcript or status-line script changed since, are kept too)`
}

export const PRUNE_USAGE = `prune takes a number of days, as in ${COMMAND_LINE} prune 30: it lists what would go, and the confirm that removes it`

const ONLY_COPIES_NOTE = 'Claude Code deletes a transcript that old, and a session run with a CLAUDE_CONFIG_DIR other than a ~/.claude* folder keeps its transcript there'
const KEPT_EDIT_HEADING = 'kept, as each may hold an edit not applied yet (a changed summary.md, a draft.md, or an edit set aside); remove one by hand once you no longer need it:'
const KEPT_FOREIGN_HEADING = 'kept, holding files compact-lens did not write; remove one by hand if it should go:'

/** What `prune <days>` would remove and keep, in groups, and the command that removes it. */
export const previewText = (plan: PrunePlan): string => {
  const going = goingOf(plan)
  if (going.length === 0 && keptCount(plan) === 0) return nothingText(plan)
  const them = going.length === 1 ? 'that session' : `those ${going.length} sessions`
  const confirm = `${COMMAND_LINE} prune ${plan.days} confirm ${confirmCode(plan)} removes the snapshots of ${them}${keptCount(plan) > 0 ? ' (the kept ones stay)' : ''}; nothing brings them back.`
  return [
    `Sessions untouched for more than ${plan.days} days:`,
    ...group(`transcript still there, so compact-lens can read these compactions again (${sizeText(totalOf(plan.copies))}):`, plan.copies),
    ...group(
      `transcript gone or older than cleanupPeriodDays (${plan.cleanupDays} days), so these snapshots may be the only copy (${sizeText(totalOf(plan.onlyCopies))}); ${ONLY_COPIES_NOTE}:`,
      plan.onlyCopies,
    ),
    ...group(KEPT_EDIT_HEADING, plan.edited),
    ...group(KEPT_FOREIGN_HEADING, plan.foreign),
    ...(going.length === 0 ? [] : [confirm]),
  ].join('\n')
}

const NO_PROGRAMS = 'this session runs no programs, so rm could not start; run the prune in a session in a terminal'

/** What `prune <days> confirm <code>` removed, and what it could not. */
export const removalText = ({ removed, failed, isUnavailable }: Removal): string => {
  if (isUnavailable && removed.length === 0) return `nothing was removed: ${NO_PROGRAMS}`
  const done = removed.length === 0 ? [] : [`removed the snapshots of ${plural(removed.length, 'session')} (${sizeText(totalOf(removed))}): ${removed.map(folder => folder.name).join(', ')}`]
  const stopped = isUnavailable ? [`the rest stay: ${NO_PROGRAMS}`] : []
  return [...done, ...failed.map(({ path, reason }) => `could not remove ${path}: ${reason}`), ...stopped].join('\n')
}

/** Why a confirm removes nothing: it came from someone other than the person, there is nothing to remove, or its code is not the list's; undefined when it may go ahead. */
const refusalOf = (plan: PrunePlan, code: string | undefined, origin: PromptOrigin): string | undefined => {
  if (!PERSONAL_ORIGINS.includes(origin.kind)) {
    return `nothing was removed: a prune is confirmed by you, at the prompt or over Remote Control; this one came from ${ORIGIN_NAMES[origin.kind] ?? origin.kind}`
  }
  if (goingOf(plan).length === 0) return nothingText(plan)
  if (code === undefined) return `nothing was removed: confirm takes the code the list gives, as in ${COMMAND_LINE} prune ${plan.days} confirm ${confirmCode(plan)}\n${previewText(plan)}`
  if (code !== confirmCode(plan)) return `nothing was removed: the list changed since that code; here it is now\n${previewText(plan)}`
  return undefined
}

/** `/compact-lens prune <days> [confirm <code>]`: the person's own confirm, with the code the list gave, removes what it lists. */
export async function pruneText($: EngineInterface, tail: string, origin: PromptOrigin): Promise<string> {
  const [first = '', second, code, ...rest] = tail.split(/\s+/).filter(word => word !== '')
  const days = /^\d+$/.test(first) ? Number(first) : 0
  const isConfirm = second === 'confirm'
  if (days <= 0 || rest.length > 0 || (second !== undefined && !isConfirm) || (code !== undefined && !CONFIRM_CODE.test(code))) return PRUNE_USAGE
  const plan = await planPrune($, days)
  if (typeof plan === 'string') return plan
  if (!isConfirm) return previewText(plan)
  return refusalOf(plan, code, origin) ?? removalText(await carryOut($, goingOf(plan), plan.statusFiles))
}

/** The keepDays option at start: the old sessions whose transcripts are still there go, a toast says so, and a failure is logged. */
export async function autoPrune($: EngineInterface): Promise<void> {
  const days = config().keepDays
  if (days <= 0) return
  try {
    const plan = await planPrune($, days)
    if (typeof plan === 'string') {
      if (!plan.startsWith('there are no snapshots')) log($, `keepDays: ${plan}`)
      return
    }
    const { removed, failed } = await carryOut($, plan.copies, plan.statusFiles)
    if (removed.length > 0) $.ui.toast(`removed the snapshots of ${plural(removed.length, 'session')} untouched for more than ${days} days (${sizeText(totalOf(removed))}); the keepDays option sets how long they stay`)
    failed.forEach(({ path, reason }) => log($, `could not remove ${path}: ${reason}`))
  } catch (error) {
    log($, `old snapshots were not removed (${String(error)})`)
  }
}
