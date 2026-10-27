import { expect, test } from 'claude-code/testing'

import type { CompactLensRecord } from '../types'
import { buildNote, buildPinnedDirective, buildPromptSection, buildWarning, contextPhrase, mergeInstructions, progressPercent } from '../hooks/notes'
import { compactionFiles, lensRoot, sessionDirOf } from '../hooks/paths'

const RECORD: CompactLensRecord = {
  n: 2,
  trigger: 'auto',
  at: '2026-10-07T14:03:11.000Z',
  dir: '/home/t/.claude/compact-lens/s/02',
  messagesBefore: 184,
  messagesAfter: 2,
  charsBefore: 400000,
  charsAfter: 60000,
  tokensBefore: null,
  tokensAfter: 14000,
  summaryHead: 'This session',
  promptsInSpan: 12,
  promptsWeak: 4,
  filesInSpan: 23,
  filesUnnamed: 9,
  identifiersLost: 41,
}

test('the note names the counts, the three files and the pinned notes verbatim', async () => {
  const files = compactionFiles('/home/t/.claude/compact-lens/s', 2)
  const pins = [{ id: 1, text: 'The release tag is v1.4.2', at: 'x' }]

  const note = buildNote({ record: RECORD, files, pins, keptCount: 1 })

  expect(note).toContain('<compact-lens n="2" trigger="auto">')
  expect(note).toContain('184 messages (~100k tokens, estimated) went in')
  expect(note).toContain('1 kept message (14k tokens) came out')
  expect(note).toContain('/home/t/.claude/compact-lens/s/02/before.md')
  expect(note).toContain("the span held 12 of the person's prompts (4 barely in the summary), 23 files (9 never named again) and 41 identifiers the context no longer mentions")
  expect(note).toContain('call mcp__compact-lens__recall with words to search for')
  expect(note).toContain('1. The release tag is v1.4.2')
  expect(note).toContain('mcp__compact-lens__apply')
  expect(note).toContain('mcp__compact-lens__keep')
  expect(note.endsWith('</compact-lens>')).toBe(true)
})

test('the warning says how close auto-compaction is, where the snapshots go, how to find a detail again and how to pin', async () => {
  const text = buildWarning({ context: { tokens: 412000, window: 1000000, threshold: 467000 }, sessionDir: '/home/t/.claude/compact-lens/s' })

  expect(text).toContain('Context is at 412k of 467k before auto-compaction (88%)')
  expect(text).toContain('/home/t/.claude/compact-lens/s/')
  expect(text).toContain('mcp__compact-lens__recall')
  expect(text).toContain('mcp__compact-lens__keep')
  expect(buildWarning({ context: { tokens: 150000, window: 200000, threshold: null }, sessionDir: 'd' })).toContain('Context is at 150k of a 200k window (75%)')
})

test('progress is measured to where auto-compaction runs, which can sit far below the window, and to the window when that is unknown', async () => {
  expect(progressPercent({ tokens: 467000, window: 1000000, threshold: 467000 })).toBe(100)
  expect(progressPercent({ tokens: 233500, window: 1000000, threshold: 467000 })).toBe(50)
  expect(progressPercent({ tokens: 233500, window: 1000000, threshold: null })).toBe(23)
  expect(progressPercent({ tokens: 10, window: 0, threshold: null })).toBe(0)
  expect(contextPhrase({ tokens: 233500, window: 1000000, threshold: 467000 })).toBe('234k of 467k before auto-compaction (50%)')
})

test('the pinned directive joins the instructions typed after /compact, and is absent with no pins', async () => {
  expect(buildPinnedDirective([])).toBeUndefined()
  expect(mergeInstructions(undefined, undefined)).toBeUndefined()
  expect(mergeInstructions('  ', undefined)).toBeUndefined()
  expect(mergeInstructions('stress the tests', undefined)).toBe('stress the tests')

  const directive = buildPinnedDirective([{ id: 1, text: 'A', at: 'x' }, { id: 2, text: 'B', at: 'y' }]) ?? ''
  expect(directive).toContain('verbatim and complete')
  expect(directive).toContain('- A\n- B')
  expect(mergeInstructions('stress the tests', directive)).toBe(`stress the tests\n\n${directive}`)
})

test('the prompt section counts the compactions and names the latest folder', async () => {
  const none = buildPromptSection({ sessionDir: '/d', records: [], pinnedCount: 0 })
  expect(none).toContain('# Compact Lens')
  expect(none).toContain('/d/<nn>/')
  expect(none).toContain('Compactions so far: 0. Pinned notes: 0.')

  const one = buildPromptSection({ sessionDir: '/d', records: [RECORD], pinnedCount: 3 })
  expect(one).toContain(`Compactions so far: 1; latest: ${RECORD.dir} (auto, ${RECORD.at}). Pinned notes: 3.`)
})

test('the snapshot root follows the option, with ~ expanded, and the session folder sits under it', async () => {
  expect(lensRoot('/home/t', '')).toBe('/home/t/.claude/compact-lens')
  expect(lensRoot('/home/t', '  ')).toBe('/home/t/.claude/compact-lens')
  expect(lensRoot('/home/t', '~/lens')).toBe('/home/t/lens')
  expect(lensRoot('/home/t', '/var/lens')).toBe('/var/lens')
  expect(sessionDirOf('/var/lens', 'abc')).toBe('/var/lens/abc')
  expect(compactionFiles('/var/lens/abc', 7).before).toBe('/var/lens/abc/07/before.md')
})
