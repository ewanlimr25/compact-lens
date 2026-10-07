import { expect, test } from 'claude-code/testing'

import { contextText, cut, findSummaryIndex, renderTranscript, stripReminders, toJson, transcriptChars } from '../hooks/snapshot'
import { BEFORE, SUMMARY } from './kit'

test('the transcript renders one section per message, tool calls with their input and result, and marks empty ones', async () => {
  const text = renderTranscript(
    [...BEFORE, { role: 'assistant', text: '', toolUses: [], handle: 'h-think' }],
    { title: 'before — compaction #1 (auto) at t', lines: ['7 messages.'] },
  )

  expect(text.startsWith('# before — compaction #1 (auto) at t\n\n7 messages.\n\n## 1 · user\n\nPlease fix the bug')).toBe(true)
  expect(text).toContain('## 2 · assistant\n\nReading it first.\n\n### tool Read (t1)\n```json\n{\n "file_path": "/repo/src/app.ts"\n}\n```\nresult:\n```\nconst MAX_RETRIES = 3\n```')
  expect(text).toContain('## 3 · user\n\n(1 tool result, shown under the calls above)')
  expect(text).toContain('## 7 · assistant\n\n(no text: a thinking-only or empty message)')
  expect(text.endsWith('\n')).toBe(true)
})

test('a long text or result is cut and says by how much', async () => {
  expect(cut('abc', 5)).toBe('abc')
  expect(cut('abcdefgh', 5)).toBe('abcde\n… [cut: 3 more characters]')
})

test('the raw record drops the handles and keeps everything else', async () => {
  const rows = JSON.parse(toJson(BEFORE)) as Array<Record<string, unknown>>

  expect(rows.length).toBe(BEFORE.length)
  expect(rows.every(row => !('handle' in row))).toBe(true)
  expect(rows[1]?.toolUses).toEqual(BEFORE[1]?.toolUses)
  expect(rows[2]?.toolResults).toEqual(BEFORE[2]?.toolResults)
})

test('the summary is the first user message with text and no tool results', async () => {
  expect(findSummaryIndex([{ role: 'user', text: SUMMARY, toolUses: [] }])).toBe(0)
  expect(findSummaryIndex([BEFORE[2] ?? { role: 'user', text: '', toolUses: [] }, { role: 'user', text: SUMMARY, toolUses: [] }])).toBe(1)
  expect(findSummaryIndex([{ role: 'assistant', text: 'x', toolUses: [] }])).toBe(-1)
})

test('the context text and the character count cover text, tool inputs and tool results, and reminders are stripped', async () => {
  expect(contextText(BEFORE)).toContain('const MAX_RETRIES = 3')
  expect(contextText(BEFORE)).toContain('Please fix the bug')
  expect(transcriptChars([{ role: 'user', text: 'abcd', toolUses: [] }])).toBe(4)
  expect(transcriptChars([{ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't', text: 'xyz', isError: false }] }])).toBe(3)
  expect(stripReminders('a <system-reminder>hidden</system-reminder> b')).toBe('a  b')
})
