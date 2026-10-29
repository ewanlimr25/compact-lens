// Which session the mod's values belong to. Claude Code keeps one process across a /clear or a
// /resume: the session id changes and no session.start follows, so every entry point asks first.
import type { EngineInterface } from 'claude-code'

import { config } from './config'
import { lensRoot, rootChoice, sessionDirOf } from './paths'
import { heldLists } from './records'
import { getHeldSessionId, getSessionDir, startSessionState } from './state'
import { storeKey } from './texts'

/** A dim transcript line; the engine prints it under the plugin's name. */
export function log($: EngineInterface, line: string): void {
  $.ui.log(line)
}

export async function isoNow($: EngineInterface): Promise<string> {
  return new Date(await $.clock.now()).toISOString()
}

/** The folder every session's snapshots go under: the dir option, or ~/.claude/compact-lens. */
export async function snapshotRoot($: EngineInterface): Promise<string> {
  return lensRoot((await $.env.get('HOME')) ?? '', config().dir)
}

/** Why the dir option was set aside for the default folder; undefined when it was not. */
export async function rootProblem($: EngineInterface): Promise<string | undefined> {
  return rootChoice((await $.env.get('HOME')) ?? '', config().dir).ignored
}

/**
 * This session's snapshot folder. On the first look, and whenever the session id differs from the one
 * the values belong to (a /clear, a /resume), every value starts over for this session, its pins read
 * back from the store.
 */
export async function ensureSession($: EngineInterface): Promise<string> {
  const id = await $.session.id()
  const [held, dir] = await Promise.all([getHeldSessionId($), getSessionDir($)])
  if (held === id && dir !== null) return dir
  const home = (await $.env.get('HOME')) ?? ''
  const fresh = sessionDirOf(lensRoot(home, config().dir), id)
  const { pinned } = heldLists(await $.store.get(storeKey(id)))
  await startSessionState($, { id, dir: fresh, pins: pinned })
  return fresh
}
