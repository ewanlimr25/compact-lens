// A session's transcript file as Claude Code writes it, one JSON row a line: the person's prompts, the
// responses a block a row, tool results, each compaction's boundary row and the summary row after it.

export type Row = Record<string, unknown>

const START_MS = Date.UTC(2026, 9, 20, 10, 0, 0)
const MINUTE_MS = 60_000

const base = (n: number): Row => ({ uuid: `u${n}`, timestamp: new Date(START_MS + n * MINUTE_MS).toISOString(), isSidechain: false })

export const timeOf = (n: number): string => new Date(START_MS + n * MINUTE_MS).toISOString()

export const prompt = (n: number, text: string): Row => ({ ...base(n), type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: text } })

export const notice = (n: number, text: string): Row => ({ ...base(n), type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: text } })

export const reply = (n: number, id: string, text: string): Row => ({ ...base(n), type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'text', text }] } })

export const call = (n: number, id: string, toolUseId: string, name: string, input: Record<string, unknown>): Row => ({
  ...base(n),
  type: 'assistant',
  message: { id, role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name, input }] },
})

export const result = (n: number, toolUseId: string, text: string): Row => ({
  ...base(n),
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] },
})

export const queued = (n: number, text: string): Row => ({
  ...base(n),
  type: 'attachment',
  attachment: { type: 'queued_command', prompt: text, commandMode: 'prompt', origin: { kind: 'human' } },
})

export const boundary = (n: number, trigger: string, preTokens: number, kept: readonly string[] = []): Row => ({
  ...base(n),
  parentUuid: null,
  type: 'system',
  subtype: 'compact_boundary',
  content: 'Conversation compacted',
  compactMetadata: { trigger, preTokens, postTokens: 20000, ...(kept.length === 0 ? {} : { preservedMessages: { allUuids: kept } }) },
})

export const summary = (n: number, text: string): Row => ({ ...base(n), type: 'user', isCompactSummary: true, message: { role: 'user', content: text } })

export const SPAN_ONE_PROMPT = 'Set the retry limit in src/net/retry.ts to 7 and keep the jitter at 250ms'
export const SPAN_TWO_PROMPT = 'Now deploy to staging with the --canary flag, then tell me the URL'
export const QUEUED_PROMPT = 'and post the URL in #releases'
export const SUMMARY_ONE = 'This session is being continued from a previous conversation that ran out of context. The retry limit was raised.'
export const SUMMARY_TWO = 'This session is being continued from a previous conversation that ran out of context. Staging was deployed.'
export const CANARY_URL = 'https://staging.example.com/canary-42'

/**
 * Two compactions the mod did not see run: #1 (auto) summarised lines 1–5, its boundary on line 6 and its
 * summary on 7; #2 (manual) summarised lines 7–12, keeping line 12's reply, its boundary on 13 and its
 * summary on 14; line 15 is a prompt after it.
 */
export const twoCompactions = (): Row[] => [
  prompt(1, SPAN_ONE_PROMPT),
  call(2, 'm1', 't1', 'Edit', { file_path: '/repo/src/net/retry.ts', old_string: 'MAX_RETRIES = 3', new_string: 'MAX_RETRIES = 7' }),
  result(3, 't1', 'The file /repo/src/net/retry.ts has been updated.'),
  reply(4, 'm2', 'Done: MAX_RETRIES is 7 now, in commit c0ffee12.'),
  notice(5, '<task-notification>a background job ended</task-notification>'),
  boundary(6, 'auto', 180000),
  summary(7, SUMMARY_ONE),
  prompt(8, SPAN_TWO_PROMPT),
  call(9, 'm3', 't2', 'Bash', { command: 'make deploy ENV=staging FLAGS=--canary' }),
  result(10, 't2', `deployed to ${CANARY_URL}`),
  queued(11, QUEUED_PROMPT),
  reply(12, 'm4', `Staging is up at ${CANARY_URL}.`),
  boundary(13, 'manual', 175000, ['u12']),
  summary(14, SUMMARY_TWO),
  prompt(15, 'What is left to do?'),
]

/** A user row with no origin: what the engine writes for a hook's own messages, and a command typed. */
export const plain = (n: number, text: string): Row => ({ ...base(n), type: 'user', message: { role: 'user', content: text } })

