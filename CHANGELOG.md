# Changelog

What changed in each version of compact-lens, newest first. Dates are UTC. The version is
`version` in `.claude-plugin/plugin.json`, and each release is tagged `compact-lens--v<version>`.

## Updating

From the marketplace:

```
claude update
claude plugin marketplace update compact-lens
claude plugin update compact-lens@compact-lens
```

Then quit any open session and resume it (`claude --resume`). `claude plugin update` on its own
reads the marketplace's copy as it was last refreshed, so it says "already at the latest version"
until the marketplace is updated. From a clone, `claude update`, then `git pull`.

## [0.5.0] — 2026-10-28

Needs Claude Code 2.1.299 or later.

### Added

- `/compact-lens doctor`: a line for each thing the mod depends on, under a heading with the mod's
  and Claude Code's versions and the folder the mod was loaded from: the transcript and the
  compactions it holds against those recorded, the status line, perl, the snapshot folder's
  sessions and size and whether `keepDays` can remove any, and the status-line script, with a ✗
  when the `dir` option was set aside or the snapshot folder could not be made private.
- A toast the first time a version runs: `compact-lens 0.5.0 is running. /compact-lens doctor checks
  the setup; /compact-lens statusline puts the count in your own status line`, with `(was 0.5.0)`
  after the version once a later one runs.
