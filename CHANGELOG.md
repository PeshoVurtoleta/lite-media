# Changelog

## 1.5.1 — hardening: mechanical source-ASCII gate

**Runtime identical to 1.5.0.** Hardening-only patch. No public API change, no new export, no change to the shipped runtime — the only edit to `Media.js` is its version-header comment (stripped by minify), so the **minified bundle is byte-identical to 1.5.0 at 3,529 B** min+gz. Peer dependency stays `@zakkster/lite-signal ^1.3.0`.

### Tests + torture

- New `test/21-ascii.test.mjs` (4 tests): mechanizes the source-only ASCII Law. A pure `scanAscii(text, file)` flags every codepoint > U+007F except the two allowed exceptions (U+00D7, U+00B5), reporting 1-based `line`/`col` and `U+XXXX`. The gate scans the real source set — `Media.js`, `Media.d.ts`, every `test/*.mjs`, every `bench/*.mjs` (selected by extension, so `torture.mjs` and the gate file itself are covered) — and asserts zero findings; docs (`.md`/`.txt`/`.html`) and `demo/**` are outside the Law and not scanned. A **failing control** feeds an em-dash (U+2014) and asserts exactly one finding at the correct location, proving the gate bites; a third test confirms U+00D7 and U+00B5 produce zero findings; a fourth confirms neighboring codepoints (U+00B4/U+00B6 around micro, U+00D6/U+00D8 around the multiplication sign) are still flagged, guarding the exception list against range-widening.

### Notes

- The only change to `Media.js` is its version-header comment (`v1.5.0` -> `v1.5.1`), keeping the version in sync across `package.json`, `Media.js`, and `Media.d.ts` per the packaging convention. The comment is stripped by minification, so the runtime is unchanged and the min+gz bundle is byte-identical to 1.5.0.

## 1.5.0 — ecosystem wiring (Option A): reduced-motion rAF-gate recipe

**Runtime identical to 1.4.1.** This release ships the reduced-motion rAF-gate recipe, its conformance + torture gates, the vendor-vs-depend decision record, and a demo scene. No new public API, no new export, no change to the shipped runtime — the only edit to `Media.js` is its version-header comment (stripped by minify), so the **minified bundle is byte-identical to 1.4.1 at 3,529 B** min+gz. Peer dependency stays `@zakkster/lite-signal ^1.3.0`.

### Added

- **Reduced-motion rAF-gate recipe** (docs). A tested, copy-pasteable pattern for consumers **already in the lite-signal graph**: gate a `requestAnimationFrame` loop on `reducedMotion()` with a single `effect`. On the preference flipping ON the loop **parks** (cancels the in-flight frame, schedules nothing); flipping OFF **resumes**; `dispose()` fires `onCleanup` which cancels the last frame. `reducedMotion()` is read **inside** the effect body so the dependency is tracked; `raf`/`cancel` are **injected**, never `globalThis`-patched (a global patch would hide the SSR / no-rAF fail-closed path the recipe documents). See README "Reduced-motion rAF gate".
- **Ecosystem decision record** (docs). Packages with a zero-dependency identity (`lite-ambient-fx`, `lite-scratch-fx`) **keep vendoring** their own `prefers-reduced-motion` `matchMedia` check — the core stays zero-dep, any heavier capability lives behind an optional peer / separate export path; lite-media does **not** become their runtime dependency. The rAF-gate recipe is for consumers who already depend on `@zakkster/lite-signal`, where `reducedMotion()` + `effect({ scheduler })` replaces ad-hoc checks at no new dependency cost. See README "Ecosystem — vendor vs depend".
- **Demo scene** (`demo/index.html`, dev-only, not shipped): reduced-motion gating a live rAF animation (running bars vs parked), in the existing oscilloscope theme.

### Tests + torture

