import { expect, test } from 'claude-code/testing'

import { computeLost } from '../hooks/lost'
import { needlesOf, passagesOf, searchTerms } from '../hooks/recall'
import { SEARCH_SCRIPT } from '../hooks/reader'
import type { Boundary } from '../hooks/transcript'
import { copiesOf, droppedBy, grepLineNumbers, numberedPairs, parseBoundary, sedPrintScript, spanMessages, spanOf, splitSpan, summaryFrom, taggedLineNumbers } from '../hooks/transcript'
import { runHost } from './host'
import {
  APPLIED_SUMMARY,
  appliedCompactions,
  boundary,
  call,
  CANARY_URL,
  notice,
  partialCompactions,
  plain,
  prompt,
  queued,
  reply,
  result,
  summary,
  SUMMARY_ONE,
  twoCompactions,
} from './rows'
import type { Row } from './rows'

const numbered = (rows: readonly Row[], first = 1) => rows.map((row, i) => ({ line: first + i, text: JSON.stringify(row) }))

test("grep's and sed's output is read as line numbers and numbered lines", async () => {
  expect(grepLineNumbers(['13:"subtype":"compact_boundary"', '6:"subtype":"compact_boundary"', '6:"subtype":"compact_boundary"', 'junk'])).toEqual([6, 13])
  expect(numberedPairs(['6', '{"a":1}', '13', '{"b":2}', '20'])).toEqual([
    { line: 6, text: '{"a":1}' },
    { line: 13, text: '{"b":2}' },
  ])
  expect(sedPrintScript([13, 6, 13])).toBe('6{=;p;};13{=;p;q;}')
})

test("the index pass's tagged output gives each kind of row its line numbers", async () => {
  expect(taggedLineNumbers(['b13', 's7', 'b6', 's14', 'b6', 'x9'], 'b')).toEqual([6, 13])
  expect(taggedLineNumbers(['b13', 's7', 'b6', 's14'], 's')).toEqual([7, 14])
})

test('the host forms the mod uses are the ones the test host answers, and BSD-safe', async () => {
  const files = new Map([['/t.jsonl', 'one\ntwo "x"\nthree\n']])

  expect(runHost(['sed', '-n', sedPrintScript([3, 1]), '/t.jsonl'], files)).toEqual({ out: '1\none\n3\nthree\n', code: 0 })
  expect(runHost(['sed', '-n', '2,3p;3q', '/t.jsonl'], files)).toEqual({ out: 'two "x"\nthree\n', code: 0 })
  expect(runHost(['grep', '-n', '-o', '-F', '"x"', '/t.jsonl'], files)).toEqual({ out: '2:"x"\n', code: 0 })
  expect(runHost(['grep', '-n', '-o', '-i', '-F', '-e', 'THREE', '/t.jsonl'], files)).toEqual({ out: '3:three\n', code: 0 })
  expect(runHost(['grep', '-n', '-o', '-F', 'zzz', '/t.jsonl'], files).code).toBe(1)
  expect(runHost(['sed', '-n', '1p;w /tmp/x', '/t.jsonl'], files).code).toBe(1)
  expect(runHost(['perl', '-e', SEARCH_SCRIPT, '--', 'TWO', '"x"', '/t.jsonl'], files)).toEqual({ out: '2\n', code: 0 })
  expect(runHost(['perl', '-e', SEARCH_SCRIPT, '--', 'two', 'three', '/t.jsonl'], files)).toEqual({ out: '', code: 0 })
})

test('a boundary row gives its time, trigger, tokens and kept messages; any other row is none', async () => {
  const [row] = numbered([boundary(13, 'manual', 175000, ['u12'])], 13)

  expect(row === undefined ? undefined : parseBoundary(row)).toEqual({ line: 13, at: '2026-10-20T10:13:00.000Z', trigger: 'manual', tokensBefore: 175000, tokensAfter: 20000, kept: ['u12'] })
  expect(parseBoundary({ line: 1, text: JSON.stringify(call(1, 'm', 't', 'X', { subtype: 'compact_boundary' })) })).toBeUndefined()
  expect(parseBoundary({ line: 1, text: 'not json' })).toBeUndefined()
})

