// The snapshot root made the person's alone, as Claude Code keeps the transcripts the snapshots copy:
// `chmod 700`, after `mkdir -m 700` where it is not there yet. Never a root that is no folder, leads to the
// home folder or above it, or holds files compact-lens did not write: their mode is the person's to set.
import type { EngineInterface, FsEntry, FsStat } from 'claude-code'

import { isHomeOrAbove, isOwnScript } from './paths'
import { isSessionName, snapshotFolder } from './prune'
import { NotStarted, runSystem } from './run'
import { snapshotRoot } from './session'

/** The mode that leaves a folder to its owner alone. */
const PRIVATE_MODE = '700'
/** What a snapshot root holds beside the session folders: the status-line script, its files, and Finder's file. */
const ROOT_EXTRAS: readonly string[] = ['statusline.pl', '.statusline', '.DS_Store']
/** How many names of someone else's files a reason lists. */
const NAMES_SHOWN = 3
/** The largest file read to see whether it is a copy of the status-line script, which is about 7 KB. */
const SCRIPT_COPY_MAX_BYTES = 65_536

/** Where the root stands: made private, left alone where no process can run, or not made private, and why. */
export type Privacy = { kind: 'private' } | { kind: 'unavailable' } | { kind: 'refused'; reason: string }

/** The last answer this load gave, for doctor; undefined before the first. */
let last: Privacy | undefined

export const lastPrivacy = (): Privacy | undefined => last

/**
 * Whether an entry of the root is compact-lens's: one of its extras, a folder named like a session, a
 * folder holding nothing but the mod's files, or a copy of the status-line script the person keeps under
 * another name (its second line is the mark). Only a folder not named like a session is looked into.
 */
async function isOwnEntry($: EngineInterface, root: string, entry: FsEntry): Promise<boolean> {
  if (ROOT_EXTRAS.includes(entry.name)) return true
  if (entry.kind === 'dir') return isSessionName(entry.name) || (await snapshotFolder($, root, entry.name)).isModFolder
  if (entry.kind !== 'file' || entry.size > SCRIPT_COPY_MAX_BYTES) return false
  const text = await $.fs.read(`${root}/${entry.name}`).catch(() => undefined)
  return text !== undefined && isOwnScript(text)
}

/** The names in the root that are not compact-lens's, sorted; undefined when it cannot be listed. */
async function strangersIn($: EngineInterface, root: string): Promise<string[] | undefined> {
  const entries = await $.fs.list(root).catch(() => undefined)
  if (entries === undefined) return undefined
  const own = await Promise.all(entries.map(entry => isOwnEntry($, root, entry)))
  return entries
    .filter((_, i) => !own[i])
    .map(entry => entry.name)
    .sort()
}

/** Why the root is not the mod's to change: no folder, one leading to the home folder or above, one that cannot be listed, or one holding files of someone else's; undefined when it is. */
async function refusalOf($: EngineInterface, root: string, found: FsStat): Promise<string | undefined> {
  if (found.kind !== 'dir') return 'it is not a folder'
  const home = (await $.env.get('HOME')) ?? ''
  if (found.realPath !== undefined && isHomeOrAbove(found.realPath, home)) return `it leads to ${found.realPath}, your home folder or a folder above it`
  const strangers = await strangersIn($, root)
  if (strangers === undefined) return 'it could not be listed'
  if (strangers.length === 0) return undefined
  const named = strangers.length > NAMES_SHOWN ? `${strangers.slice(0, NAMES_SHOWN).join(', ')} and ${strangers.length - NAMES_SHOWN} more` : strangers.join(', ')
  return `it holds files compact-lens did not write (${named}), so its mode was left as it is`
}

async function privacyOf($: EngineInterface): Promise<Privacy> {
  const root = await snapshotRoot($)
  const found = await $.fs.stat(root, { resolve: true }).catch(() => undefined)
  // A stat refused (a guard above the mod, a passing error) is no proof the folder is missing.
  if (found === undefined && (await $.fs.exists(root).catch(() => true))) return { kind: 'refused', reason: 'it could not be read' }
  const refusal = found === undefined ? undefined : await refusalOf($, root, found)
  if (refusal !== undefined) return { kind: 'refused', reason: refusal }
  try {
    if (found === undefined) await runSystem($, 'mkdir', ['-p', '-m', PRIVATE_MODE, root])
    // chmod after mkdir too: under -p, a folder someone made in between keeps the mode it had.
    await runSystem($, 'chmod', [PRIVATE_MODE, root])
    return { kind: 'private' }
  } catch (error) {
    if (error instanceof NotStarted) return { kind: 'unavailable' }
    return { kind: 'refused', reason: error instanceof Error ? error.message : String(error) }
  }
}

/** Makes the snapshot root the person's alone, creating it when it is not there; where it stands now. */
export async function makeRootPrivate($: EngineInterface): Promise<Privacy> {
  last = await privacyOf($)
  return last
}
