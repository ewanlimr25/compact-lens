// A `$` for the mod's modules outside Claude Code, backed by Node: one session whose transcript is a
// given file, its files, processes and environment answered as the engine answers them. What the
// modules write (the snapshots) goes under a scratch home, never into ~/.claude/compact-lens. Only the
// methods the replayed functions call are here: any other throws, naming itself, so a module that
// starts calling something new says what to add.
import { spawn } from 'node:child_process'
import { lstat, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** The plugin's name, as its plugin.json gives it. */
const PLUGIN = 'compact-lens'

/** A transcript's session id: its file's name without `.jsonl`, as Claude Code names it. */
export const sessionIdOf = path => basename(path).replace(/\.jsonl$/, '')

/** A Node stat's kind, in the engine's words: a link's own is `other`. */
const kindOf = stats => (stats.isFile() ? 'file' : stats.isDirectory() ? 'dir' : 'other')

/** `$.fs.stat`: what the path leads to (a link followed), and whether the path itself is a link. */
async function statOf(path) {
  const [target, own] = await Promise.all([stat(path), lstat(path)])
  return { kind: kindOf(target), size: target.size, mtimeMs: target.mtimeMs, isLink: own.isSymbolicLink() }
}

/** One entry of `$.fs.list`, as the entry itself is (a link is not followed). */
async function entryOf(dir, name) {
  const own = await lstat(join(dir, name))
  return { name, kind: kindOf(own), size: own.size, mtimeMs: own.mtimeMs, isLink: own.isSymbolicLink() }
}

const files = {
  read: path => readFile(path, 'utf8'),
  write: async (path, text) => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text)
  },
  exists: path => stat(path).then(
    () => true,
    () => false,
  ),
  stat: statOf,
  list: async path => {
    const dir = path ?? process.cwd()
    return Promise.all((await readdir(dir)).map(name => entryOf(dir, name)))
  },
}

/**
 * `$.process.spawn`: what the command writes, chunk by chunk as it comes, with how it ended as `result`.
 * A command that cannot start (no such program) makes the reading throw, as the engine's stream does.
 */
function spawnStream({ argv, cwd, env, input }) {
  const [command = '', ...args] = argv
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
  // The chunks not read yet, and the reader's wake-up while it waits for more: a stream is a queue.
  const chunks = []
  const ending = { failure: undefined, isEnded: false }
  let wake = () => {}
  for (const name of ['stdout', 'stderr']) {
    child[name].setEncoding('utf8').on('data', text => {
      chunks.push({ stream: name, text })
      wake()
    })
  }
  const result = new Promise((resolve, reject) => {
    child.once('error', error => {
      Object.assign(ending, { failure: error, isEnded: true })
      wake()
      reject(error)
    })
    child.once('close', (code, signal) => {
      ending.isEnded = true
      wake()
      resolve({ code, signal })
    })
  })
  // The reading throws the failure; `result` is awaited only after a clean read, so its rejection is never left unhandled.
  result.catch(() => {})
  if (input !== undefined) child.stdin.end(input)
  async function* read() {
    for (;;) {
      if (chunks.length > 0) yield chunks.shift()
      else if (ending.failure !== undefined) throw ending.failure
      else if (ending.isEnded) return
      else await new Promise(resolve => (wake = resolve))
    }
  }
  return Object.assign(read(), { result })
}

/** A noun of `$` holding `members`; any other member is refused, naming itself. */
const noun = (name, members) =>
  new Proxy(Object.freeze(members), {
    get: (target, key) => {
      if (typeof key === 'symbol' || key === 'then' || key in target) return target[key]
      throw new Error(`replay: $.${name}.${key} is not shimmed (add it to tools/engine.mjs)`)
    },
  })

/** Where an atom's value is kept, by its plugin and key. */
const cellKey = ref => `${ref.plugin}:${ref.key}`

/**
 * The `$` of one replayed session: `transcript` the session's transcript file (its name the session's
 * id), `home` the scratch home the snapshots go under, `root` the mod's folder, `note` where the
 * toasts and log lines go. `$.state` here is the shim's own (tools/shim/claude-code.mjs reads and
 * writes atoms through it); the store starts empty, as for a session with no pinned notes.
 */
export function createEngine({ transcript, home, root, note }) {
  const id = sessionIdOf(transcript)
  const variables = new Map([['HOME', home]])
  const cells = new Map()
  const nouns = {
    plugin: noun('plugin', { name: PLUGIN, root }),
    session: noun('session', {
      id: async () => id,
      root: async () => {
        throw new Error('replay: the session has no working directory; the transcript is named instead')
      },
      // No conversation is held in memory: a replay has only the transcript.
      messages: async () => [],
    }),
    env: noun('env', { get: async name => variables.get(name) }),
    fs: noun('fs', files),
    process: noun('process', { spawn: spawnStream }),
    store: noun('store', { get: async () => undefined }),
    clock: noun('clock', { now: async () => Date.now() }),
    ui: noun('ui', { log: line => note('log', line), toast: text => note('toast', text) }),
    state: noun('state', {
      get: ref => (cells.has(cellKey(ref)) ? { isSet: true, value: cells.get(cellKey(ref)) } : { isSet: false, value: undefined }),
      set: (ref, value) => {
        cells.set(cellKey(ref), structuredClone(value))
      },
    }),
  }
  return new Proxy(Object.freeze(nouns), {
    get: (target, key) => {
      if (typeof key === 'symbol' || key === 'then' || key in target) return target[key]
      throw new Error(`replay: $.${key} is not shimmed (add it to tools/engine.mjs)`)
    },
  })
}
