# @zakkster/lite-media

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-media.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-media)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Hot%20path-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-media?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-media)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-media?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-media)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-media?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-media)
![Tree-Shakeable](https://img.shields.io/badge/tree--shakeable-yes-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational?style=flat-square)
[![lite-signal peer](https://img.shields.io/npm/dependency-version/@zakkster/lite-/peer/@zakkster/lite-signal?style=for-the-badge&color=blue)](https://github.com/PeshoVurtoleta/lite-signal)
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

**2.2 KB min+gz** for the full v1.1 module — Engine A, Engine B, `createMedia`, 8 preferences, `configure`, `stats`.

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

Engine B (`containerMedia`, v1.1) follows the same rule via CSS custom-property transitions on a zero-size sentinel — the browser fires `transitionrun` when a container's verdict flips, and lite-media pushes the new boolean into the signal graph.

---

## API

### `media(query: string): MediaSignal`

Return the memoized reactive boolean signal for a CSS media query. Same query string ⇒ same signal instance. Reads (`s()`, `s.peek()`, `s.subscribe()`) behave as lite-signal defines. The `.d.ts` narrows the return type to hide `.set` / `.update`.

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
- The container must have `container-type` set. lite-media cannot set it for you (it would over-specify layout; users need control here).

Throws `TypeError` if `el` is null / primitive or `query` is not a string.

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

Each is `() => MediaSignal` — hoist once per component, then read call-style. All 8 unchanged from v1.0. Also available as methods on scoped `createMedia()` instances.

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

### `stats(): { watched, configured, locked }`

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
| Signal read (`s()`)                      | 0                                                 |
| `change` event → sig.set                 | 0                                                 |
| `transitionrun` event → sig.set          | 0 hot-path (getComputedStyle read is cached)      |
| Redundant event (same value)             | 0 (Object.is dedup in lite-signal)                |
| Preference shortcut call                 | 0 additional (delegates to `media()`)             |
| `createMedia(opts)` call                 | 1 instance object + 1 Map + 1 WeakMap             |

Cost scales with **verdict flips**, not with browser events: an event that doesn't move the answer costs one `Object.is` comparison and stops.

---

## Roadmap

- **v1.0.0** — Engine A: `media()`, 8 preferences, `configure()`, `stats()`.
- **v1.1.0** — Engine B (`containerMedia`), `createMedia()` factory. *This release.*
- **v1.2.0** — `breakpoints({ sm, md, lg })` interned-token computed; reconsider `standaloneDisplay` / `highDynamicRange` based on consumer demand.
- **v1.3.0** — Shadow DOM multi-root support for engine B; iframe / Twitch panel-mode verification.
- **v1.4.0** — Ecosystem wiring: `lite-ambient-fx` & `lite-scratch-fx` consume `reducedMotion` via `watchEffect` rAF gate; `lite-hueforge` pairs `moreContrast` / `forcedColors` with APCA role-floor selection.

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
