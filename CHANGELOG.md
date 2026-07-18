# Changelog

## 1.0.0 — Engine A: viewport & preferences

Initial release. Engine A is complete; engine B (container queries) lands in 1.1.0.

### Added

- **`media(query)`** — memoized reactive `Signal<boolean>` for a CSS media query. Same query string returns the same signal instance; one browser event flips one signal; lite-signal's `Object.is` equality drops redundant events.
- **8 curated preference shortcuts** — `reducedMotion`, `darkScheme`, `hoverCapable`, `coarsePointer`, `forcedColors`, `moreContrast`, `reducedData`, `reducedTransparency`. Each is `() => MediaSignal`; hoist once per component, then read call-style.
- **`configure({ matchMedia, ssrDefault })`** — test / SSR seam with validation:
  - Non-function `matchMedia` throws `TypeError` at the call site.
  - Non-boolean `ssrDefault` is a no-op (does not un-set a previously configured default).
  - `null` / `undefined` / non-object input are safe no-ops.
  - Multiple pre-lock calls compose; reconfiguration after a **successful** materialization throws.
  - Failed materialization does **not** engage the lock — the module remains recoverable.
- **`stats()`** — cheap live snapshot (`{ watched, configured, locked }`) for demos, perf overlays, and test assertions. `configured` reflects explicit user configuration, not native `globalThis.matchMedia` fallback.
- **`__resetForTests()`** — internal escape hatch. Not part of the semver contract; the double-underscore prefix is the signal.

### Design commitments locked at 1.0.0

- **Zero-GC steady state.** No timers, no debounce, no schedulers. A `change` event runs one hoisted handler that does one `sig.set()`. Steady-state allocation is 0; cache-miss cost is 1 signal + 1 handler closure + 1 MQL (plus one bound-native function allocated *once per process* on the first native-path miss).
- **Scoped SSR claim.** `ssrDefault` is a process-wide constant. Per-request SSR values are fundamentally incompatible with module-global memoization — the first materialization wins for the process. A `createMedia()` factory for scoped instances is on the v1.1.0 roadmap.
- **JS never evaluates a query.** The browser evaluates via `matchMedia`; lite-media only observes the verdict. Container-query correctness (v1.1.0) will follow the same principle via an injected `@container` rule + `transitionrun` on a sentinel — never a JS parser.
- **Bounded query set precondition.** Memoization has no eviction. Query strings must come from a bounded static set. Building queries from unbounded input leaks signals and change listeners — see README "Memoization contract."
- **Read-only by convention.** `MediaSignal` in the `.d.ts` hides `.set`/`.update`. At runtime the returned object is still a lite-signal `Signal`, so writes are possible but permanently desync the shared signal from the browser. Wrap in a `computed()` if you need write access.
- **Single runtime dep.** `@zakkster/lite-signal` only.

### Test coverage

31 tests across three files. Suite passes on Node 18+ and Windows (bare `node --test` discovery, no quoted globs).

- `test/01-media.test.mjs` — memoization, distinct queries, initial state, change updates, effect wiring + `Object.is` dedupe, `peek`, `stats` bookkeeping, preference shortcut ↔ query mapping, shared cache with `media()`, reduced-motion gate recipe.
- `test/02-configure.test.mjs` — null/undefined/non-object safety, non-function `matchMedia` throws `TypeError`, `ssrDefault: undefined` no-op semantics, SSR default (true/false/absent), lock semantics, **failed materialization recovery**, multi-call composition, factory-args contract, **bad-shape mock throws with `MockMediaQueryList` guidance**.
- `test/03-zero-gc.test.mjs` — heap-delta guard (10k flips × 20 signals under `--expose-gc`, budget 200 KB); timer-count guard (`setTimeout` / `setInterval` wrapped, must never be called on the media path).

Run: `npm test` for behavior; `npm run test:gc` for the heap-delta guard.
