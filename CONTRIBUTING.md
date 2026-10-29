# Contributing

How to change compact-lens and check the change. The README covers using it.

## What you need

- Claude Code 2.1.299 or later (`claude --version`; `claude update` brings it up to date).
- perl, grep and sed, which macOS and Linux ship. The mod reads transcripts with them.
- Node 24, for the scripts under `tools/` (they import the mod's TypeScript, which Node 24 runs by
  stripping the types), and TypeScript's `tsc` (`npm install -g typescript`).
- `make`.

## Loading a working copy

- For one session: `claude --plugin-dir <clone>`. For every session: put the folder in
  `CLAUDE_CODE_PLUGIN_DIRS` in the `env` of `~/.claude/settings.json`.
- Load it one way only. With two copies set up (two folders, or a folder and a marketplace
  install), Claude Code 2.1.299 and later load one hooks module of a name and skip the rest (the
  debug log: `another plugin of that name loads first`), so your clone may not be the one running.
  `/compact-lens doctor`'s first line names the folder loaded. Uninstall the marketplace copy while
  you work on a clone.
- Claude Code watches a folder in `CLAUDE_CODE_PLUGIN_DIRS`. Every running terminal session
  reloads the mod once the files stop changing, so a half-written edit reaches all of them. Work in
  a copy, and copy it over only when it passes the checks.
- A reload is a fresh load: `register` runs again and `session.start` fires again. Values in
  `$.state` (the session's) and `$.store` (across sessions) stay. The module's own variables start
  over, such as the options in `hooks/config.ts` and the auto-compaction line `hooks/ahead.ts`
  remembers.
- A session on a build older than 2.1.299 cannot load the current module. It keeps the version it
  had and logs `reload failed, the previous version stays loaded`.
- To try a copy in a headless session without the folder your settings load, empty the variable
  and pass the copy: `claude -p --settings '{"env":{"CLAUDE_CODE_PLUGIN_DIRS":""}}' --plugin-dir
  <copy> "<prompt>"`. This runs the model.

## Checking a change

`make check` runs the four checks below (targets `validate`, `test`, `typecheck` and `tools-test`).
CI runs all but the type check on every push, on 2.1.299 and on the latest Claude Code
(`.github/workflows/check.yml`); none of them needs a Claude login.

- `claude plugin validate --strict .`: the manifest and the module, read the way the engine reads
  them. `--strict` fails on warnings too.
- `claude plugin test .`: every `*.test.ts` and `*.test.tsx` under the folder, each file in a child
  of the binary, in an environment like the one the hooks run in.
- `tsc -p . --noEmit`: `tsconfig.json` extends `.claude-plugin/types/tsconfig.json`. The engine
  lays that folder beside a loaded mod and lays it again at every load; it is gitignored. So load
  the clone once (`claude --plugin-dir <clone>`) before the first `tsc`.
- `node --test 'tools/test/*.test.mjs'`: the tools' tests, quoted as a glob (Node 24 reads a bare
  folder as a module to run). They are `.mjs` files, so `claude plugin test` leaves them alone. They
  run `bin/statusline.pl` with perl, as a status line runs it, each from a copy in a folder of its
  own, and the replay tool on a transcript built from `tests/rows.ts`.

### The test kit

- `tests/kit.ts`: `setup(on, options)` answers the engine beneath the mod: `HOME`, the store, the
  clock, the files (held in memory in `world.files`), the session's id and root, its usage, the
  prompt box, toasts and the status line. A test's `on` takes each event once, so the variations go
  through `setup`'s options: the engine's answer to a compaction, a write that fails, no processes,
  no perl, sed failing, a removal that fails, a folder that cannot be listed (`listFails`), more
  environment variables (`env`, say `CLAUDE_CONFIG_DIR`), chmod and mkdir failing (`chmodFails`),
  no rm, chmod or mkdir in `/bin`, so the mod runs the `PATH`'s (`binMissing`), a file that cannot
  be read (`readFails`), a stat refused (`statFails`),
  other usage. `fs.exists` answers true for a folder any file lies under. `world.manifest` and
  `world.bundledScript` are the mod's own `plugin.json` and `bin/statusline.pl`, read wherever
  `$.plugin.root` points; `world.engineVersion` is what `$.session.version()` answers (empty, it is
  refused); `world.settings` is what `$.settings.read()` answers; `world.links` maps a path to the
  real path `fs.stat` resolves it to.
- The kit's `$` has no state noun. Watch writes with `watchState(on)`; seed a value by answering
  `state.get` beneath the mod, as `tests/history.test.ts` does.
