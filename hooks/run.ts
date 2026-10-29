// A command the mod runs for its effect alone (rm, mkdir, chmod): run to its end, and what went wrong
// when it fails, in the command's own words where it gave some.
import type { EngineInterface } from 'claude-code'

/** A program that is not there, as a shell says it. */
const NO_PROGRAM = 127

/** A command that never started: no such program, or no processes where this session runs. */
export class NotStarted extends Error {}

/** Runs `argv` to its end; rejects with its error output, or its exit code or signal when it said nothing, and with NotStarted when it never ran. */
export async function runToEnd($: EngineInterface, argv: readonly string[]): Promise<void> {
  const name = argv[0]?.split('/').at(-1) ?? 'the command'
  const errors: string[] = []
  let isStarted = false
  try {
    const stream = $.process.spawn({ argv })
    for await (const piece of stream) {
      isStarted = true
      if (piece.stream === 'stderr') errors.push(piece.text)
    }
    isStarted = true
    const ended = await stream.result
    if (ended.code === 0) return
    if (ended.code === NO_PROGRAM) throw new NotStarted(`${name} is not there`)
    const said = errors.join('').trim()
    throw new Error(said !== '' ? said : ended.code === null ? `${name} was stopped (${ended.signal ?? 'a signal'})` : `${name} ended with code ${ended.code}`)
  } catch (error) {
    if (isStarted || error instanceof NotStarted) throw error
    throw new NotStarted(`${name} could not start (${error instanceof Error ? error.message : String(error)})`)
  }
}

/** Runs a system program from /bin, where its path cannot be changed under it, or by name from the PATH where /bin holds none (NixOS, Termux). */
export async function runSystem($: EngineInterface, program: string, args: readonly string[]): Promise<void> {
  try {
    await runToEnd($, [`/bin/${program}`, ...args])
  } catch (error) {
    if (!(error instanceof NotStarted)) throw error
    await runToEnd($, [program, ...args])
  }
}
