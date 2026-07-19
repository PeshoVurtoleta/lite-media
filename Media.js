/**
 * @zakkster/lite-media v1.1.0
 *
 * Reactive media & preference signals. v1.1.0 adds:
 *   - createMedia({ matchMedia, ssrDefault, containerEngine }) — scoped
 *     instances with their own memoization cache, unblocking per-request SSR.
 *   - containerMedia(el, query) — Engine B: browser-native container-query
 *     verdicts via an injected `@container` rule + zero-size sentinel +
 *     `transitionrun` on a registered `<custom-ident>` custom property.
 *
 * The v1.0 module-level API (`media`, `configure`, `stats`, 8 preferences,
 * `__resetForTests`) is preserved. Internally it now delegates to a lazily
 * created default instance; `configure()` mutates that instance's options
 * before the first successful materialization (same lock semantics as v1.0).
 *
 * Design in one line, unchanged: JS never evaluates a query. The browser
 * evaluates; lite-media only observes the verdict and pushes a boolean into
 * the graph. Engine B follows the same rule via CSS custom-property
 * transitions — never a JS query parser.
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
// Container engines
// ---------------------------------------------------------------------------
// The engine is a strategy: `watch(el, query, onChange) -> { initial, dispose }`.
// Node/SSR gets an inert engine. Browser gets the sentinel + transitionrun
// implementation. Tests pass a mock engine via createMedia({ containerEngine }).

const NODE_CONTAINER_ENGINE = {
    watch(_el, _query, _onChange) {
        return { initial: false, dispose: NOOP };
    },
};

function NOOP() {}

// The browser engine is built as a factory so its state (stylesheet, query
// registry) is fresh per createMedia() call — normally there's just one, but
// tests can construct isolated instances.
function makeBrowserContainerEngine() {
    /** @type {CSSStyleSheet | null} */
    let sheet = null;
    let injected = false;
    /** @type {Map<string, number>} */
    const queryIds = new Map();
    let counter = 0;
    let propertyRegistered = false;

    function ensureRegisteredProperty() {
        if (propertyRegistered) return;
        propertyRegistered = true;
        if (typeof CSS !== "undefined" && typeof CSS.registerProperty === "function") {
            try {
                CSS.registerProperty({
                    name: "--lm-v",
                    syntax: "<custom-ident>",
                    initialValue: "off",
                    inherits: false,
                });
            } catch (_e) {
                // Already registered by us on a prior page eval, or by another
                // library. `<custom-ident>` is stable and interchangeable
                // enough that this is fine.
            }
        }
    }

    function ensureStylesheet() {
        if (injected) return;
        injected = true;
        ensureRegisteredProperty();
        sheet = new CSSStyleSheet();
        // Sentinel base: zero-size, invisible, never interactive.
        // --lm-v defaults to `off` outside any matching @container.
        sheet.replaceSync(
            ".__lm-s{--lm-v:off;position:absolute;inset:0;width:0;height:0;"
            + "pointer-events:none;visibility:hidden;overflow:hidden;contain:strict}"
        );
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    }

    function ensureRule(query) {
        let id = queryIds.get(query);
        if (id !== undefined) return id;
        id = ++counter;
        queryIds.set(query, id);
        // Inside a matching @container, flip verdict to `on` with an
        // allow-discrete transition so `transitionrun` fires per flip.
        // 0.001ms is deliberately below-frame — verdict propagates immediately;
        // we don't need duration, we need the event.
        const rule = "@container " + query + "{"
            + ".__lm-s[data-q=\"" + id + "\"]{--lm-v:on;"
            + "transition:--lm-v 0.001ms allow-discrete}}";
        sheet.insertRule(rule, sheet.cssRules.length);
        return id;
    }

    return {
        watch(el, query, onChange) {
            ensureStylesheet();
            const id = ensureRule(query);

            const sentinel = document.createElement("div");
            sentinel.className = "__lm-s";
            sentinel.setAttribute("data-q", String(id));
            el.appendChild(sentinel);

            const cs = getComputedStyle(sentinel);
            function read() {
                return cs.getPropertyValue("--lm-v").trim() === "on";
            }
            const initial = read();

            // The browser fires `transitionrun` for a discrete-transition
            // property when its value changes. That's our verdict-flip
            // signal — one event, one push.
            function handler(e) {
                if (e.propertyName === "--lm-v") onChange(read());
            }
            sentinel.addEventListener("transitionrun", handler);

            let disposed = false;
            return {
                initial,
                dispose() {
                    if (disposed) return;
                    disposed = true;
                    sentinel.removeEventListener("transitionrun", handler);
                    if (sentinel.parentNode !== null) {
                        sentinel.parentNode.removeChild(sentinel);
                    }
                },
            };
        },
    };
}