- `/compact-lens statusline`: installs `bin/statusline.pl` beside the snapshots, for your own status
  line (a ccstatusline Custom Command widget, or Claude Code's `statusLine` command). It counts the
  session's compactions from its transcript, so it is right in sessions that never loaded the mod,
  reads only what the transcript gained since its last run (a quarter of a second for a first run
  on 230 MB), and adds the pinned notes and a waiting edit. Each session start puts its own
  version of the script in place; a `statusline.pl` without the mod's mark on its second line
  (`# compact-lens-statusline:`) is never written over. It goes only in a folder the mod could make
  private.
- `/compact-lens prune <days>` lists the snapshot folders of other sessions untouched for that long
  (the folder, the transcript and the status-line script's files), apart where the transcript is
  gone and the snapshots may be the only copy (Claude Code deletes a transcript after
  `cleanupPeriodDays`, 30 days unless set), and the folders it keeps, with the reason.
  `prune <days> confirm <code>`, typed by you at the prompt or over Remote Control with the code the
  list gave, removes them; the code stands for each folder and the group it was listed in, and once
  either changes it removes nothing. The `keepDays` option (a value under 7 counts as 7) removes, at
  each start, only those whose transcripts are still there, so it removes something only below
  `cleanupPeriodDays`: a transcript that old counts as gone. Nothing removes the current session's folder,
  a folder holding anything the mod did not write, one that may hold an edit not applied yet (a
  changed `summary.md` in any compaction, a `draft.md` with text in it, or an edit set aside), or one whose
  status-line script ran within the days asked; a projects folder that cannot be listed stops the
  prune.
- Recall and `restore <words>`: where no passage holds every word, those that hold all but one, each
  marked with the word it lacks and holding a word of three letters or more.
- `tools/replay.mjs`: the mod's own modules run on any transcript outside a session (`list`,
  `lost`, `prompts`, `recall`), so a recall that missed can be reproduced.
- `make check` (validate, the tests, the type check, the tools' tests), and a GitHub Actions
  workflow that runs it, but the type check, on 2.1.299 and the latest Claude Code.
- This changelog and CONTRIBUTING.md.

### Changed

- The snapshot folder is made private at each start (`chmod 700`), as Claude Code keeps the
  transcripts the snapshots copy: before, other users of the machine could read them. A path that
  is not a folder, cannot be read or listed, leads to the home folder or above it, or holds files the
  mod did not write keeps its mode, and a dim line and `/compact-lens doctor` say why.
- The `dir` option must be a full path, or one under `~/`, and not the home folder or a folder above
  it; otherwise the default folder is used, and a toast and `/compact-lens doctor` say why.
- The oldest Claude Code the mod accepts is 2.1.299, not 2.1.311 as 0.4.0 said: 2.1.296 refuses
  its modules, and 2.1.297 and 2.1.298 were never published.
- Pinning or unpinning a note updates the status line at once, not at the next model step.
- The README no longer says two copies run every hook twice: Claude Code 2.1.299 and later load one
  copy of a plugin and skip the rest.
- The README's Updating section refreshes the marketplace before `claude plugin update`.

## [0.4.0] — 2026-10-27

Needs Claude Code 2.1.299 or later (the release said 2.1.311; 0.5.0 found 2.1.299 to be the
oldest build that accepts it): builds up to 2.1.296 refuse its modules, which hand the engine
interface from one file to another.

### Added

- The count comes from the session's transcript. A compaction that ran before the mod loaded, or
  without its hook, is counted and recorded from its boundary row; its `before.md`, `lost.md` and
  `after.md` are written from the transcript the first time someone asks for them.
- `/compact-lens restore [n]`: your prompts from compaction n's span, verbatim, handed to Claude.
- `/compact-lens restore [n] <words>`, and the model's `mcp__compact-lens__recall` tool: the
  compacted passages that hold every word, newest first, each named by its compaction and its line
  in the transcript. A search reads up to 600 matching rows and says how many it left unread.
- The pane's picker lists every compaction; its "Give my prompts back" button (`r`) restores the
  picked one's prompts.
- `lost.md` opens with "At a glance": each prompt marked by how much of it the summary keeps, the
  files never named after the compaction, the details no longer mentioned, and how to restore.

### Changed

- The warning and the status line measure the context against where auto-compaction runs.
  `warnAtPercent` defaults to 80% of the way there; it was 70% of the model's window.
- `/clear` and `/resume` move the mod to the new session.
- `before.json` is no longer written. Records are read back from each folder's `meta.json`, and
  the store keeps the pinned notes alone.
- `hooks/register.tsx` is split into 25 modules.

### Fixed

- The warning never came in a session whose auto-compaction runs well below 70% of the window.
- After a `/clear` or `/resume`, the old session's folder and records stayed in use.

## [0.3.0] — 2026-10-08

### Changed

- An apply rides on your `/compact`. The mod puts `/compact` in the prompt box and answers it with
  the edited summary: one message swapped, the rest kept, no summariser. It is recorded with
  trigger `apply`. In 0.2.0 the mod called `$.session.compact()`, which the engine runs without the
  calling plugin's own hook, so the summariser ran instead.
- Only a `/compact` with nothing after it applies a waiting edit.

### Added

- `/compact-lens show [lost|after|summary|before|pinned] [n]` prints a snapshot file.
- `/compact-lens cancel` drops a waiting apply.
- A compaction the mod did not see run is recorded as `unseen`, with its `summary.md` and
  `after.md`.
- The status line says when an edited summary waits.
- After the release commit, the same night: a setup tutorial in the README, the MIT licence, and
  the repository as its own marketplace (`claude plugin marketplace add ewanlimr25/compact-lens`,
  then `claude plugin install compact-lens@compact-lens`).

### Fixed

- `lost.md` counted slash-command rows as prompts, used an estimate where the engine gave a token
  count, and missed files read through `cat`, `head` or `sed` in Bash.
- Replies and log lines repeated the plugin's name.
- An edit identical to the summary in use asked for an apply.

## [0.2.0] — 2026-10-07

Published together with 0.3.0.

### Added

- `/compact-lens edit`, and the pane's "Edit summary": the summary goes into the prompt box under
  a header line. Enter saves it to `summary.md` and applies it; an empty box cancels. An edit the
  mod cannot apply is kept aside in the session's folder.

## [0.1.0] — 2026-10-07

### Added

- At every compaction, a folder under `~/.claude/compact-lens/<session-id>/<nn>/`: `before.md`,
  `before.json`, `summary.md`, `after.md`, `lost.md` and `meta.json`.
- A note after the summary that names those files and repeats the pinned notes, and a
  system-prompt section that names the snapshot folder.
- One warning to the model ahead of a compaction (`warnAtPercent`, then 70% of the window).
- Pinned notes: the model's `keep` tool and `/compact-lens keep <text>`. They go into the
  summariser's instructions and, verbatim, into the note after the summary.
- An edited `summary.md` applied by the model's `apply` tool, `/compact-lens apply` or the pane.
- `draft.md` for a summary the engine drafts ahead of time.
- The pane, `/compact-lens list`, and the status line.

[0.5.0]: https://github.com/ewanlimr25/compact-lens/compare/compact-lens--v0.4.0...compact-lens--v0.5.0
[0.4.0]: https://github.com/ewanlimr25/compact-lens/compare/compact-lens--v0.3.0...compact-lens--v0.4.0
[0.3.0]: https://github.com/ewanlimr25/compact-lens/compare/compact-lens--v0.2.0...compact-lens--v0.3.0
[0.2.0]: https://github.com/ewanlimr25/compact-lens/compare/compact-lens--v0.1.0...compact-lens--v0.2.0
[0.1.0]: https://github.com/ewanlimr25/compact-lens/releases/tag/compact-lens--v0.1.0
