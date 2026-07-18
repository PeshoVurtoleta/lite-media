/**
 * @zakkster/lite-media — reactive media & preference signals.
 *
 * Wraps `window.matchMedia` in a lite-signal `Signal<boolean>`. Zero-GC steady
 * state: no timers, no debounce — a `change` event on the underlying
 * MediaQueryList becomes a single `sig.set()` call, and lite-signal's Object.is
 * equality dedupes redundant events for free.
 *
 * Design in one line: JS never evaluates a query. The browser evaluates;
 * lite-media only observes the verdict and pushes a boolean into the graph.
 *
 * v1.0.0 ships Engine A — viewport & preference queries. Container queries
 * (engine B: injected `@container` rules + `transitionrun` events on a
 * zero-size sentinel) land in v1.1.0. See ROADMAP for the mechanism.
 *
 * Scope note: the memoization cache is module-global. That's exactly right
 * for a page or a Twitch overlay, and exactly wrong for a request-per-render
 * server — there is no per-request isolation seam in v1.0.0. `ssrDefault`
 * must be a process-wide constant. A `createMedia()` factory for scoped
 * instances is on the v1.1.0 roadmap.
 *
 * Copyright (c) Zahary Shinikchiev. MIT licensed.
 */

import { signal } from "@zakkster/lite-signal";

// ---------------------------------------------------------------------------
// Interned preference query strings
// ---------------------------------------------------------------------------

const Q_REDUCED_MOTION       = "(prefers-reduced-motion: reduce)";
const Q_DARK_SCHEME          = "(prefers-color-scheme: dark)";
const Q_HOVER_CAPABLE        = "(hover: hover)";
const Q_COARSE_POINTER       = "(pointer: coarse)";
const Q_FORCED_COLORS        = "(forced-colors: active)";
const Q_MORE_CONTRAST        = "(prefers-contrast: more)";
const Q_REDUCED_DATA         = "(prefers-reduced-data: reduce)";
const Q_REDUCED_TRANSPARENCY = "(prefers-reduced-transparency: reduce)";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
// `_locked` is set on SUCCESSFUL materialization only. A failed media() call
// (no matchMedia + no ssrDefault) leaves the module recoverable — the caller
// can still `configure(...)` and retry. Reconfiguring after a successful
// materialization would let different consumers get different signals for
// the same query, which is what the lock exists to prevent.
//
// `_boundNative` caches `globalThis.matchMedia.bind(globalThis)` so the bind
// allocation happens once per process, not once per cache miss. It's kept
// out of `_matchMedia` so `stats().configured` still means "user configured
// it," not "we found a native matchMedia."

/** @type {Map<string, import("@zakkster/lite-signal").Signal<boolean>>} */
const _cache = new Map();

/** @type {((query: string) => any) | undefined} */
let _matchMedia = undefined;

/** @type {boolean | undefined} */
let _ssrDefault = undefined;

/** @type {boolean} */
let _locked = false;

/** @type {((query: string) => any) | null} */
let _boundNative = null;

// ---------------------------------------------------------------------------
// resolveMatchMedia
// ---------------------------------------------------------------------------

function resolveMatchMedia() {
    if (_matchMedia !== undefined) return _matchMedia;
    if (_boundNative !== null) return _boundNative;
    if (typeof globalThis !== "undefined"
        && typeof globalThis.matchMedia === "function") {
        _boundNative = globalThis.matchMedia.bind(globalThis);
        return _boundNative;
    }
    return null;
}

// ---------------------------------------------------------------------------
// configure — test/SSR seam
// ---------------------------------------------------------------------------
// Validation is present because `configure()` runs once, on the config path,
// and it's the seam every test author touches. Silent-drop of a mistyped
// import (`matchMedia: someMisspelledName`) would surface as a confusing
// "no matchMedia available" error later — better to throw at the call site
// with a message that names the actual problem.
//
// `typeof cfg.ssrDefault === "boolean"` (not `"ssrDefault" in cfg`) so that
// `configure({ ssrDefault: undefined })` is a no-op rather than un-setting a
// previous default. Matches the "later calls override only the keys they
// set" contract.

/**
 * Configure the matchMedia factory and/or SSR default. Must be called before
 * the first SUCCESSFUL `media()` or preference-shortcut call.
 *
 * @param {{ matchMedia?: (query: string) => any; ssrDefault?: boolean } | null | undefined} cfg
 * @throws {Error} if called after a successful materialization
 * @throws {TypeError} if `matchMedia` is present but not a function
 */
export function configure(cfg) {
    if (_locked) {
        throw new Error(
            "lite-media: configure() must be called before the first successful media() call."
        );
    }
    if (cfg === null || typeof cfg !== "object") return;
    if ("matchMedia" in cfg) {
        if (typeof cfg.matchMedia !== "function") {
            throw new TypeError(
                "lite-media: configure({ matchMedia }) must be a function "
                + "returning a MediaQueryList-shaped object."
            );
        }
        _matchMedia = cfg.matchMedia;
    }
    if (typeof cfg.ssrDefault === "boolean") _ssrDefault = cfg.ssrDefault;
}

