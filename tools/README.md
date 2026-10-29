# tools

Tools for working on compact-lens. None of this is part of the mod: Claude Code never loads it.

## replay: the mod's own code against any transcript

`replay.mjs` runs the mod's real modules (`hooks/*.ts`) against a transcript file, outside Claude
Code. A report such as "recall did not find X" can then be reproduced from the transcript alone,
and a change to the code checked against it, without starting a session.

```
node tools/replay.mjs <transcript.jsonl> list
node tools/replay.mjs <transcript.jsonl> lost [n]
node tools/replay.mjs <transcript.jsonl> prompts [n]
node tools/replay.mjs <transcript.jsonl> recall "<words>" [n]
```

- `list` gives every compaction the transcript holds: its trigger, time, tokens and transcript lines
  (the span it summarised, its boundary row and its summary row).
- `lost [n]` prints what compaction n dropped, as its `lost.md` has it (the latest when n is left
  out).
- `prompts [n]` prints the person's prompts from compaction n's span, as `/compact-lens restore n`
  hands them to Claude.
- `recall "<words>" [n]` prints the passages that hold the words, as the model's recall tool and
  `/compact-lens restore [n] <words>` return them.

The answer goes to standard output. The mod's toasts and log lines, and the time the run took, go to
standard error. The exit code is 0 when the mod answered, 1 when it said why it could not (the reason
is printed), and 2 when the command line was wrong.

A transcript is under `~/.claude/projects/<project folder>/<session id>.jsonl`. The session id is
the file's name, so keep the name when copying one somewhere else. The tool only reads the
transcript. The snapshots the mod writes go under a scratch home in the system's temporary folder,
removed when the run ends; `--keep` keeps it and prints where it is. Nothing is written to
`~/.claude/compact-lens`.

It needs a Node that strips TypeScript types by itself (22.18 or later, 23.6 or later, or 24), and
perl or grep, and sed, as the mod does.

### How it works

- `loader.mjs` is a resolve hook the tool registers (`module.register`). It points the engine's
  `claude-code` module at `shim/claude-code.mjs`, and turns the mod's extensionless relative imports
  (`./history`) into the `.ts` files they mean.
- `shim/claude-code.mjs` holds `atom`, `read` and `update`, the only runtime part of `claude-code`
  the modules use (`hooks/state.ts`).
- `engine.mjs` is the `$`, backed by Node: files, processes, the environment, a store with nothing in
  it, and one session whose id comes from the transcript's name. It holds only the methods the
  replayed functions call. Any other method throws `replay: $.<noun>.<method> is not shimmed`: add
  it there when a module starts calling something new.

The `.tsx` modules (`register.tsx`, `pane.tsx`) are never imported: Node's type stripping does not
compile JSX.

### Tests

```
node --test 'tools/test/*.test.mjs'
```

The quotes keep the pattern for Node to expand. Node 24 takes a folder given to `--test` as a module
to run, not as a folder of tests. The tests are `.mjs`, not `.test.ts`, because `claude plugin test`
runs every `*.test.ts` under the mod's folder in the mod's own environment. They build their
transcript from the mod's test rows (`tests/rows.ts`).
