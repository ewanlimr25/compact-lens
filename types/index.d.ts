/**
 * Who ran a recorded compaction: the engine's triggers, an `apply` of an edited summary, or
 * `unseen`: one recorded from its summary alone, where the session's transcript could not be read.
 */
export type CompactLensTrigger = 'manual' | 'auto' | 'plugin' | 'apply' | 'unseen'

/** Where a compaction stands in the session's transcript file, by line number from 1. */
export type CompactLensSpan = {
  /** The first line of the span it summarised: the line after the previous boundary. */
  from: number
  /** The last line of that span: the line before its own boundary. */
  to: number
  /** Its boundary row. */
  boundary: number
  /** Its summary row, when the transcript marks one (an apply's summary is the row after the boundary). */
  summary?: number
}

/** One recorded compaction of this session: its number, its folder and its counts. */
export type CompactLensRecord = {
  n: number
  trigger: CompactLensTrigger
  at: string
  dir: string
  /**
   * How the mod knows of it: `live`, its hook saw it run; `transcript`, read afterwards from the
   * session's transcript file (it ran before the mod loaded, or without the mod's hook). Absent in
   * records from before 0.4.0, which are live.
   */
  source?: 'live' | 'transcript'
  /** False while only the boundary is known: before.md and lost.md are written when first asked for. */
  hasDetail?: boolean
  /** Its lines in the transcript, once the mod has read the transcript after it. */
  span?: CompactLensSpan
  /** How many messages went into the compaction. */
  messagesBefore: number
  /** How many the engine's compaction produced (the summary and the kept messages), before the mod's note. */
  messagesAfter: number
  charsBefore: number
  charsAfter: number
  tokensBefore: number | null
  tokensAfter: number | null
  /** The first 400 characters of the summary's text, to find the summary again; empty until it is read. */
  summaryHead: string
  /** The whole summary's length and hash, to tell it from another with the same opening; absent in records from before 0.3.0. */
  summaryHash?: string
  /** How many of the person's prompts the compacted span held (listed verbatim in lost.md). */
  promptsInSpan: number
  /** How many of those prompts the summary barely reflects: under 40% of their words appear in it. */
  promptsWeak?: number
  /** How many files the span edited, wrote or read (listed in lost.md). */
  filesInSpan: number
  /** How many of those files the context after the compaction never names. */
  filesUnnamed?: number
  /** How many identifiers of the span the context after the compaction no longer mentions. */
  identifiersLost: number
}

/** A fact pinned with the keep tool: kept verbatim through every compaction. */
export type CompactLensPin = { id: number; text: string; at: string }

/** The context as the status line and the warning read it, in tokens. */
export type CompactLensContext = {
  tokens: number
  /** The model's context window. */
  window: number
  /** Where auto-compaction runs; null when it is off or not known. */
  threshold: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'compact-lens': {
      compactions: CompactLensRecord[]
      pinned: CompactLensPin[]
      /** The fill percent at which the warning was appended; null until it is, and again after a compaction. */
      warnedAt: number | null
      /** True while an edited summary.md waits for the person's /compact to replace the current summary. */
      pendingApply: boolean
      /** This session's snapshot folder. */
      sessionDir: string | null
      /** The session these values belong to: another id (a /clear, a /resume) starts them over. */
      sessionId: string | null
      /** The session's transcript file once found; null before, or where it cannot be read. */
      transcript: string | null
      /** The context the mod last read; null before the first response and after a compaction. */
      context: CompactLensContext | null
      /** The summary the engine precomputed, as written to draft.md; null when none. */
      draft: string | null
      /** The compaction whose summary is open for editing in the prompt box; null when none. */
      editing: number | null
      /** The compaction the pane shows; null for the latest. */
      selected: number | null
      /** What the mod is reading from the transcript, while it reads; null otherwise. */
      busy: string | null
    }
  }
}