test('a span runs from the line after the previous boundary to the line before its own, with its summary row', async () => {
  expect(spanOf([6, 13], [7, 14], 1)).toEqual({ from: 1, to: 5, boundary: 6, summary: 7 })
  expect(spanOf([6, 13], [7, 14], 2)).toEqual({ from: 7, to: 12, boundary: 13, summary: 14 })
  expect(spanOf([6, 13], [7], 2)).toEqual({ from: 7, to: 12, boundary: 13 })
  expect(spanOf([6, 13], [7, 14], 3)).toBeUndefined()
})

test("a span's rows become the conversation's messages: a response's rows joined, results on their calls, prompts marked", async () => {
  const rows = [
    prompt(1, 'do it'),
    reply(2, 'm1', 'Looking.'),
    call(3, 'm1', 't1', 'Read', { file_path: '/a.ts' }),
    result(4, 't1', 'const a = 1'),
    notice(5, '<task-notification>done</task-notification>'),
    queued(6, 'and this too'),
    { ...prompt(7, 'from a subagent'), isSidechain: true },
    { uuid: 'x', type: 'attachment', attachment: { type: 'skill_listing' } },
    summary(8, SUMMARY_ONE),
  ]

  const messages = spanMessages(numbered(rows))

  expect(messages.map(m => [m.role, m.isPrompt, m.text])).toEqual([
    ['user', true, 'do it'],
    ['assistant', false, 'Looking.'],
    ['user', false, ''],
    ['user', false, '<task-notification>done</task-notification>'],
    ['user', true, 'and this too'],
    ['user', false, SUMMARY_ONE],
  ])
  expect(messages[1]?.toolUses).toEqual([{ tool_use_id: 't1', tool: 'Read', input: { file_path: '/a.ts' }, text: 'const a = 1' }])
  expect(messages[0]?.line).toBe(1)
  expect(messages[0]?.at).toBe('2026-10-20T10:01:00.000Z')
})

test('a slash command the person typed is no prompt, with or without an origin, and is listed with the slash commands', async () => {
  const typed = { type: 'user', uuid: 'c1', timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'user', content: '/compact' } }
  const echoed = { ...prompt(2, '<command-name>/model</command-name>\n<command-args>opus</command-args>') }
  const path = prompt(3, '/Users/me/app/src/x.ts is broken')

  const messages = spanMessages(numbered([typed, echoed, path]))
  const lost = computeLost(messages, '')

  expect(messages.map(m => m.isPrompt)).toEqual([false, false, true])
  expect(lost.prompts.map(p => p.text)).toEqual(['/Users/me/app/src/x.ts is broken'])
  expect(lost.slashCommands).toEqual(['/compact', '/model opus'])
})

test("the mod's own notes, which the engine writes as plain user rows, are no prompts of the person's", async () => {
  const plain = (n: number, text: string) => ({ type: 'user', uuid: `n${n}`, timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'user', content: text } })
  const rows = [
    plain(1, '<compact-lens n="1" trigger="manual">\nCompaction #1 (manual) ran at …\n</compact-lens>'),
    plain(2, '<compact-lens>\nContext is at 150k of 160k before auto-compaction (94%).\n</compact-lens>'),
    plain(3, '<compact-lens-restore n="1" kind="prompts">\n1. do it\n</compact-lens-restore>'),
    plain(4, '<compact-lens-recall query="x">\nNothing\n</compact-lens-recall>'),
    plain(5, '<compact-lensing> is not the mod'),
  ]

  const messages = spanMessages(numbered(rows))

  expect(messages.map(m => m.isPrompt)).toEqual([false, false, false, false, true])
  expect(computeLost(messages, '').prompts.map(p => p.text)).toEqual(['<compact-lensing> is not the mod'])
})

test("an apply's summary is the first user row with text after its boundary", async () => {
  expect(summaryFrom(numbered([{ type: 'system', subtype: 'x' }, result(2, 't', 'r'), prompt(3, 'The edited summary.')]))).toBe('The edited summary.')
  expect(summaryFrom(numbered([reply(1, 'm', 'no')]))).toBeUndefined()
})

