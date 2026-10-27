import { mock } from 'claude-code/testing'
import type { MockClock, MockSession } from 'claude-code/testing'
import type { On, PromptDecoration, SessionCompactInput, SessionCompactResult, SessionContextBreakdown, SessionMessage, SessionUsage, ToolUseSummary } from 'claude-code'

import { runHost } from './host'
import type { Row } from './rows'

export const HOME = '/home/tester'
export const SESSION = 'sess-1'
export const DIR = `${HOME}/.claude/compact-lens/${SESSION}`
/** The session's working directory, and its transcript where Claude Code keeps it: under the project folder named after that directory. */
export const ROOT = '/repo'
export const TRANSCRIPT = `${HOME}/.claude/projects/-repo/${SESSION}.jsonl`
export const KEEP = 'mcp__compact-lens__keep'
export const APPLY = 'mcp__compact-lens__apply'
export const RECALL = 'mcp__compact-lens__recall'
/** The host's output comes in pieces this long, so a line is often split between two. */
const SPAWN_PIECE = 100

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

/** Where auto-compaction runs in the kit's session: 150k of 200k tokens is 94% of the way there. */
export const THRESHOLD = 160000

export const BREAKDOWN: SessionContextBreakdown = {
  categories: [],
  totalTokens: 150000,
  maxTokens: 200000,
  rawMaxTokens: 200000,
  autocompactSource: 'model-default',
  percentage: 75,
  gridRows: [],
  model: 'm',
  memoryFiles: [],
  mcpTools: [],
  agents: [],
  autoCompactThreshold: THRESHOLD,
  isAutoCompactEnabled: true,
  apiUsage: null,
}

export const USAGE: SessionUsage = { startedAt: 0, context: { window: 200000, tokens: 150000, percent: 75, breakdown: BREAKDOWN }, rateLimits: [] }

export type Fill = { text: string; decorations: readonly PromptDecoration[] | undefined }

export type World = {
  files: Map<string, string>
  /** Each file's modification time, moved on by every write. */
  mtimes: Map<string, number>
  /** The rows the plugin appended to the session, as the kit's session keeps them. */
  session: MockSession
  /** Every command the plugin ran, as its argv. */
  spawned: string[][]
  /** What `$.session.id()` answers; a test changes it as a /clear or a /resume does. */
  sessionId: string
  /** The dim lines the plugin printed to the transcript. */
  logs: string[]
  compactions: number
  instructions: Array<string | undefined>
  /** The prompt box: what the person sees there. Like a box the engine refills after a drop, it keeps a submitted text. */
  box: string
  fills: Fill[]
  /** The prompts that reached the bottom, past every plugin: what the model would read. */
  submitted: string[]
  toasts: string[]
  clock: MockClock
  /** What `$.session.messages()` answers: the conversation as the engine holds it now. Empty until a test sets it. */
  transcript: SessionMessage[]
  /** The status line under the prompt, as the plugin last set it. */
  status: string | undefined
  /** What the session's usage reports now; a test changes it as a /model switch does. */
  usage: SessionUsage
  /** How many reads of the usage breakdown fail from now, as when the engine cannot give one yet. */
  usageFailures: number
}

export type SetupOptions = {
  /** The engine's own answer to a compaction; the default is the SUMMARY and the KEPT message. */
  answer?: (e: SessionCompactInput) => SessionCompactResult
  /** False leaves the store unanswered, for a test that answers it itself. */
  store?: boolean
  /** A write to a path this answers true for fails, as a full disk would. */
  failWrite?: (path: string) => boolean
  /** The prompt box refuses every fill, for this reason. */
  fillRefusal?: 'no_composer' | 'dialog'
  /** False leaves processes unanswered, as on a surface that runs none: the transcript cannot be read. */
  processes?: boolean
  /** False makes perl missing on the host, so the mod falls back to grep. */
  perl?: boolean
  /** While this answers true, sed fails (exit 2), as a read that breaks part way would. */
  sedFails?: () => boolean
  /** What the session's usage reports; the default is USAGE. */
  usage?: SessionUsage
}

export const ENGINE_ANSWER = (): SessionCompactResult => ({ messages: [user(SUMMARY, 'h-sum'), KEPT], tokensBefore: 90000, tokensAfter: 12000 })