- `$.process.spawn` is answered as the engine answers it: an async generator that yields
  `{ stream: 'stdout', text }` in 100-character pieces (so a line is often split) and returns
  `{ value: { code, signal } }`.
- `tests/host.ts`: the host's perl, grep and sed over the files in memory, and the kit answers
  `/bin/rm -rf -- <path>`, `/bin/mkdir -p -m 700 <root>` and `/bin/chmod 700 <root>` (by name, with
  `binMissing`). Each command
  form the mod uses is matched whole. Any other form fails (code 2) and any other program is missing
  (127). When the mod runs a new form, add it here, so a test fails if the form ever changes.
- The host only emulates a perl script, matched by its text, so a test never runs the script
  itself. When you change one in `hooks/reader.ts`, run it with the real perl on a small file whose
  answer you know, and note what you checked in the change.
- Real `grep -o` prints one match of two that overlap (`foobarbaz` with `-e foobar -e barbaz`
  prints `foobar` alone), and the host's grep does the same. So without perl the mod runs one grep a
  word (`grepHolding` in `hooks/reader.ts`), and never greps a word under three letters on its own,
  as its matches could fill the output: the reading of each row checks it.
- `tests/rows.ts`: transcript rows (prompts, replies, tool calls and results, boundaries,
  summaries) and whole transcripts: two compactions, partial ones, an apply, a hook's compaction.
  `writeTranscript(world, rows)` puts one where the mod looks for it.
- The pure modules (marked below) take no `$` and are tested by calling them. The rest are tested
  through the kit.

## Rules the engine holds the module to

- `$`, the engine interface, is followed past an import only into `function` declarations. So
  every part that takes `$` is written `async function name($: EngineInterface, …)`, never as an
  arrow function. The validator names the call it refuses.
- Builds up to 2.1.296 refuse any `$` passed across an import; 2.1.299 is the oldest that accepts
  it (2.1.297 and 2.1.298 were never published on npm), so the mod asks for 2.1.299. To check a copy
  against another build, install that build in a folder of its own (`npm install --prefix <folder>
  @anthropic-ai/claude-code@<version>`) and run it on the copy: `<folder>/node_modules/.bin/claude
  plugin validate <copy>`, then `plugin test` in the copy. 2.1.299 checks the plugin and its module
  with `marketplace.json` in the folder; builds older than that were not tried.
- A state atom is read and written only in the file that makes it. Every atom, its reader and its
  writer are in `hooks/state.ts`. A new value goes into `PluginState` in `types/index.d.ts` first:
  `claude plugin validate` holds every `$.state` key the module names to that contract.
- The hooks whose failure would cost the person something (the compaction, the three tools, the
  command, the prompt) each have a `.catch` in `hooks/register.tsx` that says what failed and lets
  the session go on. Give a new one the same.
- A hook has about ten seconds. Work on a large transcript goes to perl, grep and sed (below).

## How Claude Code writes a transcript

The mod reads the session's transcript to count compactions and to give back what they dropped.
These are the facts it rests on, seen in real transcripts of 2.1.263 to 2.1.311.

- The file is `~/.claude/projects/<folder>/<session-id>.jsonl`, where `<folder>` is the session's
  working directory with every character but a letter or digit turned into a dash. The mod looks
  in every project folder when it is not there. A new session's transcript is named (in
  `classic.SessionStart`'s `transcript_path`) before the file is written.
- One JSON object a line. 2.1.311 writes row types the mod has no use for (`api-request-blob`,
  `cost-state`, `queue-operation` and others); the readers take the fields they need and pass over
  the rest.
- Compaction n is the n-th row that holds `"subtype":"compact_boundary"`, applies included. Inside
  a message the same characters are escaped (`\"subtype\":…`), so the probe never matches there.
  Compaction n summarised the lines after boundary n−1 up to boundary n.
- The summary row follows the boundary and holds `"isCompactSummary":true`. A compaction a hook
  answered with its own summary, such as the mod's apply, has no such mark: its summary is the
  first user row after the boundary, looked for within four rows.
- In 2.1.26x to 2.1.28x every compaction is partial. The boundary's
  `compactMetadata.preservedMessages` names the few messages it kept (2 to 11 seen). They stay
  where they are, just above the boundary (within 30 lines in the transcripts read), and the next
  compaction drops them. So a row goes with the compaction that took it out of the context: the
  first boundary after it, or a later one where that one kept it.
- A compaction a hook answered writes every kept message again after its boundary: the same
  content, time and origin, a new uuid. That holds for the apply and for the mod's own live
  compactions, which hand back the engine's summary with the note. Those copies come first after
  the boundary. A row with the same type, time and content as a newer row is the same message.
