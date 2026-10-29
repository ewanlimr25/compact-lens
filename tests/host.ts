// The host's perl, grep and sed, as the mod calls them, over the files a test holds in memory. Each form
// the mod uses is matched whole; any other command or script fails, so a test catches a change of form.
import { AT_LEAST_SCRIPT, INDEX_SCRIPT, PERL_PROBE, SEARCH_SCRIPT } from '../hooks/reader'

export type HostRun = { out: string; code: number }

const NOT_FOUND = 2
/** What the host's perl answers to the mod's probe of its version. */
export const PERL_VERSION = 'v5.30.0'
const NO_COMMAND = 127
const RANGE_SCRIPT = /^(\d+),(\d+)p;(\d+)q$/
const LINE_CLAUSE = /(\d+)\{=;p;(?:q;)?\}/g

const linesOf = (text: string): string[] => {
  const lines = text.split('\n')
  return lines.at(-1) === '' ? lines.slice(0, -1) : lines
}

const output = (lines: readonly string[]): string => lines.map(line => `${line}\n`).join('')

/**
 * Each match on each line, as `grep -n -o` prints it: from the left, the longest needle that matches at
 * a place, then on past it, so a needle inside or overlapping another's match is not printed, as the
 * real grep does (`foobarbaz` with `-e foobar -e barbaz` prints `foobar` alone).
 */
const occurrences = (lines: readonly string[], needles: readonly string[], isAnyCase: boolean): string[] => {
  const wanted = needles.filter(needle => needle !== '').map(needle => (isAnyCase ? needle.toLowerCase() : needle))
  return lines.flatMap((line, i) => {
    const hay = isAnyCase ? line.toLowerCase() : line
    const found: string[] = []
    for (let at = 0; at < hay.length; ) {
      const longest = wanted.filter(needle => hay.startsWith(needle, at)).sort((a, b) => b.length - a.length)[0]
      if (longest === undefined) {
        at += 1
        continue
      }
      found.push(`${i + 1}:${line.slice(at, at + longest.length)}`)
      at += longest.length
    }
    return found
  })
}

/** The texts of `-e <text> -e <text>…` between `-F` and the file; undefined when the words are anything else. */
const searchNeedles = (argv: readonly string[]): string[] | undefined => {
  const pairs = argv.slice(5, -1)
  if (pairs.length < 2 || pairs.length % 2 !== 0 || pairs.some((word, i) => i % 2 === 0 && word !== '-e')) return undefined
  return pairs.filter((_, i) => i % 2 === 1)
}

/** `grep -n -o -F <text> <file>` and `grep -n -o -i -F -e <text> [-e <text>…] <file>`. */
const grep = (argv: readonly string[], files: ReadonlyMap<string, string>): HostRun => {
  const isProbe = argv.length === 6 && argv[1] === '-n' && argv[2] === '-o' && argv[3] === '-F'
  const isSearch = argv[1] === '-n' && argv[2] === '-o' && argv[3] === '-i' && argv[4] === '-F'
  const needles = isProbe ? [argv.at(-2) ?? ''] : isSearch ? searchNeedles(argv) : undefined
  if (needles === undefined) return { out: '', code: NOT_FOUND }
  const text = files.get(argv.at(-1) ?? '')
  if (text === undefined) return { out: '', code: NOT_FOUND }
  const found = occurrences(linesOf(text), needles, isSearch)
  return { out: output(found), code: found.length === 0 ? 1 : 0 }
}

/** `sed -n '<from>,<to>p;<to>q' <file>` and `sed -n '<a>{=;p;};<b>{=;p;q;}' <file>`. */
const sed = (argv: readonly string[], files: ReadonlyMap<string, string>): HostRun => {
  const [, flag, script = '', path = ''] = argv
  const text = files.get(path)
  if (flag !== '-n' || argv.length !== 4 || text === undefined) return { out: '', code: NOT_FOUND }
  const lines = linesOf(text)
  const range = RANGE_SCRIPT.exec(script)
  if (range !== null) return { out: output(lines.slice(Number(range[1]) - 1, Number(range[2]))), code: 0 }
  const isWhole = script.replace(LINE_CLAUSE, '').replace(/;/g, '') === ''
  const wanted = [...script.matchAll(LINE_CLAUSE)].map(match => Number(match[1]))
  if (!isWhole || wanted.length === 0) return { out: '', code: 1 }
  const printed = wanted.filter(n => n >= 1 && n <= lines.length).flatMap(n => [String(n), lines[n - 1] ?? ''])
  return { out: output(printed), code: 0 }
}

/** ASCII letters lower-cased, every other character as it is: what perl's `tr/A-Z/a-z/` does to a line's bytes. */
const asciiLower = (text: string): string => text.replace(/[A-Z]/g, letter => letter.toLowerCase())

/**
 * `perl -e INDEX_SCRIPT -- <boundary probe> <summary probe> <file>`, `perl -e SEARCH_SCRIPT -- <text>... <file>`,
 * `perl -e AT_LEAST_SCRIPT -- <count> <leading> <text>... <file>` and the version probe `perl -e PERL_PROBE`.
 */
const perl = (argv: readonly string[], files: ReadonlyMap<string, string>): HostRun => {
  if (argv.length === 3 && argv[1] === '-e' && argv[2] === PERL_PROBE) return { out: `${PERL_VERSION}\n`, code: 0 }
  const [, flag, script, dashes, ...rest] = argv
  const text = files.get(rest.at(-1) ?? '')
  if (flag !== '-e' || dashes !== '--' || text === undefined) return { out: '', code: NOT_FOUND }
  const lines = linesOf(text)
  if (script === INDEX_SCRIPT && rest.length === 3) {
    const [boundary = '', summary = ''] = rest
    return { out: output(lines.flatMap((line, i) => [...(line.includes(boundary) ? [`b${i + 1}`] : []), ...(line.includes(summary) ? [`s${i + 1}`] : [])])), code: 0 }
  }
  if (script === SEARCH_SCRIPT && rest.length >= 2) {
    const needles = rest.slice(0, -1).map(asciiLower)
    return { out: output(lines.flatMap((line, i) => (needles.every(needle => asciiLower(line).includes(needle)) ? [String(i + 1)] : []))), code: 0 }
  }
  if (script === AT_LEAST_SCRIPT && rest.length >= 4) {
    const [least, long] = [Number(rest[0]), Number(rest[1])]
    const needles = rest.slice(2, -1).map(asciiLower)
    const held = (line: string): number[] => needles.flatMap((needle, i) => (asciiLower(line).includes(needle) ? [i] : []))
    return { out: output(lines.flatMap((line, i) => (held(line).length >= least && held(line).some(at => at < long) ? [String(i + 1)] : []))), code: 0 }
  }
  return { out: '', code: NOT_FOUND }
}

/** What the command prints and its exit code; with `hasPerl` false, perl is not there, as on a host without it. */
export const runHost = (argv: readonly string[], files: ReadonlyMap<string, string>, hasPerl = true): HostRun => {
  if (argv[0] === 'perl') return hasPerl ? perl(argv, files) : { out: '', code: NO_COMMAND }
  return argv[0] === 'grep' ? grep(argv, files) : argv[0] === 'sed' ? sed(argv, files) : { out: '', code: NO_COMMAND }
}