/** A row the engine writes again after a hook's compaction: the same message and time, a new id. */
export const copyOf = (row: Row, n: number): Row => ({ ...row, uuid: `u${n}` })

export const KEPT_PROMPT = 'Rename the flag to --canary-only and keep the old one as an alias'
export const AFTER_ONE_PROMPT = 'Run the release script for v2.4.0'

/**
 * Two compactions as Claude Code 2.1.28x writes them, each keeping the last messages before it: #1 (auto)
 * keeps lines 3 and 4 (a prompt and its reply), which stay above its boundary on line 5 and go with #2
 * (manual, its boundary on line 9); line 11 is a prompt after it.
 */
export const partialCompactions = (): Row[] => [
  prompt(1, SPAN_ONE_PROMPT),
  reply(2, 'm1', 'Done: MAX_RETRIES is 7.'),
  prompt(3, KEPT_PROMPT),
  reply(4, 'm2', 'Renamed; --canary stays as an alias.'),
  boundary(5, 'auto', 180000, ['u3', 'u4']),
  summary(6, SUMMARY_ONE),
  prompt(7, AFTER_ONE_PROMPT),
  reply(8, 'm3', 'Released v2.4.0.'),
  boundary(9, 'manual', 175000),
  summary(10, SUMMARY_TWO),
  prompt(11, 'What is left to do?'),
]

export const BEFORE_APPLY_PROMPT = 'Bump the changelog for the retry change'
export const AFTER_APPLY_PROMPT = 'Now tag the release'
export const APPLIED_SUMMARY = 'This session is being continued from a previous conversation that ran out of context. The retry limit was raised, as edited.'

/**
 * An apply as the mod's hook leaves it: #1 (manual) on line 3; the person's /compact on line 7 answered by
 * the mod (#2, its boundary on line 8, no summary row marked): the edited summary, the mod's note, then
 * every message it kept written again (lines 11 and 12); #3 (auto) on line 14 drops those.
 */
export const appliedCompactions = (): Row[] => {
  const ask = prompt(5, BEFORE_APPLY_PROMPT)
  const answer = reply(6, 'm2', 'Changelog bumped.')
  return [
    prompt(1, SPAN_ONE_PROMPT),
    reply(2, 'm1', 'Done.'),
    boundary(3, 'manual', 150000),
    summary(4, SUMMARY_ONE),
    ask,
    answer,
    plain(7, '/compact'),
    boundary(8, 'manual', 140000),
    plain(9, APPLIED_SUMMARY),
    plain(10, '<compact-lens n="2" trigger="apply">\nThe summary above was replaced.\n</compact-lens>'),
    copyOf(ask, 11),
    copyOf(answer, 12),
    prompt(13, AFTER_APPLY_PROMPT),
    boundary(14, 'auto', 160000),
    summary(15, SUMMARY_TWO),
  ]
}

export const HOOK_KEPT_PROMPT = 'Keep the canary at five percent until the error rate settles'

/**
 * Compactions as the mod's own hook leaves them (Claude Code 2.1.288–2.1.311): #1's boundary (line 5)
 * names no kept messages; the engine's summary (marked), the mod's note, then the messages it kept
 * written again (lines 8 and 9: the content and time of lines 3 and 4, new ids); #2 (line 12) drops those.
 */
export const hookedCompactions = (): Row[] => {
  const ask = prompt(3, HOOK_KEPT_PROMPT)
  const answer = reply(4, 'm2', 'Holding the canary at 5%.')
  return [
    prompt(1, SPAN_ONE_PROMPT),
    reply(2, 'm1', 'Done.'),
    ask,
    answer,
    boundary(5, 'auto', 170000),
    summary(6, SUMMARY_ONE),
    plain(7, '<compact-lens n="1" trigger="auto">\nCompaction #1 (auto) ran.\n</compact-lens>'),
    copyOf(ask, 8),
    copyOf(answer, 9),
    prompt(10, AFTER_ONE_PROMPT),
    reply(11, 'm3', 'Released.'),
    boundary(12, 'manual', 160000),
    summary(13, SUMMARY_TWO),
    prompt(14, 'What is left to do?'),
  ]
}