- New `test/20-raf-gate.test.mjs` (9 tests): the recipe under a local `makeGate` helper driven by an **injected** fake scheduler and an injected `matchMedia` (scoped `createMedia()` instance for isolation). Asserts the transition sequence — no rAF scheduled while reduced-motion is ON at creation; the loop starts on the flip to OFF; the loop **parks** (cancel fires, no further raf) on the flip to ON; a second OFF resumes; `dispose()` tears everything down with no orphaned frame callback (`onCleanup` fired) — plus duplicate-event and dispose-while-parked safety.
- New torture tiers, committed: **`rafGate.bytesPerFlip = 0`** and **`rafGate.majors = 0`** over ~2000 iters × 8 batches / a 20,000-flip storm; **`rafGate.framesWhileParked = 0`**; a **retaining** control trips the 0-B gate; a **no-cancel** control yields `framesWhileParked = 1000` (proving the cancel is load-bearing); and a **live-set** tier — 4096 attach/park/dispose cycles return the tracker to **0** (deterministic seam, not GC-timing), with a **forget-dispose** control leaving 512.

### Notes

- The only change to `Media.js` is its version-header comment (`v1.4.1` -> `v1.5.0`), keeping the version in sync across `package.json`, `Media.js`, and `Media.d.ts` per the packaging convention. The comment is stripped by minification, so the runtime is unchanged and the min+gz bundle is byte-identical to 1.4.1.

## 1.4.1 — bfcache / pageshow lifecycle audit

M2 finish. **No public API change** — every existing signature is identical. This is a transparent correctness release: a page restored from the back/forward cache now re-pins its signals instead of holding a stale answer. Peer dependency stays `@zakkster/lite-signal ^1.3.0`.

### Fixed

- **A signal no longer sits stale after a bfcache restore.** A page restored from the back/forward cache does **not** re-fire matchMedia `change` or container `transitionrun`, so a signal could hold an answer that went stale while the page was frozen (dark mode toggled, the viewport resized, a container crossed a breakpoint). Each instance now lazily attaches **one** `pageshow` listener (on its first `media()` / `containerMedia()`) that no-ops unless `event.persisted === true`, then re-reads every watched `mql.matches` (Engine A) and every live sentinel's computed `--lm-v` (Engine B) and re-pushes the fresh boolean through the **same** `sig.set` path a real event uses.

### Changed / internal

- **Engine A** gains a per-instance `mqls` Map — a sibling of the `cache`, keyed by the same query string, holding each live `MediaQueryList`. Populated on `media()`'s **cold path only**; the hot cache-hit read is untouched. `_resync()` re-reads each `mql.matches` and re-pushes it. Bounded exactly like `cache` (one entry per distinct query). `ssrDefault` signals have no `mql` and are skipped.
- **Engine B** gains a per-engine `live` Set of `{ verdict, onChange }` records. `watch()` adds; `dispose()` **deletes first**, always. `engine.resync()` re-reads each live verdict and re-pushes it. The Set is a **strong** ref, so `dispose()` deleting its entry is load-bearing — a forgotten delete would pin the record → verdict → computed style → sentinel for the page lifetime. The torture live-set tier guards exactly this.
- **Fail-closed everywhere.** Each Engine-A entry, each Engine-B entry, and the `pageshow` attach are individually wrapped: a throwing `matches` getter, a throwing verdict read, or a no-DOM environment (no `globalThis.addEventListener`) degrades to a per-entry skip / a silent no-op — never aborts the loop, never throws to the caller. Resync is triggered by `pageshow` with `persisted === true` **only** — not `visibilitychange` (a tab hidden/shown in place keeps firing live events and needs no resync).
- The hot read/flip paths are **unchanged** and stay 0-alloc; the only new steady-state work happens on the rare, cold `pageshow` restore.

### Tests + torture

