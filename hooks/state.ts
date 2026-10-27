// The session's values, held by the host so a hot reload keeps them. The engine's scan reads an atom
// only in the file that makes it, so every read and write of one goes through a function here.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { CompactLensContext, CompactLensPin, CompactLensRecord } from '../types'

const EMPTY_RECORDS: CompactLensRecord[] = []
const EMPTY_PINS: CompactLensPin[] = []
const NO_NUMBER: number | null = null
const NO_TEXT: string | null = null
const NO_CONTEXT: CompactLensContext | null = null

const recordsAtom = atom({ plugin: 'compact-lens', key: 'compactions' } as const, EMPTY_RECORDS)
const pinsAtom = atom({ plugin: 'compact-lens', key: 'pinned' } as const, EMPTY_PINS)
const warnedAtAtom = atom({ plugin: 'compact-lens', key: 'warnedAt' } as const, NO_NUMBER)
const pendingApplyAtom = atom({ plugin: 'compact-lens', key: 'pendingApply' } as const, false)
const sessionDirAtom = atom({ plugin: 'compact-lens', key: 'sessionDir' } as const, NO_TEXT)
const sessionIdAtom = atom({ plugin: 'compact-lens', key: 'sessionId' } as const, NO_TEXT)
const transcriptAtom = atom({ plugin: 'compact-lens', key: 'transcript' } as const, NO_TEXT)
const contextAtom = atom({ plugin: 'compact-lens', key: 'context' } as const, NO_CONTEXT)
const draftAtom = atom({ plugin: 'compact-lens', key: 'draft' } as const, NO_TEXT)
const editingAtom = atom({ plugin: 'compact-lens', key: 'editing' } as const, NO_NUMBER)
const selectedAtom = atom({ plugin: 'compact-lens', key: 'selected' } as const, NO_NUMBER)
const busyAtom = atom({ plugin: 'compact-lens', key: 'busy' } as const, NO_TEXT)

export async function getRecords($: EngineInterface): Promise<CompactLensRecord[]> {
  return read($, recordsAtom)
}

export async function setRecords($: EngineInterface, fn: (list: CompactLensRecord[]) => CompactLensRecord[]): Promise<CompactLensRecord[]> {
  return update($, recordsAtom, fn)
}

export async function getPins($: EngineInterface): Promise<CompactLensPin[]> {
  return read($, pinsAtom)
}

export async function setPins($: EngineInterface, fn: (list: CompactLensPin[]) => CompactLensPin[]): Promise<CompactLensPin[]> {
  return update($, pinsAtom, fn)
}

export async function getWarnedAt($: EngineInterface): Promise<number | null> {
  return read($, warnedAtAtom)
}

export async function setWarnedAt($: EngineInterface, value: number | null): Promise<void> {
  await update($, warnedAtAtom, () => value)
}

export async function isApplyPending($: EngineInterface): Promise<boolean> {
  return read($, pendingApplyAtom)
}

export async function setApplyPending($: EngineInterface, value: boolean): Promise<void> {
  await update($, pendingApplyAtom, () => value)
}

export async function getSessionDir($: EngineInterface): Promise<string | null> {
  return read($, sessionDirAtom)
}

export async function getHeldSessionId($: EngineInterface): Promise<string | null> {
  return read($, sessionIdAtom)
}

export async function getTranscript($: EngineInterface): Promise<string | null> {
  return read($, transcriptAtom)
}

export async function setTranscript($: EngineInterface, path: string | null): Promise<void> {
  await update($, transcriptAtom, () => path)
}

export async function getContext($: EngineInterface): Promise<CompactLensContext | null> {
  return read($, contextAtom)
}

export async function setContext($: EngineInterface, value: CompactLensContext | null): Promise<void> {
  await update($, contextAtom, () => value)
}

export async function getDraft($: EngineInterface): Promise<string | null> {
  return read($, draftAtom)
}

export async function setDraft($: EngineInterface, value: string | null): Promise<void> {
  await update($, draftAtom, () => value)
}

export async function getEditing($: EngineInterface): Promise<number | null> {
  return read($, editingAtom)
}

export async function setEditing($: EngineInterface, value: number | null): Promise<void> {
  await update($, editingAtom, () => value)
}

export async function getSelected($: EngineInterface): Promise<number | null> {
  return read($, selectedAtom)
}

export async function setSelected($: EngineInterface, value: number | null): Promise<void> {
  await update($, selectedAtom, () => value)
}

export async function getBusy($: EngineInterface): Promise<string | null> {
  return read($, busyAtom)
}

export async function setBusy($: EngineInterface, value: string | null): Promise<void> {
  await update($, busyAtom, () => value)
}

/** What a session starts with: its id and folder, its pins, and nothing else. */
export type SessionStart = { id: string; dir: string; pins: readonly CompactLensPin[] }

/**
 * Sets the values for a session. The first session the host's values hold keeps the rest as they are
 * (each still its initial value, or what an earlier version of the mod left for this session); another
 * session after a /clear or a /resume starts every value over. A second start for the session already
 * held (two looks at once noticed the switch) changes nothing.
 */
export async function startSessionState($: EngineInterface, start: SessionStart): Promise<void> {
  const previous = await read($, sessionIdAtom)
  if (previous === start.id) return
  await update($, sessionIdAtom, () => start.id)
  await update($, sessionDirAtom, () => start.dir)
  if (previous === null) {
    if (start.pins.length > 0) await update($, pinsAtom, () => [...start.pins])
    return
  }
  await update($, recordsAtom, () => [])
  await update($, pinsAtom, () => [...start.pins])
  await update($, warnedAtAtom, () => null)
  await update($, pendingApplyAtom, () => false)
  await update($, transcriptAtom, () => null)
  await update($, contextAtom, () => null)
  await update($, draftAtom, () => null)
  await update($, editingAtom, () => null)
  await update($, selectedAtom, () => null)
  await update($, busyAtom, () => null)
}
