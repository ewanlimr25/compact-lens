// The count in a status line of the person's own (ccstatusline's Custom Command widget, or Claude Code's
// statusLine command): the script the mod carries in bin/, copied where its path stays put across
// updates, and kept current there once the person has asked for it.
import type { EngineInterface } from 'claude-code'

import { isOwnScript, SCRIPT_RECHECK_MS } from './paths'
import { makeRootPrivate } from './privacy'
import { log, snapshotRoot } from './session'

/** Where the script lies under the snapshot root: beside the session folders, so it finds them. */
export const scriptPath = (root: string): string => `${root}/statusline.pl`

/** The copy under the snapshot root: this version's, an older one of compact-lens's, a file of someone else's, or none. */
export type ScriptState = 'current' | 'stale' | 'foreign' | 'missing'

/** The session's status as the script reads it: written under `.statusline/`, named by the session id. */
export const statusFilePath = (root: string, sessionId: string): string => `${root}/.statusline/${sessionId}.json`

/** What the script adds to its count: the pinned notes and a waiting edit (the count is the mod's own, for a reader without the transcript). */
export type ScriptStatus = { compactions: number; pinned: number; pending: boolean }

/** Whether the person installed the script: only then does the mod write the session's status for it. Set at start and on install. */
let isInstalled = false
/** When the mod last looked for the script, so a session that found none looks again now and then, not at every change. */
let lastCheckedMs: number | undefined
/** The status file last written and its text, so an unchanged status is not written again. */
let lastWritten: { path: string; text: string } | undefined

/** The script this version of the mod carries; undefined where it cannot be read. */
export async function bundledScript($: EngineInterface): Promise<string | undefined> {
  return $.fs.read(`${$.plugin.root}/bin/statusline.pl`).catch(() => undefined)
}

/** The state of the copy under the snapshot root. */
export async function scriptState($: EngineInterface, root: string): Promise<ScriptState> {
  const installed = await $.fs.read(scriptPath(root)).catch(() => undefined)
  if (installed === undefined) return 'missing'
  if (!isOwnScript(installed)) return 'foreign'
  return installed === (await bundledScript($)) ? 'current' : 'stale'
}

/** Whether compact-lens's script is installed; while it is not, looked for again once a SCRIPT_RECHECK_MS at most. */
async function isScriptThere($: EngineInterface): Promise<boolean> {
  if (isInstalled) return true
  const now = await $.clock.now()
  if (lastCheckedMs !== undefined && now - lastCheckedMs < SCRIPT_RECHECK_MS) return false
  lastCheckedMs = now
  const installed = await $.fs.read(scriptPath(await snapshotRoot($))).catch(() => undefined)
  isInstalled = installed !== undefined && isOwnScript(installed)
  return isInstalled
}

/**
 * Writes the session's status for the script, when it is installed and the status changed. A write that
 * fails is logged once and tried again at the next change: the pins and the status line never wait on it.
 */
export async function writeStatusFile($: EngineInterface, status: ScriptStatus): Promise<void> {
  if (!(await isScriptThere($))) return
  const path = statusFilePath(await snapshotRoot($), await $.session.id())
  const text = JSON.stringify(status)
  if (lastWritten?.path === path && lastWritten.text === text) return
  lastWritten = { path, text }
  await $.fs.write(path, text).catch(error => log($, `${path} was not written for the status-line script (${String(error)})`))
}

/** At start, in a private snapshot root: notes whether the script is installed, and replaces a copy an older version of compact-lens left with this version's. */
export async function refreshScript($: EngineInterface): Promise<void> {
  const path = scriptPath(await snapshotRoot($))
  const installed = await $.fs.read(path).catch(() => undefined)
  isInstalled = installed !== undefined && isOwnScript(installed)
  lastCheckedMs = await $.clock.now()
  if (installed === undefined || !isInstalled) return
  const bundled = await bundledScript($)
  if (bundled !== undefined && bundled !== installed) await $.fs.write(path, bundled)
}

/** Copies this version's script beside the snapshots, in a root made private first; its path, or why nothing was installed. */
export async function installScript($: EngineInterface): Promise<{ path: string } | string> {
  const bundled = await bundledScript($)
  if (bundled === undefined) return `${$.plugin.root}/bin/statusline.pl could not be read`
  const root = await snapshotRoot($)
  const path = scriptPath(root)
  const installed = await $.fs.read(path).catch(() => undefined)
  if (installed !== undefined && !isOwnScript(installed)) return `${path} is a file compact-lens did not write; move it, then ask again`
  const privacy = await makeRootPrivate($)
  if (privacy.kind === 'unavailable') return `${root} could not be made private, as this session runs no programs; ask again in a session in a terminal`
  if (privacy.kind === 'refused') return `${root} could not be made private (${privacy.reason}), and a script there that others could change would run in your status line`
  await $.fs.write(path, bundled)
  isInstalled = true
  lastWritten = undefined
  return { path }
}

/** A path as one shell word: as it is when nothing in it needs quoting (a tilde does: a shell reads it as a home folder), else in single quotes. */
const shellWord = (path: string): string => (/^[A-Za-z0-9_./@%+=:,-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`)

/** What `/compact-lens statusline` says once the script is installed: what it prints, and the two places it can go. */
export const setupText = (path: string): string => {
  const command = `perl ${shellWord(path)}`
  return [
    `installed ${path}: it prints this session's compactions, counted from its transcript, and the pinned notes, as in "2 compactions · 1 pinned".`,
    '',
    `ccstatusline: run npx -y ccstatusline@latest in a terminal to open its settings (ccstatusline, once pinned), add a Custom Command widget, and set its command to  ${command}`,
    "Claude Code's own status line, in ~/.claude/settings.json (it takes the place of a status line command you have):",
    `  "statusLine": { "type": "command", "command": ${JSON.stringify(command)} }`,
    '',
    'Each session start puts its own version of the script in place. To change it, copy it under another name in the same folder, keeping its second line: it reads .statusline/ beside itself.',
  ].join('\n')
}

/** `/compact-lens statusline`: the script installed, and how to use it. */
export async function statuslineText($: EngineInterface): Promise<string> {
  const installed = await installScript($)
  return typeof installed === 'string' ? `nothing was installed: ${installed}` : setupText(installed.path)
}
