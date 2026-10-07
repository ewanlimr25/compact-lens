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
/** How long after a turn ends an apply the model asked for is tried, and how often. */
export const APPLY_DELAY_MS = 1500
export const APPLY_RETRIES = 6

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