- Every prompt the person typed carries `origin` with kind `human` (2.1.263 to 2.1.292). Rows
  without one are commands, the engine's summaries and rows a hook wrote.
- A `/clear` or `/resume` changes the session id without a `session.start`. Every entry point
  asks which session it is in first (`hooks/session.ts`).
- A transcript can run to hundreds of megabytes (232 MB seen), past the 4 MiB one `$.fs.read`
  copies. So the mod never reads one whole. It spawns perl to find lines by their text in one pass,
  grep where there is no perl, and sed to fetch lines by number, and streams the output
  (`hooks/reader.ts`). Nothing from a transcript or a search is ever part of a script: the probes,
  the words and the path are arguments.

## Where things are

The README's Layout section lists the folders. Pure modules take no `$`.

```
.claude-plugin/plugin.json       the manifest: version, options, the state contract's path
.claude-plugin/marketplace.json  the repository as a marketplace of one
hooks/hooks.json     names the hooks module
hooks/register.tsx   which event goes to which part: session, turns, tools, the person
hooks/compaction.ts  the session.compact hook: the snapshot, the note after the summary, the apply
hooks/apply.ts       readying an edited summary for the person's /compact
hooks/edit.ts        the edit in the prompt box
hooks/editor.ts      the edit's header line, finding and judging an edit, its replies (pure)
hooks/history.ts     the compactions as the transcript records them; files written on first ask
hooks/reader.ts      perl, grep and sed over the transcript, read-only and streamed
hooks/transcript.ts  transcript rows read as data: boundaries, spans, messages (pure)
hooks/restore.ts     restore and recall: reading a span or the passages for the model
hooks/recall.ts      the search's words and the blocks handed to the model (pure)
hooks/lost.ts        what a compaction dropped, as figures (pure, a heuristic)
hooks/report.ts      the lost report as Markdown (pure)
hooks/snapshot.ts    messages as before.md and after.md text (pure)
hooks/writes.ts      after.md, written the same way by every kind of record
hooks/run.ts         a command run for its effect alone (rm, mkdir, chmod), from /bin or the PATH, its failure in its own words
hooks/privacy.ts     the snapshot folder made private, or why its mode is left as it is
hooks/records.ts     a compaction's record and the message helpers (pure)
hooks/commands.ts    /compact-lens and its verbs
hooks/doctor.ts      /compact-lens doctor: a line a check
hooks/version.ts     the mod's own version, from plugin.json under $.plugin.root, and the one-time notice
hooks/prune.ts       which snapshot folders may go; /compact-lens prune and the keepDays option
hooks/statusline.ts  the status-line script installed and kept current; the session's status for it
hooks/pane.tsx       the pane: the picker, the lost report, the actions
hooks/ahead.ts       the context against auto-compaction: the status line and the warning
hooks/session.ts     which session the values belong to
hooks/state.ts       every state atom, its reader and its writer
hooks/pins.ts        pinned notes, mirrored to pinned.md and the store
hooks/notes.ts       the note, the warning, the system-prompt section (pure)
hooks/texts.ts       the replies, the help, the tools' descriptions (pure)
hooks/paths.ts       the folder layout, the limits and the probes (pure)
hooks/config.ts      the options as this load read them
types/index.d.ts     the $.state contract and the record types
bin/statusline.pl    the status-line script: compactions counted from the transcript, incrementally
tests/               the tests, the kit, the stand-in host and the transcript rows
tools/               replay: the mod's own modules run on any transcript outside a session (tools/README.md)
tools/test/          the tools' Node tests
Makefile             make check
.github/workflows/   the checks on every push
```

## Releasing

1. Bump `version` in `.claude-plugin/plugin.json` (`marketplace.json` names no version). Without
   a bump, `claude plugin update` keeps users on the copy they have.
2. Add the release to `CHANGELOG.md`.
3. Run `make check`.
4. Commit.
5. Tag it with `claude plugin tag .`. It checks that `plugin.json` and the marketplace entry agree
   and that the working tree is clean, then creates `compact-lens--v<version>`. `--dry-run`
   shows what it would tag.
6. Push the commit and the tag (`claude plugin tag . --push` pushes the tag as it creates it). The
   tags of 0.1.0 to 0.4.0 were made after those releases; `git push origin --tags` sends any tag
   not pushed yet, so the CHANGELOG's links resolve.
7. Users update with `claude update`, `claude plugin marketplace update compact-lens` and
   `claude plugin update compact-lens@compact-lens`, then quit and resume their sessions. The
   plugin update alone reads the marketplace's copy as it was last refreshed.
