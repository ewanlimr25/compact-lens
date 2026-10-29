// `/compact-lens doctor`: what the mod sees of its own setup, a check a line, so "nothing shows" has an
// answer: the versions and the folder the mod loaded from, the transcript and its count, the status
// line, perl, the dir option and the snapshot folder's privacy, the snapshots and the status-line script.
import type { EngineInterface } from 'claude-code'

import { config, MIN_KEEP_DAYS } from './config'
import type { TranscriptState } from './history'
import { syncHistory } from './history'
import type { Privacy } from './privacy'
import { lastPrivacy } from './privacy'
import { cleanupDaysOf, snapshotFolders } from './prune'
import { outputLines, PERL_PROBE } from './reader'
import { ensureSession, rootProblem, snapshotRoot } from './session'
import { getContext, getPins, getRecords, getTranscript, isApplyPending } from './state'
import type { ScriptState } from './statusline'
import { scriptPath, scriptState } from './statusline'
import { plural } from './notes'
import { COMMAND_LINE, sizeText, statusLineText } from './texts'
import { engineVersion, ownVersion } from './version'

/** What the snapshot folder holds: the mod's session folders and their size; undefined when it is not there yet. */
type Snapshots = { root: string; sessions: number; bytes: number } | { root: string; sessions: undefined; bytes: 0 }

export type DoctorFacts = {
  version: string | undefined
  engine: string | undefined
  /** The folder Claude Code loaded the mod from: of two installs, it loads one, and this says which. */
  root: string
  transcript: { state: TranscriptState; path: string | null; boundaries: number | null }
  records: number
  /** The status line's text; undefined when the option turns it off. */
  statusLine: string | undefined
  /** perl's version; undefined where it cannot run. */
  perl: string | undefined
  snapshots: Snapshots
  /** Why the dir option was set aside for the default folder; undefined when it was not. */
  dirProblem: string | undefined
  /** Whether the start made the snapshot folder private; undefined before it tried. */
  privacy: Privacy | undefined
  keepDays: number
  /** Claude Code's cleanupPeriodDays: a transcript older goes, and keepDays keeps an only copy. */
  cleanupDays: number
  script: { path: string; state: ScriptState }
}

const transcriptLine = ({ transcript, records }: DoctorFacts): string => {
  if (transcript.state === 'missing') return "– transcript: none yet; Claude Code writes it with the session's first message"
  if (transcript.state === 'unreadable') return '✗ transcript: could not be read (the dim log line says why); only the compactions the mod saw run are counted'
  const count = transcript.boundaries ?? 0
  const recorded = records >= count ? `all ${count} are recorded` : `${records} of them are recorded`
  return `${records >= count ? '✓' : '✗'} transcript: ${transcript.path ?? '(unknown)'} holds ${plural(count, 'compaction')}; ${recorded}`
}

/** keepDays at or past cleanupPeriodDays: every session it would remove has lost its transcript, so its snapshots are an only copy, which it keeps. */
const idleKeepText = (keepDays: number, cleanupDays: number): string =>
  `keepDays (${keepDays}) removes no snapshots: Claude Code deletes a transcript after ${cleanupDays} days (cleanupPeriodDays), and keepDays keeps the snapshots of a session whose transcript is that old or gone, as their only copy` +
  (cleanupDays > MIN_KEEP_DAYS ? `; set it under ${cleanupDays}` : '')

const snapshotLine = ({ snapshots, keepDays, cleanupDays }: DoctorFacts): string => {
  if (snapshots.sessions === undefined) return `– snapshots: ${snapshots.root}: none yet`
  const held = `${snapshots.root}: ${plural(snapshots.sessions, 'session')}, ${sizeText(snapshots.bytes)}`
  if (keepDays > 0 && keepDays >= cleanupDays) return `– snapshots: ${held}; ${idleKeepText(keepDays, cleanupDays)}`
  const rule =
    keepDays > 0 ? `sessions untouched for ${keepDays} days are removed at start while their transcripts are still there (keepDays)` : `kept until you prune them (${COMMAND_LINE} prune <days>)`
  return `✓ snapshots: ${held}; ${rule}`
}

