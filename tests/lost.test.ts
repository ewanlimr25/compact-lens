import { expect, test } from 'claude-code/testing'

import { bashReads, computeLost, extractIdentifiers, mergeSubstrings, renderLost } from '../hooks/lost'
import { assistant, BEFORE, SUMMARY, user } from './kit'

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

test("slash commands and their output are not counted as the person's prompts, and are listed as commands with their arguments", async () => {
  const report = computeLost(
    [
      user('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>', 'c1'),
      user('<local-command-stdout>Set model to opus</local-command-stdout>', 'c2'),
      user('<command-message>plugin-authoring</command-message>\n<command-name>/plugin-authoring</command-name>\n<command-args>see if it is built</command-args>', 'c3'),
      user('Base directory for this skill: /tmp/skills/plugin-authoring\n\nWHERE TO WRITE IT.', 'c4'),
      user('<command-name>/effort</command-name>\n<command-args></command-args>', 'c5'),
      user('the one real prompt', 'c6'),
    ],
    '',
  )

  expect(report.prompts).toEqual(['the one real prompt'])
  expect(report.slashCommands).toEqual(['/model opus', '/plugin-authoring see if it is built', '/effort'])
  const text = renderLost(report, { n: 1, trigger: 'manual', at: 't', beforePath: 'b' })
  expect(text).toContain('slash commands: 3')
  expect(text).toContain('- /plugin-authoring see if it is built')
})

test('files read with cat, head or sed in Bash are listed with the Read files; flags, patterns, variables and /dev are not', async () => {
  expect(bashReads("cd ~/repo && sed -n '1,124p' hooks/register.tsx | head -5; cat /etc/hosts 2>/dev/null")).toEqual(['hooks/register.tsx', '/etc/hosts'])
  expect(bashReads('grep -n "a b" src/x.ts README.md')).toEqual(['src/x.ts', 'README.md'])
  expect(bashReads('cat $J; wc -l hooks/*.ts; head -c 600 /dev/null')).toEqual([])
  expect(bashReads('git status && npm test src/app.ts')).toEqual([])
  expect(bashReads("cat <<'EOF' > /repo/notes/plan.md\nhead of the plan: README.md first\nEOF")).toEqual([])
  expect(bashReads('cat src/a.ts > src/b.ts; sed -i "" s/a/b/ src/c.ts; grep -rn TODO src/')).toEqual(['src/a.ts'])

  const report = computeLost(
    [assistant('Reading.', 'a1', [{ tool_use_id: 'b1', tool: 'Bash', input: { command: 'cat notes/plan.md && tail -n 5 /var/log/app.log' }, text: 'x' }])],
    '',
  )
  expect(report.filesRead).toEqual(['notes/plan.md', '/var/log/app.log'])
})

test("the size line gives the engine's token count when it has one, and the estimate otherwise", async () => {
  const report = computeLost(BEFORE, SUMMARY)
  const counted = renderLost(report, { n: 1, trigger: 'manual', at: 't', beforePath: 'b', tokensBefore: 409151 })
  const estimated = renderLost(report, { n: 1, trigger: 'manual', at: 't', beforePath: 'b' })

  expect(counted).toContain("409k tokens by the engine's count")
  expect(estimated).toContain('tokens (')
  expect(estimated).toContain('at 4 a token')
  expect(estimated).not.toContain("engine's count")
})
