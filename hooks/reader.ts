// Reading the session's transcript file. It can run to hundreds of megabytes, past what one $.fs.read
// copies (4 MiB), so the mod asks the host for the lines it needs and streams them in: perl finds lines
// by their text (about twenty times faster than the BSD grep macOS ships, on a large file), grep where
// there is no perl, and sed fetches lines by number. Read-only: nothing here writes, every command
// names the transcript file alone, and no text from the transcript or a search is ever part of a script.
import type { EngineInterface } from 'claude-code'

import { BOUNDARY_PROBE, projectFolderName, projectsDir, SUMMARY_PROBE } from './paths'
import { leadOf } from './recall'
import { getTranscript, setTranscript } from './state'
import type { NumberedLine } from './transcript'
import { grepLineNumbers, numberedPairs, sedPrintScript, taggedLineNumbers } from './transcript'

/** grep's exit code for "no line matched", which is no failure here. */
const NO_MATCH = 1

/**
 * One pass over the file: each line holding the boundary probe as `b<n>`, the summary probe as `s<n>`.
 * The probes and the path are arguments; the three-argument open reads the path as a name alone.
 */
export const INDEX_SCRIPT =
  'my ($bp, $sp, $path) = @ARGV; open(my $fh, "<", $path) or exit 2; while (<$fh>) { print "b$.\\n" if index($_, $bp) >= 0; print "s$.\\n" if index($_, $sp) >= 0 }'

/**
 * The numbers of the lines that hold every one of some texts, ASCII letters in any case (`tr` folds no
 * other letter, over the bytes). The texts come first and the path last, all arguments.
 */
export const SEARCH_SCRIPT =
  'my $path = pop @ARGV; my @needles = map { (my $n = $_) =~ tr/A-Z/a-z/; $n } @ARGV; open(my $fh, "<", $path) or exit 2; LINE: while (my $l = <$fh>) { $l =~ tr/A-Z/a-z/; for my $n (@needles) { next LINE if index($l, $n) < 0 } print "$.\\n" }'

/** A command's standard output as lines, streamed in, so no cap cuts it. Rejects when the command cannot start, or fails. */
export async function outputLines($: EngineInterface, argv: readonly string[]): Promise<string[]> {
  const lines: string[] = []
  // The line being read, in the pieces it came in: joined once its end comes, so a long line costs no more than its length.
  const pending: string[] = []
  const stream = $.process.spawn({ argv })
  for await (const piece of stream) {
    if (piece.stream !== 'stdout') continue
    const parts = piece.text.split('\n')
    if (parts.length > 1) {
      lines.push(pending.join('') + (parts[0] ?? ''))
      pending.length = 0
      for (const part of parts.slice(1, -1)) lines.push(part)
    }
    pending.push(parts.at(-1) ?? '')
  }
  const rest = pending.join('')
  if (rest !== '') lines.push(rest)
  const ended = await stream.result
  if (ended.code !== null && ended.code > NO_MATCH) throw new Error(`${argv[0] ?? 'the command'} ended with code ${ended.code}`)
  if (ended.code === null && ended.signal !== null) throw new Error(`${argv[0] ?? 'the command'} was stopped (${ended.signal})`)
  return lines
}

/** Whether `path` is a file there now. */
async function isFile($: EngineInterface, path: string): Promise<boolean> {
  try {
    return (await $.fs.stat(path)).kind === 'file'
  } catch {
    return false
  }
}

/** The transcript in the project folder Claude Code names after a directory, if it is there. */
async function inProjectOf($: EngineInterface, projects: string, directory: string, name: string): Promise<string | null> {
  const path = `${projects}/${projectFolderName(directory)}/${name}`
  return (await isFile($, path)) ? path : null
}

/** The transcript in any project folder, for a session started elsewhere or a folder name Claude Code shortened. */
async function inAnyProject($: EngineInterface, projects: string, name: string): Promise<string | null> {
  const folders = await $.fs.list(projects)
  for (const folder of folders) {
    if (folder.kind !== 'dir') continue
    const path = `${projects}/${folder.name}/${name}`
    if (await isFile($, path)) return path
  }
  return null
}