const dirLines = ({ dirProblem, snapshots }: DoctorFacts): string[] => (dirProblem === undefined ? [] : [`✗ ${dirProblem}; snapshots go to ${snapshots.root} instead`])

const privacyLines = ({ privacy, snapshots }: DoctorFacts): string[] => (privacy?.kind === 'refused' ? [`✗ ${snapshots.root} was not made private: ${privacy.reason}`] : [])

const scriptLine = ({ script, privacy }: DoctorFacts): string => {
  if (script.state === 'current') return `✓ status-line script: ${script.path}, current`
  if (script.state === 'stale' && privacy?.kind === 'refused') return `– status-line script: ${script.path} differs from this version's, and is not updated while the folder is not made private`
  if (script.state === 'stale') return `– status-line script: ${script.path} differs from this version's; a session start of the version you want replaces it`
  if (script.state === 'foreign') return `✗ status-line script: ${script.path} is not compact-lens's; move it, then ${COMMAND_LINE} statusline`
  return `– status-line script: not installed; ${COMMAND_LINE} statusline puts the count in your own status line (ccstatusline or Claude Code's)`
}

/** The doctor's reply: a heading with the versions, then one line a check, ✓ fine, – worth knowing, ✗ wrong. */
export const formatDoctor = (facts: DoctorFacts): string =>
  [
    `compact-lens ${facts.version ?? '(version unknown)'} on Claude Code ${facts.engine ?? '(version unknown)'}, loaded from ${facts.root}`,
    transcriptLine(facts),
    facts.statusLine === undefined
      ? `– status line: off (the statusLine option); ${COMMAND_LINE} statusline can show the count in your own status line`
      : `✓ status line: the mod sets "${facts.statusLine}"; if it does not show under the prompt, ${COMMAND_LINE} statusline puts the count in your own status line`,
    facts.perl === undefined ? '– perl: not found; grep reads the transcript instead, more slowly on a large one' : `✓ perl ${facts.perl}: a search takes one pass over the transcript`,
    ...dirLines(facts),
    ...privacyLines(facts),
    snapshotLine(facts),
    scriptLine(facts),
  ].join('\n')

/** perl's version, or undefined where it cannot run. */
async function perlVersion($: EngineInterface): Promise<string | undefined> {
  try {
    const first = (await outputLines($, ['perl', '-e', PERL_PROBE]))[0]?.trim() ?? ''
    return first === '' ? undefined : first
  } catch {
    return undefined
  }
}

/** The session folders under the snapshot root that hold anything of the mod's, counted and sized. */
async function snapshotsOf($: EngineInterface, root: string): Promise<Snapshots> {
  const folders = (await snapshotFolders($, root))?.filter(folder => folder.hasModEntry)
  if (folders === undefined || folders.length === 0) return { root, sessions: undefined, bytes: 0 }
  return { root, sessions: folders.length, bytes: folders.reduce((sum, folder) => sum + folder.bytes, 0) }
}

/** The status line's text as the mod sets it now; undefined when the option turns it off. */
async function statusLineNow($: EngineInterface): Promise<string | undefined> {
  if (!config().statusLine) return undefined
  const [context, records, pins, isPending] = await Promise.all([getContext($), getRecords($), getPins($), isApplyPending($)])
  return statusLineText({ context, records, pinCount: pins.length, isPending })
}

/** `/compact-lens doctor`. */
export async function doctorText($: EngineInterface): Promise<string> {
  await ensureSession($)
  const synced = await syncHistory($)
  const root = await snapshotRoot($)
  const [version, engine, path, records, statusLine, perl, snapshots, script, dirProblem, cleanupDays] = await Promise.all([
    ownVersion($),
    engineVersion($),
    getTranscript($),
    getRecords($),
    statusLineNow($),
    perlVersion($),
    snapshotsOf($, root),
    scriptState($, root),
    rootProblem($),
    cleanupDaysOf($),
  ])
  return formatDoctor({
    version,
    engine,
    root: $.plugin.root,
    transcript: { state: synced.transcript, path, boundaries: synced.boundaryCount },
    records: records.length,
    statusLine,
    perl,
    snapshots,
    dirProblem,
    privacy: lastPrivacy(),
    keepDays: config().keepDays,
    cleanupDays,
    script: { path: scriptPath(root), state: script },
  })
}
