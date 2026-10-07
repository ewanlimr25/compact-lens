import { mock } from 'claude-code/testing'
import type { On, SessionCompactInput, SessionCompactResult, SessionMessage, ToolUseSummary } from 'claude-code'

export const HOME = '/home/tester'
export const SESSION = 'sess-1'
export const DIR = `${HOME}/.claude/compact-lens/${SESSION}`
export const KEEP = 'mcp__compact-lens__keep'
export const APPLY = 'mcp__compact-lens__apply'

export const user = (text: string, handle: string): SessionMessage => ({ role: 'user', text, toolUses: [], handle })

export const assistant = (text: string, handle: string, toolUses: ToolUseSummary[] = []): SessionMessage => ({
  role: 'assistant',
  text,
  toolUses,
  handle,
})

export const toolResult = (tool_use_id: string, text: string, handle: string): SessionMessage => ({
  role: 'user',
  text: '',
  toolUses: [],
  toolResults: [{ tool_use_id, text, isError: false }],
  handle,
})

/** A short transcript with a prompt, a read, an edit, a command and an answer. */
export const BEFORE: readonly SessionMessage[] = [
  user('Please fix the bug in src/app.ts and commit it as deadbeef1 on branch fix/retry', 'h1'),
  assistant('Reading it first.', 'h2', [{ tool_use_id: 't1', tool: 'Read', input: { file_path: '/repo/src/app.ts' }, text: 'const MAX_RETRIES = 3' }]),
  toolResult('t1', 'const MAX_RETRIES = 3', 'h3'),
  assistant('Editing.', 'h4', [
    { tool_use_id: 't2', tool: 'Edit', input: { file_path: '/repo/src/app.ts', old_string: '3', new_string: '5' }, text: 'ok' },
    { tool_use_id: 't3', tool: 'Bash', input: { command: 'npm test -- --runInBand\necho done' }, text: 'passed' },
  ]),
  toolResult('t2', 'ok', 'h5'),
  assistant('Done: MAX_RETRIES is now 5, see https://example.com/pr/42 and `retryPolicy()`.', 'h6'),
]

export const SUMMARY = 'This session is being continued from a previous conversation. The user asked to fix a bug in src/app.ts; the constant was raised.'
export const KEPT = assistant('The last answer before the cut.', 'h-kept')

export const USAGE = { startedAt: 0, context: { window: 200000, tokens: 150000, percent: 75 }, rateLimits: [] }

export type World = {
  files: Map<string, string>
  appended: string[]
  compactions: number
  instructions: Array<string | undefined>
}

export type SetupOptions = {
  /** The engine's own answer to a compaction; the default is the SUMMARY and the KEPT message. */
  answer?: (e: SessionCompactInput) => SessionCompactResult
  /** False leaves the store unanswered, for a test that answers it itself. */
  store?: boolean
}

export const ENGINE_ANSWER = (): SessionCompactResult => ({ messages: [user(SUMMARY, 'h-sum'), KEPT], tokensBefore: 90000, tokensAfter: 12000 })

/** The engine beneath the plugin: env, store, clock, files in memory, and the registrations. */
export const setup = (on: On, options: SetupOptions = {}): World => {
  const world: World = { files: new Map(), appended: [], compactions: 0, instructions: [] }
  mock.env(on, { HOME })
  if (options.store !== false) mock.store(on)
  mock.clock(on, { now: 1_700_000_000_000 })
  on('session.id', () => ({ value: SESSION }))
  on('fs.write', ($, e) => {
    world.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: world.files.has(e.path) }))
  on('fs.read', ($, e) => {
    const text = world.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__compact-lens__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.usage', () => ({ value: USAGE }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.append', ($, e) => {
    const first = e.message.content[0]
    world.appended.push(first !== undefined && 'text' in first ? String(first.text) : '')
    return { message: e.message, uuid: `u-${world.appended.length}` }
  })
  on('session.compact', ($, e) => {
    world.compactions += 1
    world.instructions.push(e.instructions)
    return options.answer === undefined ? ENGINE_ANSWER() : options.answer(e)
  })
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  return world
}

export const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
