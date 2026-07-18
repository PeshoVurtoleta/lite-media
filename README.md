# @zakkster/lite-media

![npm version](https://img.shields.io/npm/v/@zakkster/lite-.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Hot%20path-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-)
![Tree-Shakeable](https://img.shields.io/badge/tree--shakeable-yes-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational?style=flat-square)
[![lite-signal peer](https://img.shields.io/npm/dependency-version/@zakkster/lite-/peer/@zakkster/lite-signal?style=for-the-badge&color=blue)](https://github.com/PeshoVurtoleta/lite-signal)
![Dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen?style=flat-square)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE.txt)


> Reactive media & preference signals for `@zakkster/lite-signal`. Wraps `window.matchMedia` in a `Signal<boolean>` with page-lifetime memoization. Zero-GC steady state.

```
npm install @zakkster/lite-media @zakkster/lite-signal
```

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

1. **Correctness is free, forever.** Range syntax, `em` resolved against font-size, `dvh`, media features that haven't shipped yet — the browser handles them. lite-media doesn't parse queries, doesn't compare pixels, doesn't own an evaluator.
2. **Zero-GC steady state.** A `change` event runs one hoisted handler that does one `sig.set(e.matches)`. lite-signal's default `Object.is` equality drops redundant events. No timers, no debounce, no allocations after the signal is created.

---

## API

### `media(query: string): MediaSignal`

Return the memoized reactive boolean signal for a CSS media query. Same query string ⇒ same signal instance. Reads (`s()`, `s.peek()`, `s.subscribe()`) behave as lite-signal defines. The `.d.ts` narrows the return type to hide `.set` / `.update`.

```js
const wide = media("(min-width: 60rem)");
effect(() => document.body.classList.toggle("wide", wide()));
```

Throws `Error` if no `matchMedia` is available and no `ssrDefault` was configured. Throws `TypeError` if a configured factory returns a non-MQL-shaped object.

### Preference shortcuts

Each is `() => MediaSignal` — hoist once per component, then read call-style:

```js
const rm = reducedMotion();
effect(() => { if (!rm()) startAnimation(); });
```

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

Function form — not module-level pre-created signals — is deliberate. Creating signals at import time would require `globalThis.matchMedia` at module load, which breaks SSR-honest defaults. The hoist step costs one line and buys clean off-DOM semantics.

### `configure(options): void`

Test / SSR seam. Must be called **before** the first successful `media()` call — after materialization the module is locked and further `configure()` throws.

```js
configure({
    matchMedia: (query) => mockMediaQueryList(query),
    ssrDefault: false,
});
```

- Non-function `matchMedia` throws `TypeError` at the call site. Silent-drop was rejected because a misspelled import (`someMisspelledName`) would otherwise surface as a confusing "no matchMedia available" error at a distant call site.
- Non-boolean `ssrDefault` (including `undefined`) is a no-op — it does not un-set a previously configured default.
- `null`, `undefined`, and non-objects are all safe no-ops.
- Failed materialization (no factory + no default) does **not** engage the lock. The module remains recoverable — `configure(...)` and retry works.

### `stats(): { watched, configured, locked }`

Cheap live snapshot for demos, perf overlays, and test assertions.

- `watched` — number of memoized signals in the cache.
- `configured` — whether `configure()` explicitly set `matchMedia` or `ssrDefault`. Does **not** count fallback to native `globalThis.matchMedia`.
- `locked` — whether a successful materialization has happened.

---

## Read-only by convention

`MediaSignal` in the `.d.ts` is a structural narrowing of lite-signal's `Signal<boolean>` — it hides `.set` and `.update` from TypeScript. **At runtime, the returned object still has those methods.** A JS consumer or a TS `as` cast can call `.set()`, and doing so will permanently desync the shared signal from the browser until the next real `change` event lands.

If you find yourself wanting to write to a media signal, wrap it in a `computed()` you own — that gives you a signal with the ownership you actually need without polluting the shared one.

---

## Memoization contract

`media()` memoizes by exact string match, for the lifetime of the module (no eviction, no dispose). The design assumes query strings come from a **bounded static set** — interned literals, module-level constants, or a finite table of known breakpoints. That's the right shape for a Twitch overlay or a component library, and it's what lets every subscriber share one browser subscription.

**What you must not do:** build query strings from unbounded input.

```js
// leaks a signal + a change listener per unique width
for (let w = 300; w < 1300; w++) media(`(max-width: ${w}px)`);
```

If you find yourself in this shape, either intern to a fixed breakpoint set (bucket via `Math.floor`), or drop out of memoization and call `matchMedia` directly for the one-off. `media()` is not the right primitive for that workload.

---

## SSR & testing

lite-media is honest about its scope: the memoization cache is module-global, which is exactly right for a page and exactly wrong for a request-per-render server. There is no per-request isolation seam in v1.0.0.

**On the server, two rules apply:**

1. **`ssrDefault` is a process-wide constant.** It's set once at process init and cannot vary per request. UA-derived per-request defaults are not supported — memoization means whichever value materialized a query first is what all subsequent renders in that process see.
2. **Prefer to not render preference-gated content on the server at all.** Emit the pessimistic default (usually `false` — hide, don't show, until the client confirms), then hydrate to the real value client-side.

```js
// process init, once
configure({ ssrDefault: false });
```

If your product needs per-request media state on the server, this v1.0.0 isn't the right package. A `createMedia({ matchMedia, ssrDefault })` factory that produces scoped instances is on the v1.1.0 roadmap if consumer demand shows up.

**Tests:** the mock seam is per-process too, and clears via `__resetForTests()` in `beforeEach`. Any object with `{ matches, addEventListener }` is a valid mock; a mock returning something else throws a `TypeError` naming the `MockMediaQueryList` shape, so shorthand mocks fail fast at the call site.

```js
import { test, beforeEach } from "node:test";
import { configure, media, __resetForTests } from "@zakkster/lite-media";

beforeEach(() => __resetForTests());

test("your test", () => {
    const registry = new Map();
    configure({
        matchMedia: (q) => {
            const entry = registry.get(q) ?? { matches: false, listeners: new Set() };
            registry.set(q, entry);
            return {
                get matches() { return entry.matches; },
                addEventListener: (t, h) => t === "change" && entry.listeners.add(h),
            };
        },
    });
    // ...
});
```

`__resetForTests()` is exported but marked `@internal` — not part of the semver contract. It clears the cache, the configured factory, the SSR default, and the lock in one call.

---

## Recipes

The zero-GC contract is one half of the story; the other is patterns that keep the call sites honest. `@zakkster/lite-watch-ex` isn't a hard dep, but its `when` / `watchUntil` / `watchEffect` primitives are the natural consumers of media signals if you're already in that ecosystem.

### Lazy boot a heavy scene when a breakpoint first matches

```js
import { watchUntil } from "@zakkster/lite-watch-ex";
import { media } from "@zakkster/lite-media";

const wide = media("(min-width: 60rem)");
watchUntil(() => wide(), Boolean, () => bootWebglScene());
// One-shot: initializes the moment `wide` first flips true, then self-disposes.
```

### rAF loop that respects reduced-motion

```js
import { watchEffect } from "@zakkster/lite-watch-ex";
import { reducedMotion } from "@zakkster/lite-media";

const rm = reducedMotion();
watchEffect((onCleanup) => {
    if (rm()) return;
    let id = requestAnimationFrame(function tick(t) {
        render(t);
        id = requestAnimationFrame(tick);
    });
    onCleanup(() => cancelAnimationFrame(id));
});
```

The effect re-runs when `rm()` toggles: cleanup cancels the frame, the new run either starts a fresh loop or does nothing.

### One-shot capability gate

```js
import { when } from "@zakkster/lite-signal";
import { hoverCapable } from "@zakkster/lite-media";

when(hoverCapable(), () => enableHoverPreviews());
// Capability signals effectively never flip at runtime; one-shot is the honest shape.
```

---

## Zero-GC accounting

| Op                                | Allocations                                       |
| --------------------------------- | ------------------------------------------------- |
| `media(query)` — cache hit        | 0 hot-path (Map internal lookup only)             |
| `media(query)` — cache miss, mock | 1 signal + 1 handler closure + 1 MQL (from mock)  |
| `media(query)` — cache miss, native, first | 1 signal + 1 handler + 1 MQL + 1 bound-native fn (bind cached) |
| `media(query)` — cache miss, native, subsequent | 1 signal + 1 handler + 1 MQL         |
| Signal read (`s()`)               | 0                                                 |
| `change` event → sig.set          | 0                                                 |
| Redundant event (same value)      | 0 (Object.is dedup in lite-signal)                |
| Preference shortcut call          | 0 additional (delegates to `media()`)             |

The bound `globalThis.matchMedia` is allocated **once per process** and reused for every native-path cache miss thereafter. Cost scales with **verdict flips**, not with browser events: an event that doesn't move the answer costs one `Object.is` comparison and stops.

---

## Roadmap

- **v1.0.0** — Engine A: `media()`, 8 preferences, `configure()`, `stats()`. *This release.*
- **v1.1.0** — Engine B: `containerMedia(el, query)` via injected `@container` rules + `transitionrun` events on a zero-size sentinel. Native verdicts (range syntax, `cqw`, `style()` — all free), zero JS query parsing. Also under consideration: `createMedia({ matchMedia, ssrDefault })` factory for scoped instances (unblocks per-request SSR).
- **v1.2.0** — `breakpoints({ sm, md, lg })` interned-token computed; reconsider `standaloneDisplay` / `highDynamicRange` based on consumer demand.
- **v1.3.0** — Shadow DOM multi-root support for engine B; iframe / Twitch panel-mode verification.
- **v1.4.0** — Ecosystem wiring: `lite-ambient-fx` & `lite-scratch-fx` consume `reducedMotion` via the `watchEffect` rAF-gate pattern; `lite-hueforge` pairs `moreContrast` / `forcedColors` with APCA role-floor selection.

Watchlist: [CSSWG #6205](https://github.com/w3c/csswg-drafts/issues/6205) — a native `Element.matchContainer()` would collapse engine B to a feature-detected bridge without changing the signal-graph surface.

---

## Browser & runtime support

Pure ES2020. Any environment that runs `@zakkster/lite-signal` and can either provide `globalThis.matchMedia` or accept a mock through `configure()`.

| Target                                 | Supported                                    |
| -------------------------------------- | -------------------------------------------- |
| Chrome / Edge (last 2 majors)          | yes                                          |
| Firefox (last 2 majors)                | yes                                          |
| Safari 14+                             | yes                                          |
| Node.js 18+                            | yes (with SSR default or mock)               |
| Bun                                    | yes (with SSR default or mock)               |
| Deno                                   | yes (with SSR default or mock — no native `matchMedia`) |
| Twitch Extensions                      | yes                                          |

ESM only. `sideEffects: false` — tree-shakes cleanly.

---

## License

MIT © Zahary Shinikchiev

---

> Part of the **@zakkster** zero-GC stack: [`lite-signal`](https://www.npmjs.com/package/@zakkster/lite-signal) · [`lite-watch-ex`](https://www.npmjs.com/package/@zakkster/lite-watch-ex) · [`lite-store`](https://www.npmjs.com/package/@zakkster/lite-store) · [`lite-throttle`](https://www.npmjs.com/package/@zakkster/lite-throttle) · [`lite-debounce`](https://www.npmjs.com/package/@zakkster/lite-debounce) · [`lite-raf`](https://www.npmjs.com/package/@zakkster/lite-raf) · [`lite-color-engine`](https://www.npmjs.com/package/@zakkster/lite-color-engine)
