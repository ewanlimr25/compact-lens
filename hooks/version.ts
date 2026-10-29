// The mod's own version, as the folder the engine loaded it from states it, and the one-time notice when
// a version runs for the first time.
import type { EngineInterface } from 'claude-code'

import { versionToast } from './texts'

/** The store key the version that last ran is kept under, across sessions. */
const VERSION_KEY = 'version'

const isJson = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** The version the mod's plugin.json states; undefined where it cannot be read. */
export async function ownVersion($: EngineInterface): Promise<string | undefined> {
  try {
    const manifest: unknown = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))
    return isJson(manifest) && typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/** The engine's version, as `claude --version` prints it; undefined where it cannot say. */
export async function engineVersion($: EngineInterface): Promise<string | undefined> {
  try {
    return (await $.session.version()).version
  } catch {
    return undefined
  }
}

/** Says once, in a toast, that a version of the mod runs for the first time, and remembers it. */
export async function noteVersion($: EngineInterface): Promise<void> {
  const current = await ownVersion($)
  if (current === undefined) return
  const previous = await $.store.get(VERSION_KEY)
  if (previous === current) return
  await $.store.set(VERSION_KEY, current)
  $.ui.toast(versionToast(current, typeof previous === 'string' ? previous : undefined))
}