- New `test/19-bfcache.test.mjs`: a stale Engine A verdict snaps correct on a persisted pageshow (and stays stale on a non-persisted one); unchanged restore fires **0** effect runs while a mutated restore fires **exactly 1**; instance A's resync leaves instance B untouched (verdict and run count); SSR / no-DOM resync never throws; a throwing `matches` getter is fail-closed per entry; the real `pageshow` listener attaches at most once per instance and gates on `persisted`; Engine B container verdicts re-pin through `engine.resync()`, a disposed watcher is off the live set, and a throwing verdict read is fail-closed per entry.
- New torture tier, committed: **0 B retained per unchanged restore** and **0 major GC** across a 20,000-restore storm; a **mutating** control proving a verdict that moved while frozen propagates (unchanged +0 runs, mutated +1 run); a **retaining** control proving the 0-B gate can fail; and an **Engine B live-set retention** gate — after 4,096 watch/resync/dispose cycles the engine's live-set size returns to **0** (asserted directly and deterministically via the `@internal` `_liveSize()` seam, so removing `dispose()`'s `live.delete` trips it immediately, with the leak tracker kept as a real-browser finalization proxy; the paired control leaves a batch undisposed and confirms the size gate is load-bearing).

### Notes

- Bundle size is now **~3.5 KB min+gz** (3,529 B, esbuild + `gzip -9`, lite-signal external) — up from 3,265 B at 1.4.0, the cost of the per-instance `mqls` Map, the per-engine `live` Set, and the resync + `pageshow` wiring.
- `createMedia()` now allocates one additional `Map` (the `mqls` sibling) per instance — reflected in the allocation-profile table. `createMedia()` is a cold factory op, not a hot path.
- **In-browser scope:** the `pageshow` listener is attached for the page lifetime and never removed (consistent with the page-lifetime memoization contract). In Node / SSR there is no `globalThis.addEventListener`, so nothing is attached — per-request scoped instances retain nothing.

## 1.4.0 — multi-root Engine B (shadow DOM + cross-realm iframe)

M2 hardening. **No public API change** — `containerMedia()` and `containerStyle()` keep their exact signatures. This is a transparent correctness/robustness release, bumped to a minor per the roadmap because it adds a capability class. Peer dependency stays `@zakkster/lite-signal ^1.3.0`.

### Fixed

- **Engine B now materializes against the element's own root.** Before 1.4.0 the single constructed `@container` sheet was adopted only into `document.adoptedStyleSheets`. A sentinel inside a **shadow root** (shadow encapsulation) or a **cross-realm iframe document** therefore never saw `--lm-v` flip, and its signal sat silently stuck at `false`. The engine now resolves `el.getRootNode()` and keeps **one constructed sheet per root**, adopted into *that* root and built in *that* root's own realm (`root.defaultView.CSSStyleSheet`), so adoption never throws across realms. This is the headline iframe / Twitch panel-mode case.

### Changed / internal

