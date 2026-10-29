// Pinned notes: facts kept verbatim through every compaction of the session, mirrored to pinned.md and
// to the store, so a resumed session finds them.
import type { EngineInterface } from 'claude-code'

import type { CompactLensPin } from '../types'
import { refreshStatus } from './ahead'
import { renderPinned } from './notes'
import { pinnedFile } from './paths'
import { ensureSession, isoNow } from './session'
import { getPins, setPins } from './state'
import { storeKey } from './texts'

/** pinned.md and the store hold the pins; the status line shows their count. */
async function mirrorPins($: EngineInterface, dir: string, pins: readonly CompactLensPin[]): Promise<void> {
  await $.fs.write(pinnedFile(dir), renderPinned(pins))
  await $.store.set(storeKey(await $.session.id()), { pinned: pins })
  await refreshStatus($)
}

/** Pins a note; its number and how many are pinned now. */
export async function pin($: EngineInterface, text: string): Promise<{ id: number; count: number }> {
  const dir = await ensureSession($)
  const at = await isoNow($)
  const pins = await setPins($, list => [...list, { id: (list.at(-1)?.id ?? 0) + 1, text, at }])
  await mirrorPins($, dir, pins)
  return { id: pins.at(-1)?.id ?? 0, count: pins.length }
}

/** Removes pinned note `id`; false when there is none. */
export async function unpin($: EngineInterface, id: number): Promise<boolean> {
  const dir = await ensureSession($)
  if (!(await getPins($)).some(p => p.id === id)) return false
  const pins = await setPins($, list => list.filter(p => p.id !== id))
  await mirrorPins($, dir, pins)
  return true
}
