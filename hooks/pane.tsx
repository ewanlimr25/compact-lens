// The pane: every compaction of the session in a picker, what the picked one dropped, and the actions on
// it (give the prompts back, edit or apply the summary). A view over the session's values, which it
// reads while drawing; every write happens in a handler.
import type { BoxProps, ButtonProps, ElementConstructor, EngineInterface, RenderInput, TextProps } from 'claude-code'

import type { CompactLensPin, CompactLensRecord } from '../types'
import { appendNote, readContext, refreshStatus } from './ahead'
import { applyFromPane } from './apply'
import { startEdit } from './edit'
import { materialize, needsReading, syncHistory } from './history'
import { contextPhrase, plural } from './notes'
import { COMMAND, compactionFiles, KEEP_TOOL, PANE_ID, PANE_REPORT_CAP } from './paths'
import { restorePrompts } from './restore'
import { log } from './session'
import { cut } from './snapshot'
import { getBusy, getContext, getPins, getRecords, getSelected, getSessionDir, isApplyPending, setSelected } from './state'
import { EDIT_STARTED_TOAST, pickerLabel } from './texts'

/** How many compactions the picker offers, newest first. */
const PICKER_SIZE = 100
/** Where a surface has no Select (the phone app), how many of the newest compactions get a button instead. */
const BUTTON_PICKS = 6

/** Reads a compaction from the transcript in the background when only its boundary is known; says what failed. */
export async function readInBackground($: EngineInterface, n: number): Promise<void> {
  const read = await materialize($, n).catch(error => `it could not be read (${String(error)})`)
  if (typeof read === 'string') $.ui.toast(`compaction #${n}: ${read}`)
}

/** A handler's work, its failure printed as a dim line and never thrown; the engine may wait on it. */
async function logged($: EngineInterface, what: string, work: Promise<unknown>): Promise<void> {
  try {
    await work
  } catch (error) {
    log($, `${what}: ${String(error)}`)
  }
}

/** Shows compaction n, reading it from the transcript first where only its boundary is known. */
async function pickLogged($: EngineInterface, n: number): Promise<void> {
  try {
    await setSelected($, n)
    const record = (await getRecords($)).find(r => r.n === n)
    if (record !== undefined && needsReading(record)) await readInBackground($, n)
  } catch (error) {
    log($, `pick: ${String(error)}`)
  }
}

/** Gives the model back the person's prompts of compaction n, as a hidden note it reads with the next message. */
async function restoreFromPane($: EngineInterface, n: number): Promise<void> {
  const restored = await restorePrompts($, n, true)
  if (typeof restored === 'string') {
    $.ui.toast(`nothing restored: ${restored}`)
    return
  }
  const failure = await appendNote($, restored.block)
  $.ui.toast(failure === undefined ? `Claude now has ${restored.summary}, and reads them with your next message` : `nothing restored: ${failure}`)
}

async function editFromPane($: EngineInterface, n: number, latest: number | undefined): Promise<void> {
  if (n !== latest) {
    $.ui.toast(`only the summary in use (#${latest ?? '?'}) can be edited; #${n} is an older one`)
    return
  }
  await startEdit($, EDIT_STARTED_TOAST)
}

async function refreshFromPane($: EngineInterface): Promise<void> {
  await syncHistory($)
  await readContext($)
  await refreshStatus($)
}

/** The picked compaction's lost report, as the pane draws it; a line saying why when there is none to draw. */
async function reportOf($: EngineInterface, record: CompactLensRecord, dir: string, busy: string | null): Promise<string> {
  if (busy !== null) return `_${busy}…_`
  if (record.trigger === 'unseen' && record.span === undefined) return `Compaction #${record.n} is known by its summary alone: it was not read from the session's transcript (the transcript cannot be read here, or an earlier version of compact-lens numbered it apart from it). Its summary is in ${compactionFiles(dir, record.n).summary}.`
  if (needsReading(record)) return `Compaction #${record.n} ran while compact-lens was not watching: press Read what it dropped (l), and the mod reads it from the session's transcript.`
  const path = compactionFiles(dir, record.n).lost
  return (await $.fs.exists(path)) ? cut(await $.fs.read(path), PANE_REPORT_CAP) : `${path} does not exist.`
}