/** Looks for the session's transcript: in its project's folder first, then in every project folder. */
async function lookForTranscript($: EngineInterface, sessionId: string): Promise<string | null> {
  const home = (await $.env.get('HOME')) ?? ''
  const projects = projectsDir(home, await $.env.get('CLAUDE_CONFIG_DIR'))
  const name = `${sessionId}.jsonl`
  const root = await $.session.root().catch(() => undefined)
  const own = root === undefined ? null : await inProjectOf($, projects, root, name)
  return own ?? (await inAnyProject($, projects, name))
}

/**
 * The session's transcript file: the one an engine event named, else found by the session's id under
 * the projects folder; null where there is none or it cannot be looked for (no file system there).
 */
export async function findTranscript($: EngineInterface, sessionId: string): Promise<string | null> {
  const held = await getTranscript($)
  // The engine names a new session's transcript before it writes the file: none there yet is no transcript yet.
  if (held !== null && held.endsWith(`/${sessionId}.jsonl`)) return (await isFile($, held)) ? held : null
  try {
    const found = await lookForTranscript($, sessionId)
    if (found !== null) await setTranscript($, found)
    return found
  } catch {
    return null
  }
}

/** Remembers the transcript an engine event named (a classic hook's `transcript_path`), when it is this session's. */
export async function noteTranscript($: EngineInterface, path: string | undefined): Promise<void> {
  if (path === undefined || path === '') return
  const id = await $.session.id()
  if (path.endsWith(`/${id}.jsonl`)) await setTranscript($, path)
}

export type TranscriptIndex = { boundaries: number[]; summaries: number[] }

/** The index by grep, where perl cannot run: two passes, each slow on a large file. */
async function grepIndex($: EngineInterface, path: string): Promise<TranscriptIndex> {
  const [boundaries, summaries] = await Promise.all([
    outputLines($, ['grep', '-n', '-o', '-F', BOUNDARY_PROBE, path]),
    outputLines($, ['grep', '-n', '-o', '-F', SUMMARY_PROBE, path]),
  ])
  return { boundaries: grepLineNumbers(boundaries), summaries: grepLineNumbers(summaries) }
}

/** The transcript's compaction index: every boundary row's line number, and every summary row's. */
export async function indexLines($: EngineInterface, path: string): Promise<TranscriptIndex> {
  try {
    const out = await outputLines($, ['perl', '-e', INDEX_SCRIPT, '--', BOUNDARY_PROBE, SUMMARY_PROBE, path])
    return { boundaries: taggedLineNumbers(out, 'b'), summaries: taggedLineNumbers(out, 's') }
  } catch {
    // No perl here, or it could not read the file: grep answers the same, more slowly, or fails for itself.
    return grepIndex($, path)
  }
}

/** The given lines of the transcript, each with its number. */
export async function readLines($: EngineInterface, path: string, lines: readonly number[]): Promise<NumberedLine[]> {
  if (lines.length === 0) return []
  return numberedPairs(await outputLines($, ['sed', '-n', sedPrintScript(lines), path]))
}

/** Lines `from` to `to` of the transcript, each with its number. */
export async function readRange($: EngineInterface, path: string, from: number, to: number): Promise<NumberedLine[]> {
  if (to < from) return []
  const out = await outputLines($, ['sed', '-n', `${from},${to}p;${to}q`, path])
  return out.map((text, i) => ({ line: from + i, text }))
}

/**
 * The transcript's line numbers that hold every needle as the file spells it (JSON-escaped), ASCII in
 * any case. Without perl, grep finds the lines that hold the longest one, and the reader checks the rest.
 */
export async function linesHolding($: EngineInterface, path: string, needles: readonly string[]): Promise<number[]> {
  try {
    return grepLineNumbers(await outputLines($, ['perl', '-e', SEARCH_SCRIPT, '--', ...needles, path]))
  } catch {
    return grepLineNumbers(await outputLines($, ['grep', '-n', '-o', '-i', '-F', '-e', leadOf(needles), path]))
  }
}