- **Per-root sheet state** lives in a `WeakMap<root, { doc, view, sheet, ids }>` — a WeakMap, not a Map, so a detached shadow root or a dead iframe document is never pinned for the page lifetime (the leak law forbids that retention class). A live root keeps its sheet (don't-rebuild); a dropped root is collected with it.
- **The single-property invariant holds across roots.** `--lm-v` is still registered exactly once per engine (`CSS.registerProperty`), and the query→id map stays global so the `data-q` selector is identical in every root. Only *which* ids' rules are already inserted is tracked per root.
- **Fail-closed per root.** A root with no realm, no constructable sheet, no `adoptedStyleSheets` support, or a throwing construct/adopt degrades to a stuck-`false` signal — memoized, never retried, never thrown. Never adopts a wrong-realm sheet (the global `CSSStyleSheet` fallback is allowed only for the main document's own realm).
- **Roots-bounds invariant.** A root's sheet and its inserted rules are **retained** on last dispose (bounded by concurrent root count, not watcher count) — mirroring the `media()` registry-bounds decision. Dispose still removes every sentinel and detaches every listener.

### Tests + torture

- New `test/16-browser-engine.test.mjs` and `test/17-multiroot-dispose.test.mjs` drive the real engine against a realm/DOM mock: document-root regression floor, shadow-root adoption (control: the document is *not* touched), cross-realm construction into a hostile realm (control: a wrong-realm sheet is rejected), one `--lm-v` across N roots, one sheet per root, and interleaved multi-root create/dispose (retained per-root rules, no cross-root bleed, every sentinel + listener cleaned).
- New torture tiers, committed: multi-root interleaved dispose retention (lite-leak owner attribution, with a forget-untrack control), exactly-one `--lm-v` across N roots (control: N engines register N times), **0 B/flip preserved inside a shadow root** via the `_flip` seam (with a retaining control that trips it), and cold per-root setup is one-time (1000 known re-watches build no sheet and insert no rule). Every gate ships a control that fails it.

### Notes

- Bundle size is now **~3.2 KB min+gz** (3,265 B, esbuild + gzip -9, lite-signal external) — up from ~2.9 KB at 1.3.0, the cost of the per-root resolution.
- **Non-goal:** the root is resolved once, at an element's first `watch()`, and memoized per element. Relocating an element to a different root (document or shadow root) after its signal exists is not re-resolved — dispose and re-create the signal if an element moves roots.

## 1.3.0 — container style() queries

New runtime API, all additive. Peer dependency stays `@zakkster/lite-signal ^1.3.0`.

### Added

- **`containerStyle(el, prop, value)`** — a `Signal<boolean>` for a container *style* query: is `prop` computed to `value` on the element's nearest ancestor container? This completes Engine B, extending it from *size* conditions to *style* conditions. Design consequences:
  - **No new evaluator, no parser.** `containerStyle` constructs the canonical condition `style(<prop>: <value>)` and routes it through the exact same sentinel + `transitionrun` path as `containerMedia()`. The browser evaluates the condition; lite-media only observes. A style verdict flip is the same zero-allocation `sig.set` as a size flip — committed as **0 B/flip**.
  - **Shares the container cache.** A raw `containerMedia(el, 'style(--theme: dark)')` with identical spacing returns the *same* memoized signal.
  - **No namespace pollution.** lite-media still registers exactly one CSS custom property (`--lm-v`). The queried property is the caller's — we never register it.
  - **Fails closed:** a non-Element, non-string/empty property, or non-string value throws `TypeError`. Off-DOM it returns a stable `false` signal and never throws, exactly like `containerMedia()`.
- **LM-04 — the container-type footgun warning now skips `style()` queries.** A `style()` container query resolves against any ancestor element and needs **no** `container-type: size | inline-size`, so the missing-container warning would be a false positive. It is now suppressed for any condition beginning with `style(` — covering both `containerStyle()` and a raw `style()` string passed to `containerMedia()`. A size query on the same element still warns (asserted, with a control).
- **Torture tiers for the style path** — committed numbers: **0 B per verdict flip**, duplicate-flip dedup (exactly one effect run), and dispose-during-transition safety (no throw, no stale run), each with a load-bearing control.

### Notes

- Bundle size is now **~2.9 KB min+gz** (was ~2.8 KB at 1.2.0), the cost of `containerStyle()` + LM-04. The dev-only container-type warning is still dead-code-eliminated from a production build (`NODE_ENV=production`).

## 1.2.0 — breakpoints() + the last two preference signals

New runtime API, all additive. Peer dependency stays `@zakkster/lite-signal ^1.3.0` (uses only the long-standing `signal` + `computed` core).

### Added

- **`breakpoints({ name: minWidthPx })`** — compile a named responsive-band map into a single `computed<string>` whose value is the active band: the name of the highest-threshold entry whose `(min-width: Npx)` matches, with the smallest entry acting as the mobile-first floor whenever nothing larger matches. Design consequences:
  - **The map's own keys are the tokens.** The active band is returned by reference, so an unchanged band is `===`-stable and the computed notifies downstream **exactly once per real band change** — a resize that stays within a band costs nothing.
  - **No width comparison in JS.** Each boundary is a constructed `(min-width: Npx)` query observed through `media()`, so a band flip inherits the media path's proven **0 B/flip** profile and the sentinel thesis ("JS never evaluates a query") holds. Boundary signals are shared with `media()` through the same cache.
  - **Memoized** per canonical map key (any key order → one computed). Counted in `stats().bands`.
  - **Fails loud** at compile time: a non-object, empty, or non-finite/negative-valued map throws `TypeError`; no matchMedia + no `ssrDefault` throws, and a throwing compile caches nothing. SSR collapses every boundary to `ssrDefault` — `false` yields the floor band, `true` the top band.
  - With a literal map the returned signal's value type narrows to the union of the keys.
- **`standaloneDisplay()`** → `(display-mode: standalone)` and **`highDynamicRange()`** → `(dynamic-range: high)` — the final two of the ten curated preference signals from the v1.0 design, matching the lazy-memoized shape of the other eight. Ten preference shortcuts now ship.
- **Torture tiers for `breakpoints()`** — committed numbers: **0 B retained per band change**, **0 B per read of a stable band** (cache hit), and an 8001-run integrity sweep (1 creation + 8000 real band changes over 2000 cycles, one downstream run each). Wired into the existing gate; every gate still ships a control that fails it.

### Notes

- Bundle size is now **~2.8 KB min+gz** (was ~2.3 KB at 1.1.2), the cost of `breakpoints()`. The dev-only container-type warning is still dead-code-eliminated from a production build (`NODE_ENV=production`).
- `stats()` gains a `bands` field (count of memoized band computeds); the registry-bounds invariant covers the breakpoints cache under the same contract as the `media()` cache.

## 1.1.2 — the footgun warning + the torture gate

No new runtime API; no consumer-facing behavior change. Peer dependency stays `@zakkster/lite-signal ^1.3.0`.

### Added

- **Dev-only `container-type: normal` warning.** On first `containerMedia(el, query)` materialization, if neither the element nor any ancestor establishes a query container (`container-type: size | inline-size`), a one-time `console.warn` names the element and the fix. This is the classic silent-mismatch footgun: without a query container the `@container` query can never match and the signal stays `false` forever. **Warn, never mutate** — setting `container-type` changes sizing semantics and that is the caller's call. Gated on `process.env.NODE_ENV`; a production build drops it, and the production path is asserted to emit nothing.
- **`test/torture.mjs`** — the mandated proof gate (`npm run test:torture`, run under `node --expose-gc`). Commits the package's central allocation claims as numbers via `@zakkster/lite-gc-profiler` and proves the teardown/ownership contract via `@zakkster/lite-leak`. Committed numbers: **0 B retained per media flip, 0 B per container verdict flip, 0 B per non-flip frame, 0 ArrayBuffer growth and 0 major GCs across a 100-signal × 2000-toggle storm.** Every gate ships a control that fails it. Wired into `npm run verify`.
- **`__flipForTests(sig, matches)` / `instance._flip(sig, matches)`** — test-only seam (not part of the semver contract) that simulates a container verdict flip on the default instance by routing through the exact engine `onChange`, so container behavior is testable without a browser.

### Pinned (previously undecided)

- **SSR container contract.** `containerMedia()` off-DOM returns a stable `false` signal and never throws — the conservative, fail-closed verdict (a container's size cannot be known server-side; `false` renders the not-yet-sized layout). This deliberately differs from `media()`, which throws without `ssrDefault`; `ssrDefault` does not apply to the container path.
- **Registry-bounds invariant.** The per-instance `media()` cache grows one signal per distinct query string, never per call. It is not silently unbounded: each entry is a lite-signal node, and the fixed live-node budget is the ceiling — past it, `signal()` throws a fail-closed `CapacityError` rather than corrupting. The contract (small, static query vocabulary) is now documented and tested.

### Notes

- The two remaining preference signals from the v1.0 design (`standaloneDisplay`, `highDynamicRange`) stay deferred to v1.2.0 per the shipped docs — eight preference shortcuts ship, unchanged.

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