/** The elements every surface's table has, which the pane's parts draw with. */
type Parts = { Box: ElementConstructor<BoxProps>; Text: ElementConstructor<TextProps>; Button: ElementConstructor<ButtonProps> }

/** The row of actions on the compaction shown; Read first while it has not been read from the transcript. */
function actions($: EngineInterface, { Box, Button }: Parts, shown: CompactLensRecord, latest: number | undefined) {
  const isUnread = needsReading(shown) && shown.span !== undefined
  return (
    <Box gap={1} flexWrap="wrap">
      {isUnread && <Button key="read" label="Read what it dropped" hotkey="l" variant="primary" onPress={() => logged($, 'read', readInBackground($, shown.n))} />}
      <Button key="restore" label="Give my prompts back" hotkey="r" variant={isUnread ? undefined : 'primary'} onPress={() => logged($, 'restore', restoreFromPane($, shown.n))} />
      <Button key="edit" label="Edit summary" hotkey="e" onPress={() => logged($, 'edit', editFromPane($, shown.n, latest))} />
      <Button key="apply" label="Apply summary.md" hotkey="a" onPress={() => logged($, 'apply', applyFromPane($))} />
      <Button key="refresh" label="Refresh" hotkey="s" onPress={() => logged($, 'refresh', refreshFromPane($))} />
      <Button key="close" label="Close" role="dismiss" onPress={() => logged($, 'close', $.ui.close({ id: PANE_ID }))} />
    </Box>
  )
}

/** The pinned notes, or how to pin one. */
function pinned({ Box, Text }: Parts, pins: readonly CompactLensPin[]) {
  return (
    <Box flexDirection="column">
      <Text bold>Pinned</Text>
      {pins.length === 0 && <Text dimColor>none; Claude pins with {KEEP_TOOL}, you with /{COMMAND} keep</Text>}
      {pins.map(p => (
        <Text wrap="wrap">
          {p.id}. {p.text}
        </Text>
      ))}
    </Box>
  )
}

/** The pane: the context, the picker, the actions, the picked compaction's lost report and the pinned notes. */
export async function renderPane($: EngineInterface, e: RenderInput<'Pane'>) {
  const elements = $.ui.resolve(e)
  const { Box, Text, Button, Markdown } = elements
  // The phone app's table has no Select (its stand-in draws nothing), so the picker is buttons there.
  const Select = e.surface !== 'mobile' && 'Select' in elements ? elements.Select : undefined
  const [records, pins, context, selected] = await Promise.all([getRecords($), getPins($), getContext($), getSelected($)])
  const [dir, isPending, busy] = await Promise.all([getSessionDir($), isApplyPending($), getBusy($)])
  const latest = records.at(-1)
  const shown = records.find(r => r.n === selected) ?? latest
  const report = shown === undefined || dir === null ? undefined : await reportOf($, shown, dir, busy)
  const options = [...records].reverse().slice(0, PICKER_SIZE).map(r => ({ value: String(r.n), label: pickerLabel(r) }))

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold>Compact Lens</Text>
        <Text dimColor>
          {context === null ? 'context not measured yet' : contextPhrase(context)} · {plural(records.length, 'compaction')} · {pins.length} pinned
          {isPending ? ' · /compact applies the edit' : ''}
        </Text>
        <Text dimColor wrap="truncate-start">
          {dir ?? '(unset)'}
        </Text>
      </Box>
      {shown === undefined ? (
        <Text dimColor>No compaction yet. When one runs, what it dropped shows here, and /{COMMAND} restore gives your prompts back to Claude.</Text>
      ) : (
        <Box flexDirection="column" gap={1}>
          {Select !== undefined ? (
            <Select key="pick" label="Compaction" options={options} value={String(shown.n)} onSelect={value => pickLogged($, Number(value))} />
          ) : (
            <Box gap={1} flexWrap="wrap">
              {options.slice(0, BUTTON_PICKS).map(o => (
                <Button key={`pick-${o.value}`} label={`#${o.value}`} dimColor={o.value !== String(shown.n)} onPress={() => pickLogged($, Number(o.value))} />
              ))}
            </Box>
          )}
          {actions($, elements, shown, latest?.n)}
          <Markdown text={report ?? ''} />
        </Box>
      )}
      {pinned(elements, pins)}
    </Box>
  )
}
