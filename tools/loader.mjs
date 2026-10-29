// The resolve hook tools/replay.mjs registers, so Node runs the mod's own modules outside Claude Code.
// The engine's 'claude-code' module is the shim beside this file, and a relative import without an
// extension, made from a .ts module, names the .ts file it means: the mod writes `./history`, Node
// wants `./history.ts`. Node strips the types itself, so nothing here reads or changes a module's text.

const SHIM = new URL('./shim/claude-code.mjs', import.meta.url).href

/** A relative specifier with no extension of its own, as `./history` and `../types` are. */
const isBareRelative = specifier => /^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier)

/** Says a .ts module is an ES module, so Node neither guesses nor warns that it had to. */
const asTypeScript = resolved => (resolved.url.endsWith('.ts') && resolved.format == null ? { ...resolved, format: 'module-typescript' } : resolved)

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'claude-code') return { url: SHIM, format: 'module', shortCircuit: true }
  const isFromTypeScript = context.parentURL?.endsWith('.ts') === true
  const wanted = isFromTypeScript && isBareRelative(specifier) ? `${specifier}.ts` : specifier
  return asTypeScript(await nextResolve(wanted, context))
}
