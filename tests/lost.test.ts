import { expect, test } from 'claude-code/testing'

import { computeLost, extractIdentifiers, mergeSubstrings, renderLost } from '../hooks/lost'
import { BEFORE, SUMMARY } from './kit'

test('identifiers are paths, hashes, URLs, code spans, constants and references, and short or numeric ones are dropped', async () => {
  const counts = extractIdentifiers(
    'See /Users/me/app/src/index.ts and docs/guide.md, commit a1b2c3d, https://example.com/x?y=1, `runIt()`, MAX_SIZE, #123, 1.2.3, ab, 3.14159.',
  )

  expect(counts.get('/Users/me/app/src/index.ts')).toBe(1)
  expect(counts.get('docs/guide.md')).toBe(1)
  expect(counts.get('a1b2c3d')).toBe(1)
  expect(counts.get('https://example.com/x?y=1')).toBe(1)
  expect(counts.get('runIt()')).toBe(1)
  expect(counts.get('MAX_SIZE')).toBe(1)
  expect(counts.get('#123')).toBe(1)
  expect(counts.has('1.2.3')).toBe(false)
  expect(counts.has('3.14159')).toBe(false)
  expect(counts.has('ab')).toBe(false)
})

test('a path is listed once: its segments fold into the longest identifier that holds them', async () => {
  const merged = mergeSubstrings(
    new Map([
      ['/repo/src/app.ts', 2],
      ['src/app.ts', 3],
      ['app.ts', 1],
      ['other.ts', 1],
    ]),
  )

  expect(merged.find(one => one.id === '/repo/src/app.ts')?.count).toBe(6)
  expect(merged.some(one => one.id === 'src/app.ts')).toBe(false)
  expect(merged.some(one => one.id === 'other.ts')).toBe(true)
})

test('the lost report lists prompts, files, commands and the identifiers the summary does not mention', async () => {
  const report = computeLost(BEFORE, SUMMARY)

  expect(report.messages).toBe(6)
  expect(report.toolUses).toBe(3)
  expect(report.prompts.length).toBe(1)
  expect(report.prompts[0]).toContain('Please fix the bug')
  expect(report.filesEdited).toEqual(['/repo/src/app.ts'])
  expect(report.filesRead).toEqual(['/repo/src/app.ts'])
  expect(report.commands).toEqual(['npm test -- --runInBand'])
  expect(report.toolCounts).toEqual([
    { tool: 'Read', count: 1 },
    { tool: 'Edit', count: 1 },
    { tool: 'Bash', count: 1 },
  ])
  const lostIds = report.identifiersLost.map(one => one.id)
  expect(lostIds).toContain('deadbeef1')
  expect(lostIds).toContain('MAX_RETRIES')
  expect(lostIds).toContain('https://example.com/pr/42')
  expect(report.identifiersKept + report.identifiersLostTotal).toBe(report.identifiersFound)

  const text = renderLost(report, { n: 1, trigger: 'auto', at: '2026-10-07T12:00:00.000Z', beforePath: '/x/01/before.md' })
  expect(text).toContain('# lost — compaction #1 (auto)')
  expect(text).toContain("## The person's prompts")
  expect(text).toContain('## Files edited or written (1)')
  expect(text).toContain('`deadbeef1` ×1')
})

test('a long dash- or dot-joined token stays linear, and a huge tool input is not mined', async () => {
  const started = Date.now()
  const dashes = computeLost([{ role: 'user', text: `see ${'a-'.repeat(40_000)} end`, toolUses: [] }], '')
  const dots = computeLost([{ role: 'assistant', text: `see ${'x.'.repeat(40_000)} end`, toolUses: [] }], '')
  const huge = computeLost(
    [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 't', tool: 'Write', input: { file_path: '/w/out.ts', content: 'data:x;base64,' + 'Zm9v-'.repeat(20_000) } }] }],
    '',
  )
  const elapsed = Date.now() - started

  expect(elapsed < 1500).toBe(true)
  expect(dashes.identifiersLostTotal + dots.identifiersLostTotal).toBe(0)
  expect(huge.filesEdited).toEqual(['/w/out.ts'])
  expect(huge.identifiersLost.map(one => one.id)).toContain('/w/out.ts')
})

test('a prompt made only of system reminders is not a prompt, and tool results are never mined for identifiers', async () => {
  const report = computeLost(
    [
      { role: 'user', text: '<system-reminder>reminder text /tmp/noise.ts</system-reminder>', toolUses: [] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't', text: 'result /tmp/also-noise.ts', isError: false }] },
    ],
    '',
  )

  expect(report.prompts.length).toBe(0)
  expect(report.identifiersLost.length).toBe(0)
})
