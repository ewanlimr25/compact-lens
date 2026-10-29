// The engine's 'claude-code' module as tools/replay.mjs needs it: the three state functions
// hooks/state.ts calls at runtime, over the replay engine's `$.state`. Node strips the types, so
// nothing else of the module is ever asked for.

/** A named value with its initial, as the engine's `atom` makes one. */
export const atom = (ref, initial) => Object.freeze({ ref, initial })

/** The value an atom holds, its initial while nothing is written. */
export const read = async ($, cell) => {
  const held = $.state.get(cell.ref)
  return held.isSet ? held.value : cell.initial
}

/** Reads the atom, applies `fn` and writes what it answers; resolves to the new value. */
export const update = async ($, cell, fn) => {
  const next = fn(await read($, cell))
  $.state.set(cell.ref, next)
  return next
}