test('a search keeps quoted phrases whole, folds the case of ASCII letters alone, as perl does, and spells each term as the file does', async () => {
  expect(searchTerms('Deploy "retry limit" deploy')).toEqual(['deploy', 'retry limit'])
  expect(searchTerms('ÜBER Привет')).toEqual(['Über', 'Привет'])
  expect(needlesOf(['a', 'say "hi"'])).toEqual(['a', 'say \\"hi\\"'])

  const line = numbered(twoCompactions())[9]
  expect(line === undefined ? [] : passagesOf(line, ['canary-42'])).toEqual([{ line: 10, at: '2026-10-20T10:10:00.000Z', label: 'a tool result', excerpt: `deployed to ${CANARY_URL}` }])
  expect(passagesOf({ line: 1, text: JSON.stringify(prompt(1, 'Das ÜBER-Ziel, Привет')) }, searchTerms('über привет')).length).toBe(0)
  expect(passagesOf({ line: 1, text: JSON.stringify(prompt(1, 'Das ÜBER-Ziel, Привет')) }, searchTerms('ÜBER Привет')).length).toBe(1)
})

const at = (line: number, kept: readonly string[] = []): Boundary => ({ line, at: '', trigger: 'auto', tokensBefore: null, tokensAfter: null, kept })

test('a row goes with the compaction after it, or with a later one where that one kept it; a row every compaction kept is still in the context', async () => {
  const boundaries = [at(5, ['u3', 'u4']), at(9)]

  expect(droppedBy(boundaries, 1, 'u1')).toBe(1)
  expect(droppedBy(boundaries, 3, 'u3')).toBe(2)
  expect(droppedBy(boundaries, 7, 'u7')).toBe(2)
  expect(droppedBy(boundaries, 11, 'u11')).toBe(0)
  expect(droppedBy([at(5), at(9, ['u8'])], 8, 'u8')).toBe(0)
  expect(droppedBy([at(5, ['u3']), at(9, ['u3']), at(12)], 3, 'u3')).toBe(3)
})

test("a span's rows split into what its compaction dropped and what it kept: the rows the one before kept join it, and its own kept rows stay", async () => {
  const lines = numbered(partialCompactions())
  const boundaries = [at(5, ['u3', 'u4']), at(9)]

  const one = splitSpan(lines.slice(0, 4), { k: 1, boundaries, copies: new Set() })
  const two = splitSpan(lines.slice(0, 8), { k: 2, boundaries, copies: new Set() })

  expect(one.dropped.map(m => m.line)).toEqual([1, 2])
  expect(one.kept.map(m => m.line)).toEqual([3, 4])
  expect(two.dropped.map(m => m.line)).toEqual([3, 4, 6, 7, 8])
  expect(two.kept).toEqual([])
})

test("an apply keeps what it writes again after its boundary: only the old summary and the /compact typed go with it", async () => {
  const lines = numbered(appliedCompactions())
  const boundaries = [at(3), at(8), at(14)]

  const apply = splitSpan(lines.slice(3, 7), { k: 2, boundaries, copies: copiesOf(lines.slice(8, 13)) })
  const after = splitSpan(lines.slice(0, 13), { k: 3, boundaries, copies: new Set() })

  expect(apply.dropped.map(m => m.line)).toEqual([4, 7])
  expect(apply.kept.map(m => m.line)).toEqual([5, 6])
  expect(after.dropped.filter(m => m.isPrompt).map(m => m.line)).toEqual([11, 13])
  expect(copiesOf(numbered([boundary(1, 'auto', 1), { type: 'system', subtype: 'informational', content: 'x' }])).size).toBe(0)
})

test("in a transcript that marks origins, a row without one is no prompt (an apply's summary is unmarked); a summary is never a prompt", async () => {
  const marked = spanMessages(numbered([prompt(1, 'typed by the person'), plain(2, APPLIED_SUMMARY), plain(3, 'a row the engine wrote')]))
  const old = spanMessages(numbered([plain(1, 'typed before origins were written'), plain(2, SUMMARY_ONE)]))

  expect(marked.map(m => m.isPrompt)).toEqual([true, false, false])
  expect(old.map(m => m.isPrompt)).toEqual([true, false])
})

test("a tool call's input is searched as the values it holds, so a word with a backslash or a quote in it is found", async () => {
  const row = call(1, 'm', 't', 'Bash', { command: 'dir "C:\\Users\\me"' })

  const found = passagesOf({ line: 1, text: JSON.stringify(row) }, searchTerms('C:\\Users\\me'))

  expect(found.map(p => p.label)).toEqual(["Claude's Bash call"])
  expect(found[0]?.excerpt).toContain('command: dir "C:\\Users\\me"')
})
