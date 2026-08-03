# @zakkster/lite-media

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-media.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-media)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Hot%20path-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-media?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-media)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-media?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-media)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-media?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-media)
![Tree-Shakeable](https://img.shields.io/badge/tree--shakeable-yes-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational?style=flat-square)
[![lite-signal peer](https://img.shields.io/npm/dependency-version/@zakkster/lite-media/peer/@zakkster/lite-signal?style=for-the-badge&color=blue)](https://github.com/PeshoVurtoleta/lite-signal)
![Dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen?style=flat-square)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE.txt)


> Reactive media & preference signals for `@zakkster/lite-signal`. Wraps `window.matchMedia` in a `Signal<boolean>` with page-lifetime memoization. Zero-GC steady state.

```
npm install @zakkster/lite-media @zakkster/lite-signal
```

## Numbers

Measured on **Apple M4 Pro (12 cores) · Node 26.3.1 · darwin/arm64**. Run `npm run bench` on your box for local figures — the harness prints a machine stamp so you can reproduce them.

| Scenario                                          | Throughput        | Per-op        |
| ------------------------------------------------- | ----------------- | ------------- |
| `media(q)` cache hit                              | **213 M ops/s**   | **4.7 ns**    |
| Signal read (call-style, `s()`)                   | **1.44 B ops/s**  | **0.7 ns**    |
| Preference shortcut (`reducedMotion()`)           | 187 M ops/s       | 5.4 ns        |
| `change` event → `sig.set` → effect (1 sub)       | **46 M ops/s**    | **21.8 ns**   |
| Fanout to 100 subscribers                         | 849 K ops/s       | 1.18 μs total, **~12 ns/sub** |
| `createMedia()` instance creation                 | 21 M ops/s        | 47.8 ns       |
| Cold materialize (mock MQL, cache miss)           | 1.6 M ops/s       | 624 ns        |
| `createMedia()` + 5 signals fully wired           | 674 K ops/s       | 1.48 μs       |

**~3.5 KB min+gz** (3,529 B, esbuild + `gzip -9`, lite-signal external) for the full module — Engine A, Engine B (`containerMedia` + `containerStyle`, multi-root as of v1.4.0, bfcache-aware as of v1.4.1), `breakpoints`, `createMedia`, 10 preferences, `configure`, `stats`. The dev-only `container-type` warning is behind a `process.env.NODE_ENV !== "production"` guard, so a production build drops it.

## Hello

```js
import { effect } from "@zakkster/lite-signal";
import { media, reducedMotion, hoverCapable } from "@zakkster/lite-media";

const small = media("(max-width: 37.5rem)");
const rm    = reducedMotion();
const hover = hoverCapable();

effect(() => {
    layout.compact = small();
    if (!rm())    animate();
    if (hover())  enableHoverPreviews();
});
```

Every call returns a lite-signal `Signal<boolean>` that reflects `matchMedia(query).matches` and updates on `change`. The same query string always returns the same signal — memoized for the page lifetime, so N components asking for `(max-width: 37.5rem)` share exactly one browser subscription.

---

## The one-line design

**JS never evaluates a query. The browser evaluates; lite-media only observes the verdict and pushes a boolean into the graph.**

Two consequences that fall out of that:

1. **Correctness is free, forever.** Range syntax, `em` resolved against font-size, `dvh`, container queries, media features that haven't shipped yet — the browser handles them. lite-media doesn't parse queries, doesn't compare pixels, doesn't own an evaluator.
2. **Zero-GC steady state.** A `change` event runs one hoisted handler that does one `sig.set(e.matches)`. lite-signal's default `Object.is` equality drops redundant events. No timers, no debounce, no allocations after the signal is created.

Engine B (`containerMedia`, v1.1) follows the same rule via CSS custom-property transitions on a zero-size sentinel — the browser fires `transitionrun` when a container's verdict flips, and lite-media pushes the new boolean into the signal graph. `containerStyle` (v1.3) is the same engine pointed at a `style()` condition instead of a size one: still no parser, still one observed verdict.

**bfcache is the one case the browser doesn't tell you about (v1.4.1).** A page restored from the back/forward cache does *not* re-fire `change` or `transitionrun`, so a signal could hold an answer that went stale while the page was frozen (the user flipped dark mode, rotated the device, resized the window). Each instance lazily attaches **one** `pageshow` listener; on a *persisted* restore (`event.persisted === true`) — and only then — it re-reads every watched `mql.matches` and every live sentinel's verdict and re-pushes each through the same `sig.set`. `Object.is` drops the ones that didn't move, so an unchanged restore retains **0 B** and runs no effects, while a verdict that changed while frozen propagates exactly once. Every read is fail-closed; in Node / SSR (no `globalThis.addEventListener`) nothing is attached. No application code to call — it just stops being stale.

---

## API

### `media(query: string): MediaSignal`

Return the memoized reactive boolean signal for a CSS media query. Same query string => same signal instance. Reads (`s()`, `s.peek()`, `s.subscribe()`) behave as lite-signal defines. The `.d.ts` narrows the return type to hide `.set` / `.update`.

```js
const wide = media("(min-width: 60rem)");
effect(() => document.body.classList.toggle("wide", wide()));
```

Throws `Error` if no `matchMedia` is available and no `ssrDefault` was configured. Throws `TypeError` if a configured factory returns a non-MQL-shaped object.

### `containerMedia(el: Element, query: string): MediaSignal` — new in v1.1

Return the memoized reactive boolean signal for a container query, scoped to an element. The element must have `container-type` set (`inline-size`, `size`, or `normal`). Cached per (element, query) pair via a `WeakMap` keyed on the element — detached elements become GC-eligible along with their signals.

```js
const card = document.querySelector(".card");
card.style.containerType = "inline-size";

const wide = containerMedia(card, "(min-width: 30rem)");
effect(() => card.classList.toggle("card-wide", wide()));
```

Under the hood: lite-media injects one `@container ${query} { .__lm-s[data-q="N"] { --lm-v: on; transition: --lm-v 0.001ms allow-discrete; } }` rule per unique query, appends a zero-size sentinel `<div>` to the container, and listens for `transitionrun` on the registered `<custom-ident>` custom property. When the container matches, `--lm-v` flips `off → on` (or reverse), the browser fires `transitionrun`, and the handler reads the new value and calls `sig.set(...)`.

**Preconditions:**
- Query strings, like `media()`, must come from a bounded static set — they're inserted into a live stylesheet (see "Memoization contract").
- The container must have `container-type` set. lite-media cannot set it for you (it would over-specify layout; users need control here). **In development builds** (`process.env.NODE_ENV !== "production"`), if neither the element nor any ancestor is a query container, lite-media logs a one-time `console.warn` naming the element and the fix. It **warns, never mutates**, and the warning is dropped from production builds.

Off-DOM (SSR / Node without a container engine), `containerMedia()` returns a stable `false` signal and never throws — the conservative, fail-closed verdict. Unlike `media()`, `ssrDefault` does not apply to this path.

**Multi-root (v1.4.0).** The engine resolves `el.getRootNode()` and keeps one constructed `@container` sheet **per root** — the main document, a **shadow root**, or a **cross-realm iframe document** — adopted into that root and built in that root's own realm. An element inside a shadow root or an embedded iframe (e.g. a Twitch panel) now materializes against its own root's sheet instead of sitting silently stuck at `false`. `--lm-v` is still registered exactly once, the per-root sheet map is a `WeakMap` (detached roots are never pinned), and a root that can't be styled fails closed to a stuck-`false` signal — never throws, never adopts a wrong-realm sheet. The root is resolved once, at the element's first `watch()`, and memoized per element; relocating an element to a different root after its signal exists is a non-goal — dispose and re-create the signal if an element moves roots.

Throws `TypeError` if `el` is null / primitive or `query` is not a string.

### `containerStyle(el: Element, prop: string, value: string): MediaSignal` — new in v1.3

Return the memoized reactive boolean signal for a container **style** query: is `prop` computed to `value` on the element's nearest ancestor container? This is Engine B's `style()` class — the same sentinel + `transitionrun` machinery as `containerMedia`, pointed at a style condition.

```js
const card = document.querySelector(".card");
// A parent sets --theme somewhere up the tree; no container-type needed.
const dark = containerStyle(card, "--theme", "dark");
effect(() => card.classList.toggle("card-dark", dark()));
```

`containerStyle(el, prop, value)` constructs the canonical condition `style(<prop>: <value>)` and delegates to `containerMedia`, so it shares that path's engine, memoization and disposer. A raw `containerMedia(el, "style(--theme: dark)")` with identical spacing returns the **same** cached signal.

- **No `container-type` required.** Unlike a *size* query, a `style()` query resolves against any ancestor element regardless of its `container-type`, so the missing-container footgun does not apply — the dev-only warning is suppressed for it (LM-04).
- **No namespace pollution.** lite-media registers exactly one CSS custom property (`--lm-v`). The queried property is yours; lite-media never registers it. If you want guaranteed inheritance or typing on it, register it with `CSS.registerProperty` yourself.
- **Same SSR contract as `containerMedia`:** off-DOM it returns a stable `false` signal and never throws.

Throws `TypeError` if `el` is null / primitive, `prop` is not a non-empty string, or `value` is not a string.

### `createMedia(options?): ScopedMedia` — new in v1.1

Create a scoped instance with its own memoization cache. This is the fundamental factory; the module-level `media`, `configure`, etc. delegate to a lazily-created default instance backed by this same factory.

```js
import { createMedia } from "@zakkster/lite-media";

// Per-request SSR: fresh instance per request.
export function handleRequest(req) {
    const m = createMedia({
        ssrDefault: isMobileUA(req.headers["user-agent"]),
    });
    const compact = m.media("(max-width: 37.5rem)");
    return renderPage({ compact: compact() });
}
```

Options are creation-only. Scoped instances never lock — there's no `configure()` step, no lock error to worry about.

```ts
interface CreateMediaOptions {
    matchMedia?: (q: string) => MockMediaQueryList;
    ssrDefault?: boolean;
    containerEngine?: ContainerEngine | null;
}
```

**Use `createMedia()` for:**
- Per-request SSR (each request creates a fresh instance with a request-specific default).
- Tests that need isolation without touching module state.
- Multiple embed points on one page with different mocks / defaults / engines.

### `configure(options): void`

Configures the **default** instance. Must be called before the first successful `media()` / `containerMedia()` / preference call. Same lock semantics as v1.0. Scoped `createMedia()` instances take options at creation and have no `configure()` method.

```js
configure({
    matchMedia: (q) => mockMediaQueryList(q),
    ssrDefault: false,
    containerEngine: myMockEngine,   // v1.1
});
```

- Non-function `matchMedia` throws `TypeError` at the call site.
- Non-boolean `ssrDefault` (including `undefined`) is a no-op.
- Malformed `containerEngine` (missing `.watch(el, query, onChange)`) throws `TypeError`.
- `null` / `undefined` / non-object input are all safe no-ops.
- Multiple pre-lock calls compose (later values override earlier).
- Reconfiguration after **successful** materialization throws.
- Failed materialization does **not** engage the lock.

### Preference shortcuts

Each is `() => MediaSignal` — hoist once per component, then read call-style. All 10 available as methods on scoped `createMedia()` instances too. `standaloneDisplay()` and `highDynamicRange()` are new in v1.2.

| Shortcut                      | Query                                     |
| ----------------------------- | ----------------------------------------- |
| `reducedMotion()`             | `(prefers-reduced-motion: reduce)`        |
| `darkScheme()`                | `(prefers-color-scheme: dark)`            |
| `hoverCapable()`              | `(hover: hover)`                          |
| `coarsePointer()`             | `(pointer: coarse)`                       |
| `forcedColors()`              | `(forced-colors: active)`                 |
| `moreContrast()`              | `(prefers-contrast: more)`                |
| `reducedData()`               | `(prefers-reduced-data: reduce)`          |
| `reducedTransparency()`       | `(prefers-reduced-transparency: reduce)`  |
| `standaloneDisplay()`         | `(display-mode: standalone)`              |
| `highDynamicRange()`          | `(dynamic-range: high)`                   |

### `breakpoints(map): BandSignal` — new in v1.2

Compile a named breakpoint map into a **single** reactive string signal — the name of the active band:

```js
import { breakpoints } from "@zakkster/lite-media";

const band = breakpoints({ sm: 0, md: 768, lg: 1024 }); // min-width in px
effect(() => {
    document.body.dataset.bp = band(); // "sm" | "md" | "lg"
});
```

The active band is the name of the **highest threshold** whose `(min-width: Npx)` currently matches; the smallest entry is the **mobile-first floor**, returned whenever nothing larger matches. Key order does not matter — the map is sorted by threshold.

- **One signal, not N.** The map compiles to one `computed<string>`. The band names are the map's own keys, returned by reference, so an unchanged band is `===`-stable — downstream effects run **exactly once per real band change**, never per resize frame.
- **No width math in JS.** Each boundary is a constructed `(min-width: Npx)` query observed through `media()` (boundary signals are shared with `media()`), so the sentinel thesis holds and a band flip is a zero-allocation token swap.
- **Memoized** per map (any key order → the same signal), and counted in `stats().bands`.
- **Fails loud:** a non-object, empty, or non-finite/negative-valued map throws `TypeError`. Off-DOM it follows `ssrDefault` — `false` yields the floor band, `true` the top band; with neither `matchMedia` nor `ssrDefault` it throws like `media()`.

With a literal map, TypeScript narrows the value to the union of the keys (`BandSignal<"sm" | "md" | "lg">`).

### `stats(): { watched, bands, configured, locked }`

Cheap live snapshot for demos, perf overlays, and test assertions.

---

## Read-only by convention

`MediaSignal` in the `.d.ts` is a structural narrowing of lite-signal's `Signal<boolean>` — it hides `.set` and `.update` from TypeScript. **At runtime, the returned object still has those methods.** A JS consumer or a TS `as` cast can call `.set()`, and doing so will permanently desync the shared signal from the browser until the next real `change` event lands.

If you find yourself wanting to write to a media signal, wrap it in a `computed()` you own.

---

## Memoization contract

Both `media()` and `containerMedia()` memoize by exact string match, for the lifetime of the instance (no eviction). The design assumes query strings come from a **bounded static set** — interned literals, module-level constants, or a finite table of known breakpoints.

Additionally for `containerMedia`: query strings are inserted into a live `<style>` sheet. **Never** pass untrusted input — treat container queries like CSS you're authoring, not like user data. If you need bounded runtime dispatch, bucket to a fixed table of well-known breakpoints first.

```js
// WRONG — leaks a signal + a listener per unique width, plus a live CSS rule.
for (let w = 300; w < 1300; w++) media(`(max-width: ${w}px)`);
```

---

## SSR & per-request state

In v1.1, per-request SSR is a first-class pattern via `createMedia()`:

```js
// per-request handler
export function handle(req) {
    const m = createMedia({
        ssrDefault: guessMobile(req.headers["user-agent"]),
    });
    // ...use m.media(), m.reducedMotion(), etc.
    // Instance goes out of scope after the response; GC handles cleanup.
}
```

The **default instance** (module-level `media`, `configure`, `reducedMotion`, ...) still uses a process-global cache with process-wide `ssrDefault` — that's the right shape for browser pages and the wrong shape for request-scoped state. Use `createMedia()` when you need isolation.

---

## Testing

`__resetForTests()` clears the default instance's cache, config, and lock in one call. Node's `--test` runs each test file in its own subprocess by default, so cross-file isolation is free.

```js
import { test, beforeEach } from "node:test";
import { configure, media, __resetForTests } from "@zakkster/lite-media";

beforeEach(() => __resetForTests());

test("your test", () => {
    configure({
        matchMedia: (q) => ({ matches: false, addEventListener() {} }),
    });
    // ...
});
```

For container-query tests, pass a mock engine:

```js
const mockEngine = {
    watch(el, query, onChange) {
        // Record for later flip() calls
        registry.set(el, { query, onChange });
        return { initial: false, dispose: () => registry.delete(el) };
    },
};
configure({ containerEngine: mockEngine });
```

Or use `createMedia({ containerEngine: mockEngine })` for tests that shouldn't touch module state.

---

## Zero-GC accounting

| Op                                       | Allocations                                       |
| ---------------------------------------- | ------------------------------------------------- |
| `media(query)` — cache hit               | 0 hot-path (Map lookup only)                      |
| `media(query)` — cache miss, mock        | 1 signal + 1 handler closure + 1 MQL (from mock)  |
| `media(query)` — cache miss, native, 1st | 1 signal + 1 handler + 1 MQL + 1 bound-native fn  |
| `media(query)` — cache miss, native, ≥2  | 1 signal + 1 handler + 1 MQL                      |
| `containerMedia(el, q)` — cache hit      | 0 hot-path (WeakMap + Map lookup)                 |
| `containerMedia(el, q)` — cache miss, 1st per query | 1 sentinel `<div>` + 1 handler + 1 signal + 1 CSS rule + 1 registered property (first time only) |
| `containerMedia(el, q)` — cache miss, ≥2 per query  | 1 sentinel + 1 handler + 1 signal            |
| `containerStyle(el, p, v)` — cache hit   | 0 hot-path (delegates to `containerMedia`)        |
| `containerStyle(el, p, v)` — cache miss  | same as `containerMedia` + 1 constructed condition string |
| Style verdict flip (`transitionrun`)     | 0 (identical to `containerMedia`; committed 0 B/flip) |
| `breakpoints(map)` — cache hit           | 0 hot-path (Map lookup)                           |
| `breakpoints(map)` — cache miss          | 1 computed + N boundary signals (via `media()`, once per threshold) |
| Band read (`band()`) / band change       | 0 (cache hit; a change is a `===`-stable token swap) |
| Signal read (`s()`)                      | 0                                                 |
| `change` event → sig.set                 | 0                                                 |
| `transitionrun` event → sig.set          | 0 hot-path (getComputedStyle read is cached)      |
| Redundant event (same value)             | 0 (Object.is dedup in lite-signal)                |
| Preference shortcut call                 | 0 additional (delegates to `media()`)             |
| bfcache restore — unchanged verdict      | 0 retained (each `sig.set` dedups via `Object.is`)|
| bfcache restore — changed verdict        | 0 additional (one `sig.set` per moved verdict)    |
| `createMedia(opts)` call                 | 1 instance object + 2 Maps + 1 WeakMap            |

Cost scales with **verdict flips**, not with browser events: an event that doesn't move the answer costs one `Object.is` comparison and stops. A bfcache restore (a persisted `pageshow`) re-reads every watched verdict once and pushes only the ones that actually moved while the page was frozen — an unchanged restore retains 0 B.

---

## Reduced-motion rAF gate — new in v1.5.0

If you are **already in the lite-signal graph** (already depending on `@zakkster/lite-signal`), gate an animation loop on `reducedMotion()` with a single `effect`. When the user prefers reduced motion the loop **parks** (the in-flight frame is cancelled, no new frame is scheduled); when they flip it back off the loop **resumes**; on dispose the effect's `onCleanup` cancels the last frame. No per-frame preference check, no ad-hoc `matchMedia(...).addEventListener` bookkeeping.

```js
import { effect, onCleanup } from "@zakkster/lite-signal";
import { reducedMotion } from "@zakkster/lite-media";

const raf = requestAnimationFrame;
const cancel = cancelAnimationFrame;

function startAnimation(draw) {
    const prefersReduced = reducedMotion(); // memoized MediaSignal; read () inside the effect
    let id = 0;
    function loop(t) { draw(t); id = raf(loop); }

    // One effect. reducedMotion() is READ inside so the dependency is tracked.
    return effect(() => {
        if (prefersReduced()) { cancel(id); return; } // park: cancel, schedule nothing
        id = raf(loop);
        onCleanup(() => cancel(id));                   // fires on re-run AND on dispose
    });
}

const stop = startAnimation(drawFrame);
// ...later: stop();  // tears the loop down, no orphaned frame callback
```

Why an `effect` and not a per-frame `if (reducedMotion())`:

- **Fail-closed for free.** Off-DOM / SSR / any environment without `matchMedia`, `reducedMotion()` fails closed (see `media()`); the loop never starts. Do **not** monkeypatch `globalThis.requestAnimationFrame` to test this — inject `raf`/`cancel` so the no-rAF path stays visible.
- **Zero allocation per flip.** Toggling the preference re-runs the effect (one `cancel`/`raf` + one transient `onCleanup` closure) and retains **0 B** — committed by `test/torture.mjs` (`rafGate.bytesPerFlip = 0`, `rafGate.majors = 0` over a 20 000-flip storm).
- **Zero frames while parked.** Once parked, no scheduler ticks run the loop (`rafGate.framesWhileParked = 0`); a control that omits the `cancel` runs ≥ 1000 frames, proving the cancel is load-bearing.
- **No leak on dispose.** 4096 attach/park/dispose cycles return the live-set to 0 (`rafGate.liveSetAfter = 0`).

The recipe is proven in `test/20-raf-gate.test.mjs` (conformance) and the rAF-gate torture tiers.

---

## Ecosystem — vendor vs depend

lite-media does **not** become a runtime dependency of packages whose identity is *zero dependencies*.

- **`lite-ambient-fx` and `lite-scratch-fx` keep vendoring their own `prefers-reduced-motion` check.** Each already reads `matchMedia("(prefers-reduced-motion: reduce)")` behind its own guard; the core stays zero-dependency, and any heavier capability lives behind an optional peer / separate export path rather than a hard dependency on lite-media. Turning lite-media into their runtime dep would trade their zero-dep guarantee for a convenience they do not need.
- **The rAF-gate recipe above is for consumers already in the signal graph.** If a package already depends on `@zakkster/lite-signal`, `reducedMotion()` + `effect({ scheduler })` replaces its ad-hoc preference bookkeeping with a tracked, zero-GC, fail-closed gate — at no new dependency cost, because lite-signal is already present.

In short: depend on lite-media when you are already reactive; vendor a one-line `matchMedia` check when your identity is zero-dep.

---

## Roadmap

- **v1.0.0** — Engine A: `media()`, 8 preferences, `configure()`, `stats()`.
- **v1.1.0** — Engine B (`containerMedia`), `createMedia()` factory.
- **v1.1.2** — Dev-only `container-type: normal` warning; SSR container contract + registry-bounds invariant pinned; `test/torture.mjs` proof gate (0 B/flip, 0 ArrayBuffer growth committed as numbers).
- **v1.2.0** — `breakpoints({ sm, md, lg })` interned-token band computed (0 B/band-change committed); `standaloneDisplay()` + `highDynamicRange()` complete the ten preference signals.
- **v1.3.0** — `containerStyle(el, prop, value)` — Engine B's `@container style()` class through the same sentinel primitive (0 B/flip committed); the `container-type` footgun warning now skips `style()` queries (LM-04).
- **v1.4.0** — Multi-root Engine B: shadow DOM + cross-realm iframe (one constructed sheet per root, adopted into that root, built in that root's realm); one `--lm-v` across roots, fail-closed per root, interleaved-dispose torture committed.
- **v1.4.1** — bfcache / `pageshow` lifecycle audit: a persisted `pageshow` re-pins every Engine A `mql` verdict and every Engine B sentinel verdict through the same `sig.set` a real event uses. 0 B on an unchanged restore, fail-closed per entry; bfcache resync + live-set retention torture committed.
- **v1.5.0** — Ecosystem wiring (Option A): a tested, copy-pasteable **reduced-motion rAF-gate** recipe for consumers already in the signal graph (`reducedMotion()` + `effect({ scheduler })`), its conformance + torture gates (0 B/flip, 0 major GC, 0 frames while parked, live-set 0), and the vendor-vs-depend decision record. **Media.js runtime is unchanged from 1.4.1** (only the version-header comment changed; min+gz bundle byte-identical). *This release.*

Watchlist: [CSSWG #6205](https://github.com/w3c/csswg-drafts/issues/6205) — a native `Element.matchContainer()` would collapse Engine B to a feature-detected bridge without changing the signal-graph surface.

---

## Browser & runtime support

Pure ES2020. Any environment that runs `@zakkster/lite-signal` and can either provide `globalThis.matchMedia` or accept a mock through `configure()`.

**`containerMedia` additionally requires:**
- Container queries (`@container` rules) — Chrome 105+, Firefox 110+, Safari 16+.
- `CSSStyleSheet.adoptedStyleSheets` — Chrome 96+, Firefox 101+, Safari 16.4+.
- `transition-behavior: allow-discrete` — Chrome 117+, Firefox 129+, Safari 17.4+.

All of the above are in [Baseline 2024](https://web.dev/baseline). On older browsers, `containerMedia` still returns a signal — it just stays at its initial value. Graceful degradation, not runtime error.

| Target                                 | Supported                                    |
| -------------------------------------- | -------------------------------------------- |
| Chrome / Edge 117+                     | full (media + container)                     |
| Firefox 129+                           | full (media + container)                     |
| Safari 17.4+                           | full (media + container)                     |
| Older evergreen (Chrome 105–116, etc.) | `media()` full; `containerMedia()` inert     |
| Node.js 18+                            | `media()` via SSR default or mock; `containerMedia()` inert |
| Bun                                    | same as Node                                 |
| Deno                                   | `media()` via SSR default or mock; `containerMedia()` inert (no `matchMedia`) |
| Twitch Extensions                      | full                                         |

ESM only. `sideEffects: false` — tree-shakes cleanly.

---

## License

MIT © Zahary Shinikchiev

---

> Part of the **@zakkster** zero-GC stack: [`lite-signal`](https://www.npmjs.com/package/@zakkster/lite-signal) · [`lite-watch-ex`](https://www.npmjs.com/package/@zakkster/lite-watch-ex) · [`lite-store`](https://www.npmjs.com/package/@zakkster/lite-store) · [`lite-throttle`](https://www.npmjs.com/package/@zakkster/lite-throttle) · [`lite-debounce`](https://www.npmjs.com/package/@zakkster/lite-debounce) · [`lite-raf`](https://www.npmjs.com/package/@zakkster/lite-raf) · [`lite-color-engine`](https://www.npmjs.com/package/@zakkster/lite-color-engine)