function detectDefaultContainerEngine() {
    if (typeof document !== "undefined" && document !== null
        && typeof document.createElement === "function"
        && typeof globalThis.CSSStyleSheet === "function"
        && "adoptedStyleSheets" in document) {
        return makeBrowserContainerEngine();
    }
    return NODE_CONTAINER_ENGINE;
}

// ---------------------------------------------------------------------------
// createMedia — the fundamental factory
// ---------------------------------------------------------------------------
// Each instance carries its own memoization cache and options. Scoped
// instances DO NOT lock — they're throwaway by design, per-request or
// per-test. The module-level default instance implements v1.0's lock
// semantics on top of this primitive.

/**
 * Create a scoped lite-media instance. Options are set at creation and can't
 * be reconfigured — that's the point. For per-request SSR, create a new
 * instance per request; for tests, create a fresh instance per test.
 *
 * @param {{
 *   matchMedia?: (query: string) => any;
 *   ssrDefault?: boolean;
 *   containerEngine?: { watch: (el: any, query: string, onChange: (m: boolean) => void) => { initial: boolean; dispose: () => void } };
 * }} [opts]
 */
export function createMedia(opts) {
    const options = (opts === null || typeof opts !== "object") ? {} : opts;

    const matchMediaFactory = typeof options.matchMedia === "function"
        ? options.matchMedia : undefined;
    const ssrDefault = typeof options.ssrDefault === "boolean"
        ? options.ssrDefault : undefined;
    // Track user-supplied engine separately from the lazily-resolved one, so
    // stats().configured only reports true when the user explicitly asked
    // for a specific engine (not merely because a containerMedia() call
    // triggered detectDefaultContainerEngine()).
    let userContainerEngine = null;
    let containerEngine = null;
    if (options.containerEngine !== undefined && options.containerEngine !== null) {
        if (typeof options.containerEngine !== "object"
            || typeof options.containerEngine.watch !== "function") {
            throw new TypeError(
                "lite-media: createMedia({ containerEngine }) must be an object with a "
                + "watch(el, query, onChange) method returning { initial, dispose }."
            );
        }
        userContainerEngine = options.containerEngine;
        containerEngine = options.containerEngine;
    }

    /** @type {Map<string, any>} */
    const cache = new Map();
    /** @type {WeakMap<object, Map<string, any>>} */
    const containerCache = new WeakMap();
    // Per-instance disposers keyed by signal identity. Kept off the signal
    // object so containerMedia() and media() signals share the same V8
    // hidden class — critical for monomorphic effect() call sites that read
    // both kinds. Ready for a future explicit dispose API without a v1.1
    // signal-shape churn.
    /** @type {WeakMap<any, () => void>} */
    const containerDisposers = new WeakMap();
    /** @type {((q: string) => any) | null} */
    let boundNative = null;

    function resolveMatchMedia() {
        if (matchMediaFactory !== undefined) return matchMediaFactory;
        if (boundNative !== null) return boundNative;
        if (typeof globalThis !== "undefined"
            && typeof globalThis.matchMedia === "function") {
            boundNative = globalThis.matchMedia.bind(globalThis);
            return boundNative;
        }
        return null;
    }

    function resolveContainerEngine() {
        if (containerEngine !== null) return containerEngine;
        containerEngine = detectDefaultContainerEngine();
        return containerEngine;
    }

    function media(query) {
        let sig = cache.get(query);
        if (sig !== undefined) return sig;
        const mm = resolveMatchMedia();
        if (mm === null) {
            if (ssrDefault === undefined) {
                throw new Error(
                    "lite-media: no matchMedia available. Pass matchMedia or ssrDefault "
                    + "to createMedia(), or (on the default instance) call configure({...})."
                );
            }
            sig = signal(ssrDefault);
            cache.set(query, sig);
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
        // Read initial verdict once. Register the change listener FIRST so a
        // throwing addEventListener does not orphan a lite-signal node
        // against the 1024-node budget (would compound across retries).
        const initial = mql.matches;
        // sig is populated after successful registration; handler closes
        // over the outer `let sig` binding, so any browser event before
        // assignment (which shouldn't be possible from a compliant MQL) is
        // a safe no-op.
        const handler = (e) => { if (sig !== undefined) sig.set(e.matches); };
        mql.addEventListener("change", handler);
        sig = signal(initial);
        cache.set(query, sig);
        return sig;
    }

    function containerMedia(el, query) {
        if (el === null || (typeof el !== "object" && typeof el !== "function")) {
            throw new TypeError(
                "lite-media: containerMedia(el, query) requires an Element as first arg."
            );
        }
        if (typeof query !== "string") {
            throw new TypeError(
                "lite-media: containerMedia(el, query) requires a query string."
            );
        }
        let elCache = containerCache.get(el);
        if (elCache === undefined) {
            elCache = new Map();
            containerCache.set(el, elCache);
        }
        let sig = elCache.get(query);
        if (sig !== undefined) return sig;

        const engine = resolveContainerEngine();
        // Two-phase init: engine returns `initial` synchronously and MUST
        // NOT invoke onChange until after `watch` returns. Engines that
        // need to signal a sync state change during watch() should fold it
        // into `initial` — the `sig` reference does not exist yet, so a
        // sync call to onChange here silently drops the flip.
        const onChange = (matches) => {
            if (sig !== undefined) sig.set(matches);
        };
        const { initial, dispose } = engine.watch(el, query, onChange);
        sig = signal(initial);
        // Disposers live in a per-instance WeakMap keyed by signal identity,
        // NOT as a property on the signal. Tagging the signal object would
        // give containerMedia() signals a different V8 hidden class than
        // media() signals — any shared effect() reading both would go
        // polymorphic. Kept off the shape for zero divergence.
        containerDisposers.set(sig, dispose);
        elCache.set(query, sig);
        return sig;
    }

    function stats() {
        return {
            watched: cache.size,
            // Only user-supplied config counts as "configured". A lazily-
            // resolved default engine (detectDefaultContainerEngine on first
            // containerMedia call) does not flip this bit — otherwise merely
            // *using* the instance would look like the user configured it.
            configured: matchMediaFactory !== undefined
                || ssrDefault !== undefined
                || userContainerEngine !== null,
            locked: false, // scoped instances don't lock
        };
    }

    return {
        media,
        containerMedia,
        reducedMotion()       { return media(Q_REDUCED_MOTION); },
        darkScheme()          { return media(Q_DARK_SCHEME); },
        hoverCapable()        { return media(Q_HOVER_CAPABLE); },
        coarsePointer()       { return media(Q_COARSE_POINTER); },
        forcedColors()        { return media(Q_FORCED_COLORS); },
        moreContrast()        { return media(Q_MORE_CONTRAST); },
        reducedData()         { return media(Q_REDUCED_DATA); },
        reducedTransparency() { return media(Q_REDUCED_TRANSPARENCY); },
        stats,
    };
}

// ---------------------------------------------------------------------------
// Default instance — v1.0 module-level surface with lock semantics
// ---------------------------------------------------------------------------
// Configuration accumulates in module-scope slots. The instance is (re-)built
// on first materialization, capturing whatever configure() has set. Once a
// materialization succeeds, the lock engages and further configure() throws.
// A failed materialization does NOT lock — same recoverable contract as v1.0.

let _defaultMatchMedia = undefined;
let _defaultSsrDefault = undefined;
let _defaultContainerEngine = undefined;
let _defaultLocked = false;
let _defaultInstance = null;

function ensureDefault() {
    if (_defaultInstance !== null) return _defaultInstance;
    _defaultInstance = createMedia({
        matchMedia: _defaultMatchMedia,
        ssrDefault: _defaultSsrDefault,
        containerEngine: _defaultContainerEngine,
    });
    return _defaultInstance;
}

/**
 * Configure the default instance's matchMedia factory, SSR default, and/or
 * container engine. Must be called before the first successful `media()` /
 * `containerMedia()` / preference call.
 *
 * @throws {Error} if called after a successful materialization
 * @throws {TypeError} for non-function matchMedia or malformed containerEngine
 */
export function configure(cfg) {
    if (_defaultLocked) {
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
        _defaultMatchMedia = cfg.matchMedia;
    }
    if (typeof cfg.ssrDefault === "boolean") _defaultSsrDefault = cfg.ssrDefault;
    if ("containerEngine" in cfg) {
        if (cfg.containerEngine !== null
            && (typeof cfg.containerEngine !== "object"
                || typeof cfg.containerEngine.watch !== "function")) {
            throw new TypeError(
                "lite-media: configure({ containerEngine }) must be null or an object with "
                + "a watch(el, query, onChange) method."
            );
        }
        _defaultContainerEngine = cfg.containerEngine === null ? undefined : cfg.containerEngine;
    }
    // Rebuild the default on next use so new options take effect. Safe
    // because _defaultLocked === false means no materialized signals exist.
    _defaultInstance = null;
}

/**
 * Materialize (or fetch cached) reactive boolean signal for a CSS media query.
 * See createMedia() for the underlying contract; this variant participates in
 * the default instance's lock semantics.
 */
export function media(query) {
    const result = ensureDefault().media(query);
    _defaultLocked = true;
    return result;
}

/**
 * Materialize a reactive boolean signal for a container query, scoped to an
 * element. Same lock semantics as media().
 */
export function containerMedia(el, query) {
    const result = ensureDefault().containerMedia(el, query);
    _defaultLocked = true;
    return result;
}

// Preference shortcuts — delegate through the module-level media() so the
// lock semantics apply uniformly.
export function reducedMotion()       { return media(Q_REDUCED_MOTION); }
export function darkScheme()          { return media(Q_DARK_SCHEME); }
export function hoverCapable()        { return media(Q_HOVER_CAPABLE); }
export function coarsePointer()       { return media(Q_COARSE_POINTER); }
export function forcedColors()        { return media(Q_FORCED_COLORS); }
export function moreContrast()        { return media(Q_MORE_CONTRAST); }
export function reducedData()         { return media(Q_REDUCED_DATA); }
export function reducedTransparency() { return media(Q_REDUCED_TRANSPARENCY); }

/** Cheap snapshot of the default instance's state. */
export function stats() {
    const inst = _defaultInstance;
    return {
        watched: inst !== null ? inst.stats().watched : 0,
        configured: _defaultMatchMedia !== undefined
            || _defaultSsrDefault !== undefined
            || _defaultContainerEngine !== undefined,
        locked: _defaultLocked,
    };
}

/** @internal — test-only. Resets ALL default-instance state including engine. */
export function __resetForTests() {
    _defaultMatchMedia = undefined;
    _defaultSsrDefault = undefined;
    _defaultContainerEngine = undefined;
    _defaultLocked = false;
    _defaultInstance = null;
}
