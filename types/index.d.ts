/** Who ran a recorded compaction: the engine's triggers, or an `apply` of an edited summary. */
export type CompactLensTrigger = 'manual' | 'auto' | 'plugin' | 'apply'

/** One recorded compaction of this session: its number, its folder and its counts. */
export type CompactLensRecord = {
  n: number
  trigger: CompactLensTrigger
  at: string
  dir: string
  /** How many messages went into the compaction. */
  messagesBefore: number
  /** How many the engine's compaction produced (the summary and the kept messages), before the mod's note. */
  messagesAfter: number
  charsBefore: number
  charsAfter: number
  tokensBefore: number | null
  tokensAfter: number | null
  /** The first 400 characters of the summary's text, to find the summary again. */
  summaryHead: string
  /** How many of the person's prompts the compacted span held (listed verbatim in lost.md). */
  promptsInSpan: number
  /** How many files the span edited, wrote or read (listed in lost.md). */
  filesInSpan: number
  /** How many identifiers of the span the context after the compaction no longer mentions. */
  identifiersLost: number
}

/** A fact pinned with the keep tool: kept verbatim through every compaction. */
export type CompactLensPin = { id: number; text: string; at: string }

declare module 'claude-code' {
  interface PluginState {
    'compact-lens': {
      compactions: CompactLensRecord[]
      pinned: CompactLensPin[]
      /** The fill percent at which the warning was appended; null until it is, and again after a compaction. */
      warnedAt: number | null
      /** True while an edited summary.md waits to replace the current summary. */
      pendingApply: boolean
      /** This session's snapshot folder, set at session.start. */
      sessionDir: string | null
      /** The last context fill the mod read, as a percent. */
      fill: number | null
      /** The summary the engine precomputed, as written to draft.md; null when none. */
      draft: string | null
    }
  }
}
