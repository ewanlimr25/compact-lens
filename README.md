# compact-lens

A Claude Code mod that shows what a compaction takes away and what it leaves, lets the model pin
facts that must survive it, and lets the model or you edit the summary afterwards.

It is a plugin of function hooks (Claude Code 2.1.288 or later). It hooks `session.compact`, the
one event that carries the transcript being compacted and the result the engine produces.

## What it does

**At every compaction** (`/compact`, the automatic one, or one a plugin asked for), the mod writes
a folder under `~/.claude/compact-lens/<session-id>/<nn>/`:

| File | What it holds |
|---|---|
| `before.md` | the whole transcript that was compacted, one section per message, every tool call with its input and its result (results cut to 1,500 characters) |
| `before.json` | the same, raw and uncut |
| `summary.md` | the summary's text, exactly; edit it and apply it (below) |
| `after.md` | what the context held right after: the summary and the kept messages |
| `lost.md` | what the summary does not mention: the person's prompts verbatim, files edited and read, commands run, agents spawned, and the paths, hashes, URLs, code spans and constants of the compacted span that the context after it no longer holds |
| `meta.json` | the record: trigger, time, message counts, token counts |

Right after the summary, the mod inserts one user-role note the model reads: the counts, the three
paths, and the pinned notes verbatim. A `session`-scoped system-prompt section names the snapshot
folder, the count of compactions and the two tools, so the orientation survives even when the note
itself is compacted away later.

**Ahead of a compaction**, at the first model step where the context fill reaches `warnAtPercent`
(default 70), the model gets one hidden note: the fill, where the snapshots will go, and that it
can pin facts. Once per window; a compaction re-arms it.

**Pinned notes.** The model calls `mcp__compact-lens__keep` with a fact; you type
`/compact-lens keep <text>`. Pinned notes go into the summariser's instructions ("keep these
verbatim") and, whatever the summariser does, verbatim into the note after the summary.

**Editing the summary afterwards, in the session.** Run `/compact-lens edit`, or press "Edit
summary" in the pane. The latest summary goes into your prompt box under a dim header line. Edit
it there, or press ctrl+g to edit it in your own editor, then press Enter: the mod catches that
prompt before the model sees it, saves it to `<nn>/summary.md` and applies it. An empty box
cancels. If the box already holds a draft of yours, the mod leaves it alone and says so. An edit
of an older summary, made before a newer compaction ran, is kept in `<nn>/edit-unapplied.md`
rather than applied.

**Editing the summary file.** Edit `<nn>/summary.md` yourself, or ask the model to, then:

- the model calls `mcp__compact-lens__apply`: the replacement runs when its turn ends;
- or you run `/compact-lens apply`, or press "Apply summary.md" in the pane: it runs in a
  moment, or when the running turn ends.

The replacement is a plugin-triggered compaction that the mod's own hook answers: the current
summary message is swapped for the file's text, every message after it is kept as it is, and no
summariser runs. It is recorded as the next numbered folder with trigger `apply`.

**A precomputed summary** (the engine drafting one ahead of time) is written to `draft.md`. If
you edit it before the compaction lands and the engine reuses the draft, your edit becomes the
summary.

**The pane.** `/compact-lens` opens it: the fill, the compactions, the pinned notes, and the
edit, apply and refresh buttons. `/compact-lens list` prints the same as text. A status line under the
prompt reads `compact-lens: 72% · 1 compaction · 2 pinned`.

Subagent compactions pass through untouched.

## Loading it

Pick one:

- for one session: `claude --plugin-dir /path/to/compact-lens`
- for every session: add `CLAUDE_CODE_PLUGIN_DIRS=/path/to/compact-lens` to the `env` block of
  `~/.claude/settings.json`, or symlink the folder as `~/.claude/skills/compact-lens` (a plugin
  there auto-loads)

## Options

In `/config` under the plugin, or `pluginConfigs.compact-lens` in settings:

| Option | Default | Meaning |
|---|---|---|
| `warnAtPercent` | 70 | the fill at which the model gets the one note ahead of a compaction; 0 turns it off |
| `dir` | `""` | the snapshot root; empty means `~/.claude/compact-lens` |
| `openPane` | false | open the pane at session start (a wide terminal seats it) |
| `statusLine` | true | the line under the prompt |

## Layout

```
.claude-plugin/plugin.json   the manifest, the options, the state contract's path
hooks/hooks.json             names the hooks module
hooks/register.tsx           every call on `$`: the hooks, the compaction, the tools, the command, the pane
hooks/editor.ts              the edit in the prompt box: its header, finding it, judging it (pure)
hooks/records.ts             a compaction's record and the message helpers (pure)
hooks/texts.ts               the command's help and the tools' descriptions (pure)
hooks/snapshot.ts            SessionMessage[] → before.md / after.md (pure)
hooks/lost.ts                the lost report (pure)
hooks/notes.ts               the note, the warning, the system-prompt section (pure)
hooks/paths.ts               the folder layout and the limits (pure)
types/index.d.ts             the $.state contract
tests/                       claude plugin test
```

Every call on `$` sits in `hooks/register.tsx` because the engine's validator follows `$` only
into functions declared in the hooks module itself, and reads the state atoms there alone.

## Checking it

```
claude plugin validate .
claude plugin test .
```

Type-check with the declarations the engine lays beside a loaded mod (`.claude-plugin/types/`),
or with a `tsconfig.json` that includes the `claude-code.d.ts` the plugin-authoring skill writes.
