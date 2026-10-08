export const PLUGIN = 'compact-lens'
export const PANE_ID = 'compact-lens'
export const COMMAND = 'compact-lens'
export const KEEP_TOOL = 'mcp__compact-lens__keep'
export const APPLY_TOOL = 'mcp__compact-lens__apply'
export const DEFAULT_FOLDER = '.claude/compact-lens'

/** Each tool result in before.md and after.md is cut to this many characters. */
export const TOOL_RESULT_CAP = 1500
/** Each tool input in before.md and after.md is cut to this many characters. */
export const TOOL_INPUT_CAP = 2000
/** A message's own text in before.md and after.md is cut to this many characters. */
export const TEXT_CAP = 20000
/** Each of the person's prompts in lost.md is cut to this many characters. */
export const PROMPT_CAP = 600
/** How many prompts lost.md lists. */
export const PROMPT_LIST_CAP = 100
/** How many identifiers lost.md lists. */
export const IDENTIFIER_CAP = 200
/** How many files, commands or agents each list in lost.md holds. */
export const LIST_CAP = 150
/** How many characters of the summary a record keeps, to find the summary again. */
export const SUMMARY_HEAD_CHARS = 400
/** The person's command an apply rides on: with an edit waiting, the mod answers it with the edit and no summariser runs. */
export const COMPACT_COMMAND = '/compact'
/** What goes in the prompt box: the trailing space closes the slash-command typeahead, so Enter runs /compact and not /compact-lens. */
export const COMPACT_FILL = `${COMPACT_COMMAND} `
/** How the engine's summary opens: a summary the mod did not record is found by it. */
export const ENGINE_SUMMARY_OPENING = 'This session is being continued from a previous conversation'
/** How many characters of a file `/compact-lens show` prints; the rest stays in the file. */
export const SHOW_CAP = 20000
/** How long after the command, or the pane's button, the summary (or /compact) goes into the prompt box: the engine empties the box on Enter first. */
export const EDIT_FILL_DELAY_MS = 250
/** How long after a caught edit the mod looks at the prompt box, to put /compact there or empty it if the engine put the edit back. */
export const EDIT_CLEAR_DELAY_MS = 300
/** How many characters of a short summary's opening identify an edit whose header line was deleted. */
export const EDIT_HEAD_PROBE_CHARS = 80
/** A summary line this long or longer tells the summary from another session's: headings and boilerplate are shorter. */
export const EDIT_DISTINCT_LINE_CHARS = 40
/** Below this many distinct lines a summary is matched by its opening instead. */
export const EDIT_MIN_DISTINCT_LINES = 4
/** How many numbered names a kept-aside edit tries before giving up on a free one. */
export const FREE_NAME_TRIES = 100

export type CompactionFiles = {
  dir: string
  before: string
  beforeJson: string
  summary: string
  after: string
  lost: string
  meta: string
}

export const pad2 = (n: number): string => String(n).padStart(2, '0')

export const expandHome = (path: string, home: string): string =>
  path === '~' ? home : path.startsWith('~/') ? `${home}${path.slice(1)}` : path

export const lensRoot = (home: string, dirOption: string): string =>
  dirOption.trim() === '' ? `${home}/${DEFAULT_FOLDER}` : expandHome(dirOption.trim(), home)

export const sessionDirOf = (root: string, sessionId: string): string => `${root}/${sessionId}`

export const compactionFiles = (sessionDir: string, n: number): CompactionFiles => {
  const dir = `${sessionDir}/${pad2(n)}`
  return {
    dir,
    before: `${dir}/before.md`,
    beforeJson: `${dir}/before.json`,
    summary: `${dir}/summary.md`,
    after: `${dir}/after.md`,
    lost: `${dir}/lost.md`,
    meta: `${dir}/meta.json`,
  }
}

export const pinnedFile = (sessionDir: string): string => `${sessionDir}/pinned.md`
export const draftFile = (sessionDir: string): string => `${sessionDir}/draft.md`
