import { expect, test } from 'claude-code/testing'

import type { CompactLensRecord } from '../types'
import { buildNote, buildPinnedDirective, buildPromptSection, buildWarning, mergeInstructions } from '../hooks/notes'
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
  filesInSpan: 23,
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
  expect(note).toContain("the span's 12 prompts verbatim and its 23 files, and the 41 identifiers the context no longer mentions")
  expect(note).toContain('1. The release tag is v1.4.2')
  expect(note).toContain('mcp__compact-lens__apply')
  expect(note).toContain('mcp__compact-lens__keep')
  expect(note.endsWith('</compact-lens>')).toBe(true)
})

test('the warning says where the fill stands, where the snapshots go and how to pin', async () => {
  const text = buildWarning({ percent: 72, thresholdPercent: 83, sessionDir: '/home/t/.claude/compact-lens/s' })

  expect(text).toContain('Context is at 72% of the window; auto-compaction runs near 83%')
  expect(text).toContain('/home/t/.claude/compact-lens/s/')
  expect(text).toContain('mcp__compact-lens__keep')
  expect(buildWarning({ percent: 72, thresholdPercent: undefined, sessionDir: 'd' })).toContain('Context is at 72% of the window.')
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
