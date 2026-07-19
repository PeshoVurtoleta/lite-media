# Changelog

## 1.1.0 — Engine B + createMedia

### Added

- **`containerMedia(el, query)`** — Engine B: browser-native container-query verdicts via an injected `@container` rule + zero-size sentinel + `transitionrun` event on a registered `<custom-ident>` custom property (`--lm-v`). Same signal-graph surface as `media()`; cached per (element, query) pair via a WeakMap on the element, so detached elements become GC-eligible along with their signals.
- **`createMedia({ matchMedia, ssrDefault, containerEngine })`** — scoped instances with their own memoization cache and options. Unblocks per-request SSR (each request creates a fresh instance) and enables clean test isolation without touching module state. This is now the fundamental factory; the module-level `media`, `configure`, preferences, and `containerMedia` delegate to a lazily-created default instance backed by `createMedia()`.
- **`configure({ containerEngine })`** — new option on the default instance. Accepts any object with a `watch(el, query, onChange)` method returning `{ initial, dispose }`. Malformed values throw `TypeError`.
- **`bench/bench.mjs`** — machine-stamped benchmark harness. Prints spec-style table + emits `--json` for CI gating. Headline numbers now live in the README.

### Design commitments locked at 1.1.0

- **Engine B follows the same one-line rule as Engine A.** JS never evaluates a container query. The browser evaluates via `@container`, custom-property discrete transitions flip a signal, and lite-media only observes.
- **No custom-property namespace pollution.** Engine B registers exactly one CSS custom property (`--lm-v`) as `<custom-ident>` with an `off` initial value. Every unique query gets its own `@container` rule inside a shared stylesheet — never a per-query custom property.
- **Backward compatible.** Every v1.0 export retains identical semantics. The lock still engages on successful materialization only; the module-level `configure()` still throws on non-function `matchMedia` and preserves previous `ssrDefault` on `undefined`.
- **Scoped instances do not lock.** `createMedia({ ... })` accepts options at creation and returns a `ScopedMedia` object without a `configure()` method. Instances are the answer to "how do I reconfigure mid-flight" — you don't; you make a new one.
- **Bounded static query set precondition extended to containerMedia.** Its queries are injected into a live stylesheet, so passing untrusted input is an XSS-adjacent bug in the caller. Documentation makes the constraint explicit.

### Test coverage

90 tests across 10 files. Suite passes on Node 18+ and Windows (bare `node --test` discovery, no quoted globs). Each test file runs in its own Node subprocess, so lite-signal's per-process 1024-node budget resets per file.

- **`test/01-media.test.mjs`** — memoization, distinct queries, initial state, change updates, effect wiring + `Object.is` dedupe, preference shortcut ↔ query mapping (v1.0).
- **`test/02-configure.test.mjs`** — validation, lock semantics, failed-materialization recovery, bad-shape mocks (v1.0 + updated for v1.1's expanded `configure()` shape).
- **`test/03-zero-gc.test.mjs`** — heap-delta guard under `--expose-gc`, timer-count guard.
- **`test/04-container.test.mjs`** — `containerMedia()` via mock engine: initial verdict, per-(el, query) memoization, distinct elements & queries, effect wiring, argument validation, WeakMap GC-eligibility sanity, SSR-inert engine.
- **`test/05-createmedia.test.mjs`** — `createMedia()` isolation: independent caches, cross-instance no-leak on flip, per-instance stats, no-lock semantics, per-request pattern with alternating `ssrDefault`.
- **`test/06-torture-edges.test.mjs`** — degenerate queries (empty, whitespace, unicode, quotes, 10 KB, prototype-adjacent), 1000-cycle subscribe/unsubscribe on a single signal, mixed `media()` + `containerMedia()` coexistence, 100 containerMedia signals across 10 elements.
- **`test/07-torture-scale.test.mjs`** — 400 distinct queries, 10 K cache-hit timing budget, 300-subscriber fanout with `Object.is` dedupe.
- **`test/08-torture-isolation.test.mjs`** — 30 × 6 createMedia instances × queries; 50 scoped `createMedia()` invocations that must not accumulate.
- **`test/09-torture-capacity.test.mjs`** — deliberate lite-signal node-budget overflow: verifies the failure surfaces as a named `CapacityError`, not silent corruption. In its own file because the test intentionally exhausts the subprocess pool.
- **`test/10-nasty.test.mjs`** — malformed MQL shapes (missing `addEventListener`, function return, throwing `addEventListener`, getter-based `matches`), throwing effect co-subscribed with a good effect, self-unsubscribing effect, effect that materializes another signal, runtime `.set()` desync (documented anti-pattern), cross-instance leak attempts, prototype-pollution attempts via query string, configure-race recovery.

### Benchmark headline numbers

Measured on Apple M4 Pro (12 cores) · Node 26.3.1 · darwin/arm64. Harness emits a machine stamp so numbers are reproducible.

- `media()` cache hit: **213 M ops/s** (4.7 ns)
- Signal read (call-style): **1.44 B ops/s** (0.7 ns)
- Change event → sig.set → effect (1 sub): **46 M ops/s** (21.8 ns)
- Fanout to 100 subscribers: 1.18 μs per flip (~12 ns/sub)
- `createMedia()` instance creation: 47.8 ns
- Cold materialize (mock MQL): 624 ns
- `createMedia()` + 5 signals wired: 1.48 μs

Bundle size: **2,153 B min+gz** for the full v1.1 module (up from v1.0's 910 B, reflecting the Engine B implementation + `createMedia()` factory surface).

## 1.0.0 — Engine A: viewport & preferences

Initial release. Engine A complete.

### Added

- **`media(query)`** — memoized reactive `Signal<boolean>` for a CSS media query.
- **8 curated preference shortcuts** — `reducedMotion`, `darkScheme`, `hoverCapable`, `coarsePointer`, `forcedColors`, `moreContrast`, `reducedData`, `reducedTransparency`.
- **`configure({ matchMedia, ssrDefault })`** — test / SSR seam with validation.
- **`stats()`** — cheap live snapshot.
- **`__resetForTests()`** — internal escape hatch.

### Design commitments

- Zero-GC steady state.
- Scoped SSR claim.
- JS never evaluates a query.
- Bounded query set precondition.
- Read-only by convention.
- Single runtime dep (`@zakkster/lite-signal`).
