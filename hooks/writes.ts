// Files every kind of record writes the same way.
import type { EngineInterface, SessionMessage } from 'claude-code'

import type { CompactLensRecord } from '../types'
import type { CompactionFiles } from './paths'
import { renderTranscript } from './snapshot'

/** after.md: what the context held right after a compaction. */
export async function writeAfter($: EngineInterface, record: CompactLensRecord, files: CompactionFiles, after: readonly SessionMessage[]): Promise<void> {
  const title = `after — compaction #${record.n} (${record.trigger}) at ${record.at}`
  await $.fs.write(files.after, renderTranscript(after, { title, lines: [`${after.length} messages; what the context held right after the compaction.`] }))
}
