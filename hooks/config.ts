// The options as this load of the module read them: `register` sets them, every hook reads them, and a
// reload (an option changed in /config, an edit of the mod) reads them again.
import type { PluginOptions } from 'claude-code'

export type Config = { warnAtPercent: number; dir: string; openPane: boolean; statusLine: boolean }

/** The warning line's default: this share of the way to auto-compaction. */
const DEFAULT_WARN_AT = 80

export const readConfig = (options: PluginOptions): Config => ({
  warnAtPercent: typeof options.warnAtPercent === 'number' ? options.warnAtPercent : DEFAULT_WARN_AT,
  dir: typeof options.dir === 'string' ? options.dir : '',
  openPane: options.openPane === true,
  statusLine: options.statusLine !== false,
})

let current: Config = readConfig({})

export const useConfig = (config: Config): void => {
  current = config
}

export const config = (): Config => current
