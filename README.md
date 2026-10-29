# compact-lens

A Claude Code mod for what compaction takes away. It shows every compaction of a session and
what its summary dropped, gives your prompts or any lost detail back to Claude when you ask, lets
Claude pin facts that must survive, and lets Claude or you edit the summary.

It is a plugin of function hooks (Claude Code 2.1.299 or later). It counts compactions from the
session's own transcript file, so it finds every one, including those that ran before it was
loaded, and it hooks `session.compact` to snapshot the ones it sees run.

## Setting it up

From install to getting a lost detail back, in seven steps. [What it does](#what-it-does) below
is the reference for each part.

### 1. Check your Claude Code

```
claude --version
```

You need 2.1.299 or later; `claude update` brings an older one up to date. Builds up to
2.1.296 refuse the mod's modules, which hand the engine interface from one file to another.
There is nothing to build: Claude Code loads the TypeScript as it is, and the mod has no
dependencies. Reading the transcript uses `perl` (or `grep`) and `sed`, which macOS and Linux
have.

### 2. Install it

**From the marketplace** (the usual way). This repository is its own marketplace:

```
claude plugin marketplace add ewanlimr25/compact-lens
claude plugin install compact-lens@compact-lens
```

The first command adds the marketplace, and the second installs the mod for your user, in every
session. Inside a session, `/plugin install compact-lens --marketplace ewanlimr25/compact-lens`
does both. Then start a new session. The install notes that five options are not set yet: each
has a default (see [Options](#options)), so there is nothing you must set.

**From a clone**, to read or change the code:

```
git clone https://github.com/ewanlimr25/compact-lens.git ~/compact-lens
cd ~/compact-lens
claude plugin validate .
claude plugin test .
```

`validate` ends with `✔ Validation passed`, and `test` prints `0 fail` just above its closing count of
the tests it ran. To load the clone in every
session, add it to the `env` block of `~/.claude/settings.json`, merging it into the block you
may already have:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "~/compact-lens"
  }
}
```

The value is one or more folders, absolute or starting with `~`, separated by `:` (`;` on
Windows); if it already names a folder, add `:~/compact-lens` to the end. Claude Code reads it
when a session starts, in the terminal, the desktop app and `claude -p` alike, so start a new
session. Only your user settings can set it, not a project's. For one session only, start
Claude Code with `claude --plugin-dir ~/compact-lens` instead.

Install it one way only. With two copies set up (the marketplace and a clone, or two clones),
Claude Code loads one and skips the other, which may not be the one you expect;
`/compact-lens doctor`'s first line names the folder it loaded.

**Sessions already running don't have it.** A Claude Code process loads plugins when it starts,
so a session that was open before you installed the mod never runs it. Quit it and resume it
(`claude --resume`, or `/resume` in a new session): the mod then counts every compaction that
session already had, from its transcript.

### 3. Check that it loaded

Type `/compact-lens`. It opens the pane and answers:

```
context not measured yet; 0 compactions; 0 pinned
snapshots: /Users/you/.claude/compact-lens/<session-id>
/compact-lens lost shows what it dropped; /compact-lens restore gives your prompts back to Claude.
```

The line under the prompt reads `compact-lens: – · 0 compactions · 0 pinned`, and once Claude has
replied it shows how close auto-compaction is: `412k of 467k before auto-compaction (88%)`. In a
resumed session the count includes the compactions it already had. If `/compact-lens` is an
unknown command, see [Troubleshooting](#troubleshooting).

`/compact-lens doctor` checks the rest, a line each: the mod's and Claude Code's versions, the
transcript and how many compactions it holds, the status line, perl, the snapshots (and whether
`keepDays` can remove any) and the status-line script, with a line more when the `dir` option was
set aside or the snapshot folder could not be made private. A ✗ says what is wrong; a – is worth
knowing. If you keep a status line of
your own and the mod's line does not show under the prompt, see
[Your own status line](#your-own-status-line).

### 4. See what a compaction dropped

When Claude Code compacts, on its own or because you ran `/compact`, a toast sums it up and the
mod writes `~/.claude/compact-lens/<session-id>/01/`. Then:

- `/compact-lens lost` prints what the summary dropped (`lost.md`), starting with **At a glance**:
  your prompts word for word, each marked ✓ when the summary keeps most of its words and ✗ when
  it keeps few; the files the span touched that the new context never names; and the paths,
  hashes and names it no longer mentions. `/compact-lens lost 2` does the same for compaction 2;
- `/compact-lens` opens the pane: pick any compaction, read its report, act on it;
- `/compact-lens list` lists every compaction and its folder.

A compaction that ran before the mod was loaded is listed too, marked "from the transcript, not
read yet": the first time you ask for it, the mod reads it from the transcript and writes its
folder.

### 5. Get it back

```
/compact-lens restore            your prompts from the latest compaction, verbatim
/compact-lens restore 2          your prompts from compaction 2
/compact-lens restore 2 staging  the passages of compaction 2 that mention "staging"
/compact-lens restore "retry limit"   any compacted passage with that phrase
```

Claude reads what you restored with your next message; nothing goes into the transcript you see,
apart from a one-line reply. The pane's **Give my prompts back** button (hotkey `r`) does the
first for the compaction you picked.

A search finds the passages that hold every word you give. When none holds them all, and none was
left unread, it gives those that hold all but one, each marked with the word it lacks
(`lacks "staging"`); each of those holds a word of three letters or more, so `db migration` finds a
passage with `migration` alone, never one with `db` alone. It ignores case for the letters A–Z
only, so a word with other letters (é, ü, Привет) matches as you type it, and it needs one word of
three letters or more.

Claude can also get details back by itself: its `recall` tool searches every compacted span and
returns the matching passages verbatim, each named by its compaction and transcript line. The
note after each summary tells it to use the tool when the summary lacks something it needs.

### 6. Edit the summary

1. Run `/compact-lens edit`, or press **Edit summary** (`e`) in the pane. The summary goes into
   your prompt box under a dim first line, `[compact-lens edit #01: …]`. Keep that line.
2. Edit the text in the box, or press ctrl+g to edit it in your own editor.
3. Press Enter. Claude Code shows `Prompt dropped by a hook: compact-lens: your edit is saved to
   …/01/summary.md …`. That is expected: the edit was saved, and Claude never saw it as a
   prompt. The mod then puts `/compact` in the prompt box.
4. Press Enter on `/compact`. The mod answers it itself: it swaps the summary for your text,
   keeps every message after it, and runs no summariser. A toast says `your edited summary is in
   place (#02)`, and the swap is recorded as folder `02/` with trigger `apply`.

To check, ask Claude what its summary says about the part you changed.

An empty box at the third step cancels. `/compact-lens cancel` drops an edit waiting at the
fourth, and a `/compact` with words after it (`/compact focus on the API`) compacts as usual and
drops it too. Only the summary in use can be edited, even when it came from a compaction the mod
did not see run.

### 7. Pin what must survive

```
/compact-lens keep the staging database is db-stg-2; never touch prod
```

A pinned note goes into the summariser's instructions and, word for word, into the note after
every later summary. Claude can pin facts too, with its `keep` tool; it is reminded to once the
context is 80% of the way to auto-compaction. `/compact-lens list` shows the pins, and
`/compact-lens unpin <n>` removes one.

### Your own status line

If you run a status line of your own, such as [ccstatusline](https://github.com/sirmalloc/ccstatusline)
or a `statusLine` command, the count can go there:

```
/compact-lens statusline
```

It installs `statusline.pl` in the snapshot folder (`~/.claude/compact-lens`, or the folder the
`dir` option names) and prints how to use it, with its path filled in. The script counts the
session's compactions from its transcript, so it is right even in a session that never loaded the
mod, and adds the pinned notes and a waiting edit: `3 compactions · 1 pinned`. It reads only what
the transcript gained since its last run; the first run on a 230 MB transcript takes about a
quarter of a second.

- **ccstatusline:** run `npx -y ccstatusline@latest` in a terminal (just `ccstatusline` once you have
  pinned it with a global install) to open its settings, add a Custom Command widget, and set its
  command to `perl ~/.claude/compact-lens/statusline.pl`.
- **Claude Code's own status line** (it takes the place of a `statusLine` command you have), in
  `~/.claude/settings.json`:

  ```json
  "statusLine": { "type": "command", "command": "perl ~/.claude/compact-lens/statusline.pl" }
  ```

Each session start puts its own version of the script in place, so after an update the first new
session updates it. The script's second line marks it as compact-lens's
(`# compact-lens-statusline:`): a `statusline.pl` without that mark is yours, and the mod never
writes over it (`/compact-lens statusline` says to move it first). The mod installs the script only
in a folder it could make private (see [Good to know](#good-to-know)). To change the script, copy
it under another name in the same folder, keeping its second line, and point your status line at
the copy: it reads `.statusline/` beside itself, so a copy elsewhere shows the count alone, and the
mod takes a file there without that line for someone else's (see the private folder below).

### Updating

Bring Claude Code up to date first (`claude update`): the mod needs 2.1.299 or later, and an older
build refuses it.

From the marketplace, refresh the marketplace's copy of this repository, then update the mod:

```
claude plugin marketplace update compact-lens
claude plugin update compact-lens@compact-lens
```

`claude plugin update` alone answers "already at the latest version" until the marketplace is
refreshed. To get later releases without these steps, open the `compact-lens` marketplace in
`/plugin` and choose Enable auto-update: Claude Code then updates it when it starts.

From a clone, `git pull` in it: Claude Code watches the folder, so a running terminal session
reloads the mod once the files stop changing, and other sessions load the new version when they
start.

A session that is already open keeps the version it has after a marketplace update, and after a
`git pull` when it runs a build older than 2.1.299 (`reload failed, the previous version stays
loaded`): quit it and resume it (`claude --resume`). The resumed session counts every compaction
it has had, from its transcript. Either way, snapshots and pinned notes are kept.

### Turning it off

From the marketplace, `claude plugin uninstall compact-lens@compact-lens` (and
`claude plugin marketplace remove compact-lens` to drop the marketplace too). From a clone, take
the folder out of `CLAUDE_CODE_PLUGIN_DIRS` (or stop passing `--plugin-dir`). Then start a new
session. If you set up the status-line script, take out the ccstatusline widget or the
`statusLine` command too: the script runs without the mod. The snapshots stay in
`~/.claude/compact-lens/` until you delete them; the pinned notes are in
`~/.claude/plugins/store/compact-lens_*.json`.

### Good to know

- **The snapshots hold everything.** `before.md` is the whole compacted transcript, tool results
  included, so anything the session read (a key in a `.env` file, say) is in it. A restore or a
  recall hands Claude passages of the same transcript. It all stays on your machine; don't commit
  or share the folder.
- **A private folder.** Claude Code keeps transcripts readable by you alone, and the snapshots copy
  them, so at each start, and before `/compact-lens statusline` installs the script, the mod makes
  the snapshot folder yours alone too (`chmod 700`, after `mkdir -m 700` when it is not there
  yet). It leaves the mode as it is when the path is not a folder or cannot be read or listed, leads to
  your home folder or above it (through a link, say), or holds files compact-lens did not write (as
  `~/Public` or a photo library does): that mode is yours to set. Then, or when `chmod` fails, a dim line says why, `/compact-lens doctor` shows a
  ✗, and the status-line script is neither installed nor updated there. Where no program can run
  (the desktop and web apps), it leaves the folder as it is and says nothing.
- **What it runs.** To find compactions and passages, the mod runs `perl` (or `grep` where there
  is no perl) and `sed` on the session's transcript file, `~/.claude/projects/<folder>/<session>.jsonl`.
  It only reads it: every command names that one file, and the words you search for are passed
  as data, never as part of a script. A 230 MB transcript is indexed in about half a second.
  Beside those, it runs `chmod 700` (after `mkdir -p -m 700` when it is missing) on the snapshot folder at each start
  and before installing the status-line script, `perl -e 'print "$^V\n"'` for
  `/compact-lens doctor`'s perl check, and, for `/compact-lens prune <days> confirm <code>` and the
  `keepDays` option, `rm -rf --` on each snapshot folder they listed and on the status-line files
  of sessions idle that long, one path at a time, and on nothing else. It runs `chmod`, `mkdir` and
  `rm` from `/bin`, or from your `PATH` where `/bin` has none (NixOS, Termux).
- **Disk.** A compaction of a long session writes a few megabytes. `/compact-lens prune 30` lists
  the sessions untouched for 30 days (the snapshot folder, the transcript and the status-line
  script's files alike), with their sizes: those whose transcript is still there, so compact-lens
  can read their compactions again; those whose transcript is gone, whose snapshots may be the
  only copy left; and those it keeps, with the reason. Claude Code deletes a transcript after
  `cleanupPeriodDays` (30 days unless you set it; the mod reads it from this session's settings), so
  a transcript older than that counts as gone,
  and past that every session falls in the second group. The list ends with the command that
  removes the first two groups, with a code
  (`/compact-lens prune 30 confirm 3f9a1c`) that stands for each folder it removes and the group it
  was listed in: once either changes, that code removes nothing.
  Only you confirm, at the prompt or over Remote Control; a `claude -p` (which Claude can run
  itself), a peer session or another plugin cannot. The `keepDays` option removes only the first
  group, at each start: never an only copy. Nothing removes the current session's folder, one whose
  status-line script ran within the days asked, one holding anything compact-lens did not write, or
  one that may hold an edit not applied yet: a `summary.md` that is not the summary its compaction
  wrote (and that no later apply used), a `draft.md` with text in it, or an edit set aside
  (`edit-unapplied-<time>.md`, `draft-unused.md`, `edit-unsaved-<time>.md`). A session left open
  but idle for the days asked counts as idle too; back in it, `/compact-lens lost` reads a removed
  compaction again from its transcript. Where no program can run (the desktop and web apps), a
  confirm removes nothing and says so, and `keepDays` does nothing.

### Troubleshooting

- **`/compact-lens` is an unknown command.** The mod did not load. Check `claude --version`, then
  that `claude plugin list` shows `compact-lens@compact-lens` enabled, or, for a clone, that the
  path you gave holds `.claude-plugin/plugin.json`. When the module fails to load, a dim
  line in the session says why, and `claude -p --plugin-dir ~/compact-lens "hi"` prints the
  reason on stderr. Once it loads, `/compact-lens doctor` checks the rest.
- **The count says 0, but this session has compacted.** The session started before the mod was
  installed, so it is not running it: quit and resume it (step 2). If `/compact-lens` answers,
  it says when the transcript could not be read here (the desktop and web apps run no
  processes); the mod then counts only the compactions it sees run.
- **A dim line says `reload failed, the previous version stays loaded` (`never across an
  import`).** That session runs a Claude Code older than 2.1.299, which refuses the mod's
  modules, so it keeps the version it had. Quit it, run `claude update` if `claude --version` is
  older, and resume it.
- **A change to my clone does not show.** Another copy loads instead: Claude Code loads one copy
  of a plugin and skips the rest (its debug log says `another plugin of that name loads first`).
  `/compact-lens doctor`'s first line names the folder it loaded. Keep one copy.
- **The line under the prompt does not show.** A status line of your own can leave it no room.
  `/compact-lens statusline` puts the count in yours; see
  [Your own status line](#your-own-status-line).
- **Enter on my edit said "Prompt dropped by a hook".** That is the save; see step 6.
- **`/compact` summarised as usual instead of applying my edit.** No edit was waiting: it was
  cancelled, the text matched the summary already in use, or `/compact` had words after it. While
  an edit waits, `/compact-lens` says so and the line under the prompt ends
  `· /compact applies the edit`.
- **My edit went to `edit-unapplied-<time>.md`.** A newer compaction ran while you were editing.
  Run `/compact-lens edit` again to edit the current summary.

## What it does

**The count.** The session's transcript file records each compaction as a boundary row, and the
n-th one is compaction n. The mod reads the transcript at session start, after each compaction,
and whenever you ask (`list`, `lost`, `restore`, the pane), so its count matches the session's,
whether or not the mod saw each compaction run. A `/clear` or `/resume` moves it to the new
session.

**At every compaction it sees** (`/compact`, the automatic one, or one a plugin asked for), the
mod writes a folder under `~/.claude/compact-lens/<session-id>/<nn>/`:

| File | What it holds |
|---|---|
| `before.md` | the whole transcript that was compacted, one section per message, every tool call with its input and its result (results cut to 1,500 characters) |
| `summary.md` | the summary's text, exactly; edit it and apply it (below) |
| `after.md` | what the context held right after: the summary and the kept messages |
| `lost.md` | what the summary dropped: at a glance, then your prompts verbatim (✓ kept, ✗ barely kept), the files never named after the compaction, and the paths, hashes, URLs, code spans and constants the context no longer holds; then everything the span held (slash commands, files edited and read, commands run, agents spawned) |
| `meta.json` | the record: trigger, time, counts, tokens, and its lines in the transcript |

A compaction it did not see run gets the same folder from the transcript the first time it is
asked for (the latest one at session start); its `before.md` says so.

Right after the summary, the mod inserts one user-role note the model reads: the counts of what
the span held, the recall tool, the three paths, and the pinned notes verbatim. A
`session`-scoped system-prompt section names the snapshot folder, the count of compactions and
the tools, so the orientation survives even when the note itself is compacted away later.

**Getting it back.** `/compact-lens restore [n]` hands Claude your prompts from compaction n's
span, verbatim and timed (16,000 characters at most; past that, the newest). With words after it,
it hands Claude the passages of the compacted spans that hold every word (a `"quoted phrase"` is
kept whole), newest first; where none holds them all, those that hold all but one, each naming the
word it lacks. Both go to the model alone, as context for your next message. The
model's `mcp__compact-lens__recall` tool runs the same search on its own, over every compacted
span or one (`compaction: n`).

A message a compaction kept goes with the compaction that later dropped it. Claude Code keeps
the last few messages through a compaction, so your latest prompt before one is given back with the
next. An apply keeps every message, so `restore` on an apply says it took none of your prompts.

**Ahead of a compaction**, at the first model step where the context is `warnAtPercent` of the way
to auto-compaction (default 80; measured against the window when auto-compaction is off), the
model gets one hidden note: how close it is, where the snapshots go, the recall tool, and that it
can pin facts. Once per window; a compaction re-arms it.

**Pinned notes.** The model calls `mcp__compact-lens__keep` with a fact; you type
`/compact-lens keep <text>`. Pinned notes go into the summariser's instructions ("keep these
verbatim") and, whatever the summariser does, verbatim into the note after the summary.

**Seeing it in the session.** `/compact-lens lost [n]` prints `lost.md`; `/compact-lens show after`,
`show summary 2`, `show before`, `show pinned` print the others (cut at 20,000 characters; the file
keeps the rest). The reply lands in the transcript, so the model reads it too.

**Editing the summary afterwards, in the session.** Run `/compact-lens edit`, or press "Edit
summary" in the pane. The summary the conversation runs on goes into your prompt box under a dim
header line. Edit it there, or press ctrl+g to edit it in your own editor, then press Enter: the
mod catches that prompt before the model sees it and saves it to `<nn>/summary.md`, then puts
`/compact` in the prompt box. Press Enter on that `/compact` to apply the edit. An empty box
cancels; an edit left as it was applies nothing. If the box already holds a draft of yours, the
mod leaves it alone and says so. An edit of an older summary, made before a newer compaction ran,
is kept in `<nn>/edit-unapplied-<time>.md` rather than applied.

**Editing the summary file.** Edit `<nn>/summary.md` yourself, or ask the model to, then:

- the model calls `mcp__compact-lens__apply`: when its turn ends, `/compact` goes into your
  prompt box;
- or you run `/compact-lens apply`, or press "Apply summary.md" in the pane: `/compact` goes into
  the prompt box at once.

Press Enter on `/compact`. While an edit waits, the mod answers a `/compact` with nothing after it
itself: the current summary message is swapped for the file's text, every message after it is
kept as it is, and no summariser runs. It is recorded as the next numbered folder with trigger
`apply`. The status line says when an edit waits. `/compact-lens cancel` drops it; so does a
`/compact` with instructions after it, or an automatic compaction, which compact as usual (the
edit stays in its file). If the apply fails part way, nothing changes and the edit keeps waiting.

Why `/compact` and not a button that applies at once: the engine never shows a plugin's own
`$.session.compact()` to that plugin's `session.compact` hook, so a mod cannot answer a compaction
it asked for; the engine's summariser would run instead. Your `/compact` reaches the hook.

**Where the transcript cannot be read** (no process to run, as in the desktop and web apps), the
mod counts the compactions it sees run, and records the summary in use as an `unseen` compaction
when it did not see the one that wrote it; restore and recall say they cannot search there.

**A precomputed summary** (the engine drafting one ahead of time) is written to `draft.md`. If
you edit it before the compaction lands and the engine reuses the draft, your edit becomes the
summary.

**The pane.** `/compact-lens` opens it: how close auto-compaction is, every compaction in a picker
(buttons on the phone app), the picked one's lost report, the pinned notes, and the buttons
**Give my prompts back** (`r`), **Edit summary** (`e`), **Apply summary.md** (`a`), **Refresh**
(`s`) and **Close**; a compaction not read from the transcript yet has **Read what it dropped**
(`l`) first. The status line under the prompt reads
`compact-lens: 412k of 467k before auto-compaction (88%) · 3 compactions · 1 pinned`, and adds
`· /compact applies the edit` while an edit waits.

**Checking the setup.** `/compact-lens doctor` prints a line for each thing the mod depends on,
under a heading that names the versions and the folder the mod was loaded from. The first time a
version runs, a toast says so: `compact-lens 0.5.0 is running. /compact-lens doctor checks the
setup; /compact-lens statusline puts the count in your own status line`, and after an update the
same with `(was 0.5.0)` after the version.

**Old snapshots.** `/compact-lens prune <days>` lists the session folders under the snapshot root
that are not this session's and are untouched for that many days: the folder, the session's
transcript (under this session's config folder, the default one and every `~/.claude*` one) and its
status-line script's files. A folder may go when it is the mod's alone (named like a session id,
holding nothing but compaction folders of the files it writes, `pinned.md`, `draft.md` and edits
set aside; Finder's `.DS_Store` changes nothing) and may hold no edit; those whose transcript is
gone, or older than `cleanupPeriodDays`, are listed apart, as the only copy. A folder that may hold an edit, and one holding files the
mod did not write, are listed as kept. `prune <days> confirm <code>`, typed by you with the code the
list gave, removes the ones that may go, with the status-line files of sessions idle that long.
With `keepDays` set, the folders whose transcripts are still there, and younger than
`cleanupPeriodDays`, go ten seconds after each session starts; the only copies stay. A `summary.md` the mod writes from the transcript gets a
`summary.hash` beside it, the mark of its text, so a prune tells it from an edit before the
compaction's record is written. A record from 0.1.0 or 0.2.0 names its summary by the opening
alone, so such a summary counts as unedited only where `after.md` holds it whole; one it cannot
vouch for (a summary over 20,000 characters, say) keeps its folder.

**Your own status line.** `/compact-lens statusline` copies `bin/statusline.pl` to the snapshot
root, where its path stays put across updates, and never over a `statusline.pl` it did not write.
Once it is there, the mod writes `.statusline/<session-id>.json` (the pinned notes and a waiting
edit) whenever they change (a session that started before the install picks the script up at its
next model step or pin, once a minute at most), and each session start puts its own version of the
script in place. The script keeps its count in `.statusline/<session-id>.count`.

Subagent compactions pass through untouched.

## Options

With `/plugin configure compact-lens@compact-lens` in a session; a clone's are rows in `/config`, or
`pluginConfigs.compact-lens` in settings:

| Option | Default | Meaning |
|---|---|---|
| `warnAtPercent` | 80 | how close to auto-compaction, in percent of the way there, the model gets the one note ahead of a compaction; 0 turns it off |
| `dir` | `""` | the snapshot root: a full path, or one under `~/`, that is not your home folder or a folder above it (the mod makes it private, unless it leads to your home folder or holds files compact-lens did not write); empty, or anything else, means `~/.claude/compact-lens` |
| `openPane` | false | open the pane at session start (a wide terminal seats it) |
| `statusLine` | true | the line under the prompt |
| `keepDays` | 0 | at each session start, remove the snapshots of other sessions untouched (folder, transcript and status-line script) for longer than this many days whose transcripts are still there and younger than Claude Code's `cleanupPeriodDays` (30 unless set), never an only copy, so it removes something only below that; a value under 7 counts as 7; 0 keeps them all |

## Layout

```
.claude-plugin/plugin.json       the manifest, the options, the state contract's path
.claude-plugin/marketplace.json  the repository as a marketplace of one, so it installs by name
hooks/hooks.json     names the hooks module
hooks/register.tsx   the hooks: which event goes to which part
hooks/history.ts     the compactions as the transcript records them; reading one on demand
hooks/reader.ts      perl, grep and sed over the transcript, read-only
hooks/transcript.ts  transcript rows → boundaries, spans, messages (pure)
hooks/compaction.ts  the session.compact hook: snapshots, the note, the apply
hooks/restore.ts     restore and recall: what goes back to the model
hooks/recall.ts      the search and the blocks handed to the model (pure)
hooks/commands.ts    /compact-lens and its verbs
hooks/doctor.ts      /compact-lens doctor: a line a check
hooks/version.ts     the mod's own version and the one-time notice
hooks/prune.ts       old snapshots: what may go, /compact-lens prune and keepDays
hooks/statusline.ts  the status-line script installed and kept current; the session's status for it
hooks/run.ts         a command run for its effect alone (rm, mkdir, chmod), from /bin or the PATH
hooks/privacy.ts     the snapshot folder made private, or why its mode is left as it is
hooks/writes.ts      the files every kind of record writes the same way
hooks/pane.tsx       the pane
hooks/edit.ts        the edit in the prompt box; editor.ts its pure parts
hooks/apply.ts       readying an edited summary for the person's /compact
hooks/ahead.ts       the context against auto-compaction: the status line and the warning
hooks/session.ts     which session the values belong to (/clear, /resume)
hooks/state.ts       the values a drawing reads (the state atoms)
hooks/pins.ts        pinned notes
hooks/lost.ts        the lost report's figures; report.ts renders it (pure)
hooks/records.ts     a compaction's record (pure)
hooks/notes.ts       the note, the warning, the system-prompt section (pure)
hooks/texts.ts       the replies, the help and the tools' descriptions (pure)
hooks/snapshot.ts    messages → before.md / after.md (pure)
hooks/paths.ts       the folder layout and the limits (pure)
hooks/config.ts      the options
types/index.d.ts     the $.state contract
bin/statusline.pl    the status-line script (perl, read-only on the transcript)
tests/               claude plugin test, with a stand-in host for perl, grep and sed
tools/               replay (the mod's own modules on any transcript, outside a session) and the Node tests
Makefile             make check: validate, test, typecheck, tools-test
.github/workflows/   CI: validate and the tests on 2.1.299 and the latest Claude Code
CONTRIBUTING.md      how to work on it: setup, checks, the engine's rules, the transcript's facts
CHANGELOG.md         what each version changed
LICENSE              MIT
```

The engine's validator follows `$` past an import only into `function` declarations, so every
part that takes `$` is one, and it reads a state atom only in the file that makes it, so the atoms
and their readers and writers are in `hooks/state.ts`.

## Checking it

```
make check
```

runs `claude plugin validate --strict .`, `claude plugin test .`, `tsc -p . --noEmit` and the
tools' Node tests. The type check needs the declarations the engine lays beside a loaded mod
(`.claude-plugin/types/`), and the build that last loaded the folder writes them, so load the clone
once with Claude Code 2.1.299 or later first (`claude --plugin-dir .`): an older build's
declarations lack what the mod uses. CI runs the rest
on every push. [CONTRIBUTING.md](CONTRIBUTING.md) has the details, and `tools/README.md` how to
replay the mod on any transcript.

## License

MIT; see [LICENSE](LICENSE).