// ---------------------------------------------------------------------------
// media
// ---------------------------------------------------------------------------

/**
 * Materialize (or fetch cached) reactive boolean signal for a CSS media query.
 *
 * The returned signal:
 *   • Reads (`sig()`, `sig.peek()`, `sig.subscribe()`) work as lite-signal defines.
 *   • Is shared across all callers of the same query string.
 *   • Reflects `mql.matches`; updates on the `change` event of the underlying MQL.
 *   • Never fires spuriously — `Object.is` in lite-signal drops equal `set` calls.
 *
 * Query strings must come from a bounded static set — the memoization cache
 * has no eviction. See README "Memoization contract" for the precondition.
 *
 * @param {string} query — CSS media query string (e.g. "(max-width: 600px)")
 * @returns {import("@zakkster/lite-signal").Signal<boolean>}
 * @throws {Error} if no matchMedia is available and no `ssrDefault` was configured
 * @throws {TypeError} if the configured matchMedia factory returns a non-MQL-shaped object
 */
export function media(query) {
    let sig = _cache.get(query);
    if (sig !== undefined) return sig;

    const mm = resolveMatchMedia();
    if (mm === null) {
        if (_ssrDefault === undefined) {
            throw new Error(
                "lite-media: no matchMedia available. Call configure({ matchMedia }) "
                + "with a factory or configure({ ssrDefault }) with a default boolean, "
                + "then retry."
            );
        }
        sig = signal(_ssrDefault);
        _cache.set(query, sig);
        _locked = true;
        return sig;
    }

    const mql = mm(query);
    if (mql === null || typeof mql !== "object"
        || typeof mql.addEventListener !== "function") {
        throw new TypeError(
            "lite-media: matchMedia factory returned an object missing addEventListener. "
            + "Expected the MockMediaQueryList shape "
            + "{ matches: boolean, addEventListener(type: 'change', handler): void }."
        );
    }
    sig = signal(mql.matches);
    // Handler is a closure over `sig` — allocated once at cache-miss time,
    // never per event. Steady state: browser event → sig.set() → lite-signal.
    const handler = (e) => { sig.set(e.matches); };
    mql.addEventListener("change", handler);

    _cache.set(query, sig);
    _locked = true;
    return sig;
}

// ---------------------------------------------------------------------------
// Curated preferences
// ---------------------------------------------------------------------------

/** `(prefers-reduced-motion: reduce)` — user requests reduced motion. */
export function reducedMotion()       { return media(Q_REDUCED_MOTION); }

/** `(prefers-color-scheme: dark)` — user prefers dark UI. */
export function darkScheme()          { return media(Q_DARK_SCHEME); }

/** `(hover: hover)` — primary input supports true hover (mouse, trackpad). */
export function hoverCapable()        { return media(Q_HOVER_CAPABLE); }

/** `(pointer: coarse)` — primary input is coarse (finger, stylus). */
export function coarsePointer()       { return media(Q_COARSE_POINTER); }

/** `(forced-colors: active)` — OS forced-colors / high-contrast mode is on. */
export function forcedColors()        { return media(Q_FORCED_COLORS); }

/** `(prefers-contrast: more)` — user requests higher contrast. */
export function moreContrast()        { return media(Q_MORE_CONTRAST); }

/** `(prefers-reduced-data: reduce)` — user opted into data-saver mode. */
export function reducedData()         { return media(Q_REDUCED_DATA); }

/** `(prefers-reduced-transparency: reduce)` — user requests reduced transparency. */
export function reducedTransparency() { return media(Q_REDUCED_TRANSPARENCY); }

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

/**
 * Snapshot of module state.
 *
 * @returns {{ watched: number; configured: boolean; locked: boolean }}
 *   watched     — number of memoized signals currently in the cache
 *   configured  — whether configure() has set matchMedia or ssrDefault
 *                 (does NOT count native globalThis.matchMedia fallback)
 *   locked      — whether a successful materialization has happened
 */
export function stats() {
    return {
        watched: _cache.size,
        configured: _matchMedia !== undefined || _ssrDefault !== undefined,
        locked: _locked,
    };
}

// ---------------------------------------------------------------------------
// __resetForTests — internal escape hatch, NOT public API
// ---------------------------------------------------------------------------
// Also clears `_boundNative` so tests that toggle native matchMedia on/off
// between blocks (rare, but the SSR-guarded tests do it) see a clean resolve.

/** @internal — test-only. */
export function __resetForTests() {
    _cache.clear();
    _matchMedia = undefined;
    _ssrDefault = undefined;
    _locked = false;
    _boundNative = null;
}