/** The engine beneath the plugin: env, store, clock, files in memory, and the registrations. */
export const setup = (on: On, options: SetupOptions = {}): World => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const session = mock.session(on)
  const world: World = {
    files: new Map(),
    mtimes: new Map(),
    session,
    spawned: [],
    sessionId: SESSION,
    logs: [],
    compactions: 0,
    instructions: [],
    box: '',
    fills: [],
    submitted: [],
    toasts: [],
    clock,
    transcript: [],
    status: undefined,
    usage: options.usage ?? USAGE,
    usageFailures: 0,
  }
  mock.env(on, { HOME })
  if (options.store !== false) mock.store(on)
  on('session.id', () => ({ value: world.sessionId }))
  on('session.root', () => ({ value: ROOT }))
  on('fs.write', ($, e) => {
    if (options.failWrite?.(e.path) === true) throw new Error(`ENOSPC: ${e.path}`)
    writeFile(world, e.path, e.text)
    return { value: undefined }
  })
  answerFiles(on, world)
  if (options.processes !== false) answerProcesses(on, world, { hasPerl: options.perl !== false, sedFails: options.sedFails ?? (() => false) })
  on('classic.SessionStart', () => ({}))
  on('classic.PostCompact', () => ({}))
  on('classic.ConfigChange', () => ({}))
  on('classic.PostModelSwitch', () => ({}))
  on('fs.exists', ($, e) => ({ value: world.files.has(e.path) }))
  on('fs.read', ($, e) => {
    const text = world.files.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('ui.log', ($, e) => {
    world.logs.push(e.text)
    return { value: undefined }
  })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__compact-lens__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.usage', ($, e) => {
    if (e.breakdown === undefined || world.usageFailures <= 0) return { value: world.usage }
    world.usageFailures -= 1
    return { deny: 'the breakdown is not ready' }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.compact', ($, e) => {
    world.compactions += 1
    world.instructions.push(e.instructions)
    return options.answer === undefined ? ENGINE_ANSWER() : options.answer(e)
  })
  // The rows, or the next request's messages: each message's text as one block (the engine merges and adds reminders; enough here).
  on('session.messages', ($, e) => ({
    value: e.as === 'api' ? world.transcript.map(m => ({ role: m.role, content: m.text === '' ? [] : [{ type: 'text', text: m.text }] })) : world.transcript,
  }))
  on('ui.status', ($, e) => {
    world.status = e.text
    return { value: undefined }
  })
  on('prompt.read', () => ({ value: { text: world.box, cursor: world.box.length } }))
  on('prompt.fill', ($, e) => {
    if (options.fillRefusal !== undefined) return { isFilled: false, refusal: options.fillRefusal }
    world.box = e.mode === 'replace' ? e.text : `${world.box}${e.text}`
    world.fills.push({ text: e.text, decorations: e.decorations })
    return { isFilled: true }
  })
  on('prompt.submit', ($, e) => {
    world.submitted.push(e.text)
    return { text: e.text }
  })
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  return world
}

/** Writes a file as the host would, its modification time moved on. */
export const writeFile = (world: World, path: string, text: string): void => {
  world.files.set(path, text)
  world.mtimes.set(path, (Math.max(0, ...world.mtimes.values()) || 0) + 1)
}

/** The session's transcript file, one row a line. */
export const writeTranscript = (world: World, rows: readonly Row[], path = TRANSCRIPT): void =>
  writeFile(world, path, rows.map(row => JSON.stringify(row)).join('\n') + '\n')

/** The texts of the rows the plugin appended to the session, oldest first. */
export const appendedTexts = (world: World): string[] =>
  world.session.appended().map(row => row.message.content.map(block => ('text' in block ? String(block.text) : '')).join(''))

/** The file system's listing and stat over the files in memory: a folder is any path some file lies under. */
const answerFiles = (on: On, world: World): void => {
  on('fs.stat', ($, e) => {
    const text = world.files.get(e.path)
    if (text !== undefined) return { value: { kind: 'file' as const, size: text.length, mtimeMs: world.mtimes.get(e.path) ?? 0, isLink: false } }
    if ([...world.files.keys()].some(key => key.startsWith(`${e.path}/`))) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false } }
    return { deny: `ENOENT: ${e.path}` }
  })
  on('fs.list', ($, e) => {
    const prefix = `${e.path.replace(/\/$/, '')}/`
    const kinds = new Map<string, 'file' | 'dir'>()
    for (const key of world.files.keys()) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      const slash = rest.indexOf('/')
      const name = slash < 0 ? rest : rest.slice(0, slash)
      if (kinds.get(name) !== 'dir') kinds.set(name, slash < 0 ? 'file' : 'dir')
    }
    if (kinds.size === 0) return { deny: `ENOENT: ${e.path}` }
    return { value: [...kinds].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
}

/** The host's perl, grep and sed over the files in memory, streamed in short pieces; every command is kept. */
const answerProcesses = (on: On, world: World, { hasPerl, sedFails }: { hasPerl: boolean; sedFails: () => boolean }): void => {
  on('process.spawn', async function* ($, e) {
    world.spawned.push([...e.argv])
    const ran = e.argv[0] === 'sed' && sedFails() ? { out: '', code: 2 } : runHost(e.argv, world.files, hasPerl)
    for (let at = 0; at < ran.out.length; at += SPAWN_PIECE) yield { stream: 'stdout' as const, text: ran.out.slice(at, at + SPAWN_PIECE) }
    return { value: { code: ran.code, signal: null } }
  })
}

/** The engine's summary of a compaction compact-lens did not see: it opens as every engine summary does. */
export const UNSEEN_SUMMARY = 'This session is being continued from a previous conversation that ran out of context. Summary: the release went out as v2.'

export const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const

export type StateWrite = { key: string; value: unknown }

/** The test's engine has no state noun of its own: the writes are watched from beneath the plugin. */
export const watchState = (on: On): StateWrite[] => {
  const writes: StateWrite[] = []
  on('state.set', ($, e, next) => {
    writes.push({ key: e.key, value: e.value })
    return next(e)
  })
  return writes
}

export const last = (writes: readonly StateWrite[], key: string): unknown => writes.filter(w => w.key === key).at(-1)?.value
