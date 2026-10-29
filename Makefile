# The checks a change passes before it is committed (CONTRIBUTING.md): the manifest and the modules as
# the engine reads them, the mod's tests, the types, and the tools' own tests. `make check` runs them all.
CLAUDE ?= claude
TSC ?= tsc
NODE ?= node
# A CLAUDE_CODE_PLUGIN_DIRS in the environment (a settings.json's env puts it in every session's) names other
# plugin folders to load; the engine's checks read this folder alone.
ISOLATED = env -u CLAUDE_CODE_PLUGIN_DIRS

.PHONY: check validate test typecheck tools-test

check: validate test typecheck tools-test

validate:
	$(ISOLATED) $(CLAUDE) plugin validate --strict .

test:
	$(ISOLATED) $(CLAUDE) plugin test .

# The engine lays .claude-plugin/types/ once it has loaded the mod (claude --plugin-dir .), not before.
typecheck:
	@test -f .claude-plugin/types/tsconfig.json || { echo "typecheck: .claude-plugin/types/ is not there yet: load the mod once (claude --plugin-dir .), then run it again"; exit 1; }
	$(TSC) -p . --noEmit

# A quoted glob: Node 24 reads a bare folder as a module to run.
tools-test:
	$(NODE) --test 'tools/test/*.test.mjs'
