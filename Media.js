/**
 * @zakkster/lite-media v1.5.1
 *
 * Reactive media & preference signals. v1.1.0 adds:
 *   - createMedia({ matchMedia, ssrDefault, containerEngine }) -- scoped
 *     instances with their own memoization cache, unblocking per-request SSR.
 *   - containerMedia(el, query) -- Engine B: browser-native container-query
 *     verdicts via an injected `@container` rule + zero-size sentinel +
 *     `transitionrun` on a registered `<custom-ident>` custom property.
 *
 * v1.1.2 adds a dev-only container-type footgun warning (dropped in
 * production), pins the SSR container contract and the registry-bounds
 * invariant, and adds the __flipForTests container seam. No new runtime API.
 *
 * v1.2.0 adds:
 *   - breakpoints({ name: minWidthPx }) -- a named responsive band map compiled
 *     to ONE interned-token computed<string> (the active band name). Reads are
 *     zero-alloc; a band change notifies downstream exactly once.
 *   - standaloneDisplay() and highDynamicRange() -- the final two of the ten
 *     curated preference signals.
 *
 * v1.3.0 adds:
 *   - containerStyle(el, prop, value) -- Engine B's style()-query class: a
 *     Signal<boolean> for `@container style(<prop>: <value>)`. Constructs the
 *     condition and routes it through the SAME sentinel engine as
 *     containerMedia(); no new evaluator, no query parser. Unlike a size query,
 *     a style() query needs no container-type on any ancestor, so the footgun
 *     warning stays silent for it. The caller owns the queried property; we
 *     never register it (only --lm-v is ours).
 *
 * v1.4.0 (M2 hardening) makes Engine B multi-root. containerMedia() /
 *   containerStyle() now resolve el.getRootNode() and keep one constructed
 *   @container sheet PER root (main document, shadow root, or cross-realm iframe
 *   document), adopted into that root and built in that root's own realm. Before,
 *   the single document-adopted sheet left any sentinel inside a shadow root or a
 *   foreign realm stuck-false. --lm-v is still registered exactly once across all
 *   roots and the query->id map stays global. No API change (strict correctness).
 *   A root that can't be styled fails closed to a stuck-false signal, never
 *   throwing. The per-root sheet map is a WeakMap so detached roots are not pinned.
 *
 * v1.4.1 (bfcache / pageshow lifecycle) pins a per-instance answer across a
 *   back/forward-cache restore. A page restored from bfcache does NOT re-fire
 *   matchMedia `change` or container `transitionrun`, so a signal can sit stale
 *   against a preference or verdict that changed while the page was frozen. Each
 *   instance now lazily attaches ONE `pageshow` listener (on the first media()/
 *   containerMedia()) that no-ops unless `event.persisted === true`, then
 *   re-reads every watched mql.matches (Engine A) and every live sentinel's
 *   computed --lm-v (Engine B) and re-pushes the fresh boolean through the SAME
 *   set path a real event uses. Every read is fail-closed and page-lifetime;
 *   nothing is torn down. The hot read/flip paths are unchanged and stay
 *   0-alloc. No new public API (the seam is the internal __pageshowForTests).
 *
 * v1.5.0 (M3 ecosystem wiring) adds NOTHING to the runtime -- this file's
 *   minified output is identical to 1.4.1. The release ships a tested, copy-
 *   pasteable reduced-motion rAF-gate recipe (reducedMotion() + lite-signal
 *   effect({ scheduler })) for consumers already in the signal graph, its
 *   conformance + torture gates, and the vendor-vs-depend decision record.
 *
 * The v1.0 module-level API (`media`, `configure`, `stats`, preferences,
 * `__resetForTests`) is preserved. Internally it now delegates to a lazily
 * created default instance; `configure()` mutates that instance's options
 * before the first successful materialization (same lock semantics as v1.0).
 *
 * Design in one line, unchanged: JS never evaluates a query. The browser
 * evaluates; lite-media only observes the verdict and pushes a boolean into
 * the graph. Engine B follows the same rule via CSS custom-property
 * transitions -- never a JS query parser.
 *
 * Copyright (c) Zahary Shinikchiev. MIT licensed.
 */

import { signal, computed } from "@zakkster/lite-signal";

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
const Q_STANDALONE_DISPLAY   = "(display-mode: standalone)";
const Q_HIGH_DYNAMIC_RANGE   = "(dynamic-range: high)";

// ---------------------------------------------------------------------------
// Container engines
// ---------------------------------------------------------------------------
// The engine is a strategy: `watch(el, query, onChange) -> { initial, dispose }`.
// Node/SSR gets an inert engine. Browser gets the sentinel + transitionrun
// implementation. Tests pass a mock engine via createMedia({ containerEngine }).

// SSR / no-DOM contract (pinned v1.1.2): containerMedia() off-DOM returns a
// stable `false` signal, never throwing. A container's size cannot be known
// server-side, and `false` ("container does not match this size") is the
// conservative, fail-closed verdict -- it renders the not-yet-sized layout.
// This deliberately differs from media(), which throws without ssrDefault:
// a media feature (dark mode, reduced motion) has no safe default to assume,
// but an unmeasured container does. ssrDefault does NOT apply to this path.
const NODE_CONTAINER_ENGINE = {
    watch(_el, _query, _onChange) {
        return { initial: false, dispose: NOOP };
    },
};

function NOOP() {}

// Constant-false verdict reader, swapped in (cold, once per watch) when a realm's
// getComputedStyle is unavailable or throws, so the hot read body never grows.
function FALSE_READER() { return false; }

// Shared, frozen empty id-set for the fail-closed root stub. A null/foreign root
// returns an inert stub that never reaches ensureRule (watch() bails on
// state.doc === null), so it needs no per-root Set -- one immutable instance
// avoids a needless cold-path allocation. Frozen so a stray add() fails loud.
const EMPTY_IDS = Object.freeze(new Set());

// ---------------------------------------------------------------------------
// Dev-only diagnostics (LM-02) -- the container-type footgun warning
// ---------------------------------------------------------------------------
// The call site (in containerMedia) guards this with the standard inline env
// check `typeof process !== "undefined" && process.env.NODE_ENV !==
// "production"`, so a bundler that defines process.env.NODE_ENV folds the
// condition to `false` and dead-code-eliminates the whole block from a
// production build. In Node it is a cheap env read on the COLD materialization
// path only -- never on the hot signal read. We WARN, never mutate: setting
// container-type changes sizing semantics and that is the caller's decision.

// An unnamed @container query resolves against the nearest ANCESTOR that is a
// query container (container-type: size | inline-size). If the watched element
// and every ancestor compute to `container-type: normal`, no query container
// exists, the query can never match, and the signal stays false forever -- the
// classic silent-mismatch footgun. Warn once per offending element.
function warnIfNoQueryContainer(el, query, warned) {
    // LM-04: a style() container query resolves against the nearest ANCESTOR
    // element regardless of its container-type -- it does NOT need a size query
    // container (container-type: size | inline-size). So the missing-container
    // footgun simply does not apply, and warning would be a false positive.
    // Skip any condition that begins with `style(`: that is every
    // containerStyle() condition, plus any raw style() string passed straight to
    // containerMedia(). A compound condition whose size half genuinely needs a
    // container is expert use of the raw path and is intentionally outside this
    // heuristic.
    if (typeof query === "string" && query.trim().slice(0, 6) === "style(") return;
    if (typeof getComputedStyle !== "function") return; // SSR / no DOM: nothing to read
    if (warned.has(el)) return;
    let node = el;
    let depth = 0;
    while (node !== null && typeof node === "object" && depth < 1000) {
        let ct = "";
        try {
            const cs = getComputedStyle(node);
            if (cs !== null && typeof cs === "object"
                && typeof cs.getPropertyValue === "function") {
                ct = cs.getPropertyValue("container-type").trim();
            }
        } catch (_e) {
            return; // getComputedStyle threw (foreign/detached node): stay silent
        }
        if (ct !== "" && ct !== "normal") return; // a query container exists -- no footgun
        node = (node.parentElement != null) ? node.parentElement : null;
        depth++;
    }
    warned.add(el);
    console.warn(
        "lite-media: containerMedia() is watching an element whose computed "
        + "container-type is 'normal' (no query container on it or its "
        + "ancestors). The @container query " + JSON.stringify(query)
        + " can never match, so this signal will stay false. Set "
        + "'container-type: size' (or 'inline-size') on the element you want "
        + "to query.",
        el
    );
}

// Sentinel base rule, shared verbatim by every per-root sheet: zero-size,
// invisible, never interactive. --lm-v defaults to `off` outside any matching
// @container. Hoisted to a module const so replaceSync establishes the same base
// rule in each root's own constructed sheet without re-materializing the literal.
const LM_BASE_CSS =
    ".__lm-s{--lm-v:off;position:absolute;inset:0;width:0;height:0;"
    + "pointer-events:none;visibility:hidden;overflow:hidden;contain:strict}";

// The browser engine is built as a factory so its state (query registry, per-root
// sheets) is fresh per createMedia() call -- normally there's just one, but tests
// can construct isolated instances.
//
// Multi-root (v1.4.0): a container element can live in the main document, in a
// shadow root, or in a cross-realm iframe document. A single document-adopted
// sheet only styles the main document, so a sentinel inside a shadow root or a
// foreign realm would never see --lm-v flip and its signal would sit stuck-false.
// The engine therefore resolves el.getRootNode() and keeps ONE constructed sheet
// per root, adopted into THAT root, built in THAT root's own realm.
function makeBrowserContainerEngine() {
    // Global (per-instance) query -> id map + counter: one stable data-q id per
    // query string across every root, so the selector is identical everywhere and
    // --lm-v is registered exactly once. Only WHICH ids' rules are already
    // inserted is tracked per root (state.ids).
    /** @type {Map<string, number>} */
    const queryIds = new Map();
    let counter = 0;
    let propertyRegistered = false;

    // Roots-bounds invariant (v1.4.0; mirrors createMedia's registry-bounds
    // invariant on `cache`): this holds one sheet state per LIVE root the engine
    // has styled. It is a WeakMap, NOT a Map, on purpose -- a strong Map would pin
    // every detached shadow root and dead iframe document for the page lifetime, a
    // retention class the leak law forbids. Nothing iterates it, so a WeakMap is
    // strictly correct: a live root keeps its sheet (the don't-rebuild behavior),
    // a dropped root is collected together with its sheet. A root's sheet and its
    // inserted rules are RETAINED on last dispose (never removed on teardown; a
    // re-watch of that root reuses the same sheet) -- bounded by concurrent root
    // count, not by watcher count.
    /** @type {WeakMap<object, { doc: any, view: any, sheet: any, ids: Set<number> }>} */
    const roots = new WeakMap();

    // v1.4.1 bfcache: live verdict readers, one per successful watch(). resync()
    // re-reads each verdict and re-pushes it through the same onChange a
    // `transitionrun` would call -- the only path by which a container verdict
    // that changed while the page was frozen reaches the graph on restore. This
    // is a STRONG-ref Set on purpose (nothing iterates it lazily), so dispose()
    // MUST delete its entry: a forgotten delete would pin the record -> verdict
    // -> computed style -> sentinel for the page lifetime. The torture live-set
    // tier is the guard for that.
    /** @type {Set<{ verdict: () => boolean, onChange: (m: boolean) => void }>} */
    const live = new Set();

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

    // Resolve the DOM root (Document | ShadowRoot) that styles `el`. getRootNode()
    // is the shadow-aware path; ownerDocument is the fallback for a host without
    // it. A non-object result fails closed to null.
    function resolveRoot(el) {
        const root = (typeof el.getRootNode === "function")
            ? el.getRootNode()
            : (el.ownerDocument || null);
        return (root !== null && typeof root === "object") ? root : null;
    }

    // Get-or-create the per-root sheet state, memoized in `roots`. sheet===null
    // memoizes the fail-closed verdict for a root we can't fully style (Ctor
    // unavailable, no adoptedStyleSheets support, or a throwing construct/adopt):
    // never retried, never thrown. doc===null means there's no styleable document
    // at all (null/foreign root) -- watch() then returns an inert stub without
    // touching the DOM. Every risky step is wrapped so a hostile/foreign root
    // degrades to a stuck-false signal instead of throwing out of watch().
    function getRootState(root) {
        if (root === null || typeof root !== "object") {
            return { doc: null, view: null, sheet: null, ids: EMPTY_IDS };
        }
        let state = roots.get(root);
        if (state !== undefined) return state;
        const doc = (root.nodeType === 9) ? root : (root.ownerDocument || null);
        const view = (doc !== null && typeof doc === "object") ? doc.defaultView : null;
        // Construct the sheet in the ROOT's OWN realm so adoption can't throw
        // across realms. The global CSSStyleSheet fallback is allowed ONLY for the
        // main document's own realm -- never adopt a wrong-realm sheet.
        let Ctor = (view && typeof view.CSSStyleSheet === "function")
            ? view.CSSStyleSheet
            : null;
        if (Ctor === null && doc !== null
            && typeof globalThis !== "undefined"
            && doc === globalThis.document
            && typeof globalThis.CSSStyleSheet === "function") {
            Ctor = globalThis.CSSStyleSheet;
        }
        let sheet = null;
        if (Ctor !== null && ("adoptedStyleSheets" in root)) {
            try {
                const s = new Ctor();
                s.replaceSync(LM_BASE_CSS); // establishes this root's base rule
                // The exact multi-root fix: adopt into the ROOT, not the document.
                root.adoptedStyleSheets = [...root.adoptedStyleSheets, s];
                sheet = s;
            } catch (_e) {
                sheet = null; // fail closed for this root
            }
        }
        state = { doc: doc, view: view, sheet: sheet, ids: new Set() };
        roots.set(root, state);
        return state;
    }

    // Ensure the @container rule for `query` exists in THIS root's sheet. The id
    // is assigned GLOBALLY (a fail-closed root still burns a stable id, so the
    // selector matches once the root becomes styleable elsewhere). The id is
    // marked seen BEFORE insertRule so a throwing insert never retry-storms on a
    // later watch of the same root+query.
    function ensureRule(state, query) {
        let id = queryIds.get(query);
        if (id === undefined) {
            id = ++counter;
            queryIds.set(query, id);
        }
        if (state.sheet !== null && !state.ids.has(id)) {
            state.ids.add(id);
            // Inside a matching @container, flip verdict to `on` with an
            // allow-discrete transition so `transitionrun` fires per flip.
            // 0.001ms is deliberately below-frame -- verdict propagates
            // immediately; we don't need duration, we need the event.
            const rule = "@container " + query + "{"
                + ".__lm-s[data-q=\"" + id + "\"]{--lm-v:on;"
                + "transition:--lm-v 0.001ms allow-discrete}}";
            try {
                state.sheet.insertRule(rule, state.sheet.cssRules.length);
            } catch (_e) {
                // A rejected rule (bad query, rule-count ceiling) leaves the
                // verdict false for this root+query. Already marked seen: no retry.
            }
        }
        return id;
    }

    return {
        watch(el, query, onChange) {
            ensureRegisteredProperty();
            const root = resolveRoot(el);
            const state = getRootState(root);
            if (state.doc === null) {
                // Fail-closed root: no realm/document to style against. Stuck
                // false, no DOM touched.
                return { initial: false, dispose: NOOP };
            }
            const id = ensureRule(state, query);

            const sentinel = state.doc.createElement("div");
            sentinel.className = "__lm-s";
            sentinel.setAttribute("data-q", String(id));
            el.appendChild(sentinel);

            let cs = null;
            try {
                // Method form so a brand-checking engine keeps its `this` (window);
                // fall back to the global only when the realm has no view.
                cs = state.view
                    ? state.view.getComputedStyle(sentinel)
                    : getComputedStyle(sentinel);
            } catch (_e) {
                cs = null;
            }
            function read() {
                return cs.getPropertyValue("--lm-v").trim() === "on";
            }
            // Cold swap: a realm with no usable getComputedStyle reads constant
            // false, so the hot read body above never grows a guard.
            const verdict = (cs !== null) ? read : FALSE_READER;
            const initial = verdict();

            // The browser fires `transitionrun` for a discrete-transition
            // property when its value changes. That's our verdict-flip
            // signal -- one event, one push.
            function handler(e) {
                if (e.propertyName === "--lm-v") onChange(verdict());
            }
            sentinel.addEventListener("transitionrun", handler);

            // v1.4.1: register this reader for bfcache resync. Deleted on
            // dispose (below) so `live` never outlives the watcher.
            const rec = { verdict: verdict, onChange: onChange };
            live.add(rec);

            let disposed = false;
            return {
                initial,
                dispose() {
                    if (disposed) return;
                    disposed = true;
                    live.delete(rec); // FIRST: drop the strong ref, always
                    sentinel.removeEventListener("transitionrun", handler);
                    if (sentinel.parentNode !== null) {
                        sentinel.parentNode.removeChild(sentinel);
                    }
                },
            };
        },
        // v1.4.1 bfcache: re-read every live verdict and re-push it. A restored
        // page never re-fires `transitionrun`, so this is the only route by which
        // a verdict that changed while the page was frozen reaches the graph.
        // Fail-closed per entry: a throwing read or onChange never aborts the
        // loop or throws out to the caller (never throw on an unverified state).
        resync() {
            for (const rec of live) {
                let v;
                try { v = rec.verdict(); } catch (_e) { continue; }
                try { rec.onChange(v); } catch (_e) { /* keep going */ }
            }
        },
        // @internal test-only seam: the live-set size, read DIRECTLY and
        // deterministically (no GC-finalization timing). The torture retention
        // gate asserts this returns to 0 after dispose -- it trips the instant
        // dispose() forgets its live.delete, which a finalization proxy cannot
        // guarantee to catch.
        _liveSize() { return live.size; },
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
// breakpoints() -- named responsive bands as one interned-token signal
// ---------------------------------------------------------------------------
// A breakpoint map { name: minWidthPx } compiles to ONE computed<string> whose
// value is the active band: the name of the highest-threshold entry whose
// (min-width: Npx) currently matches, with the SMALLEST entry acting as the
// mobile-first floor whenever nothing larger matches. The map's own keys are
// the tokens the computed returns, so an unchanged band yields the SAME string
// reference and the computed's === equality makes downstream effects run
// exactly once per real band change. We CONSTRUCT each `(min-width: Npx)` query
// and observe it through media() -- never a JS width comparison -- so a band flip
// inherits the media path's proven allocation profile and the sentinel thesis
// ("JS never evaluates a query") holds here too.

// Validate a breakpoint map and return { key, names, thresholds } sorted
// ascending by threshold. Runs once per DISTINCT map on the cold compile path
// (the returned computed is memoized on `key`), so the allocation here is not
// on any hot path. Fails loud on a malformed map -- an unmeasured band is a
// silent-mismatch footgun of exactly the kind lite-media exists to prevent.
function normalizeBreakpoints(map) {
    if (map === null || typeof map !== "object") {
        throw new TypeError(
            "lite-media: breakpoints(map) requires an object of { name: minWidthPx }."
        );
    }
    const names = Object.keys(map);
    if (names.length === 0) {
        throw new TypeError(
            "lite-media: breakpoints(map) requires at least one { name: minWidthPx } entry."
        );
    }
    const pairs = [];
    for (let i = 0; i < names.length; i++) {
        const name = names[i];
        const px = map[name];
        if (typeof px !== "number" || !Number.isFinite(px) || px < 0) {
            throw new TypeError(
                "lite-media: breakpoints() value for " + JSON.stringify(name)
                + " must be a finite, non-negative pixel number, got " + String(px) + "."
            );
        }
        pairs.push({ name: name, px: px });
    }
    // Ascending by threshold; ties keep declaration order (Array.prototype.sort
    // is stable), so two bands at the same width resolve deterministically.
    pairs.sort((a, b) => a.px - b.px);
    const sortedNames = [];
    const thresholds = [];
    let key = "";
    for (let i = 0; i < pairs.length; i++) {
        sortedNames.push(pairs[i].name);
        thresholds.push(pairs[i].px);
        if (i > 0) key += "|";
        key += pairs[i].name + ":" + pairs[i].px;
    }
    return { key: key, names: sortedNames, thresholds: thresholds };
}

// ---------------------------------------------------------------------------
// createMedia -- the fundamental factory
// ---------------------------------------------------------------------------
// Each instance carries its own memoization cache and options. Scoped
// instances DO NOT lock -- they're throwaway by design, per-request or
// per-test. The module-level default instance implements v1.0's lock
// semantics on top of this primitive.

/**
 * Create a scoped lite-media instance. Options are set at creation and can't
 * be reconfigured -- that's the point. For per-request SSR, create a new
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

    // Registry-bounds invariant (pinned v1.1.2): this per-instance Map is the
    // ONE unbounded structure in the module -- it grows by one entry per DISTINCT
    // query string, never per call (repeat calls hit the memo). The contract is
    // that an app's query vocabulary is small and static (a handful of
    // breakpoints + the fixed preference set), so the Map reaches a low steady
    // size and stops. Feeding it unbounded distinct query strings grows it
    // without bound BY DESIGN -- same call lite-router's queryParam memo made:
    // documented invariant + test, not a runtime cap. Torture: registry-bounds.
    /** @type {Map<string, any>} */
    const cache = new Map();
    // v1.4.1 bfcache: sibling of `cache`, keyed by the SAME query string -> the
    // live MediaQueryList. Populated on media()'s cold path only (never on a
    // cache hit, so the hot read is untouched). _resync() re-reads each
    // mql.matches and re-pushes it through the signal's set -- the same path
    // media()'s `change` handler uses. Bounded exactly like `cache`: one entry
    // per DISTINCT query, never per call. ssrDefault signals have no mql and are
    // never added, so resync skips them.
    /** @type {Map<string, any>} */
    const mqls = new Map();
    // breakpoints() memo, keyed by the canonical map key (see
    // normalizeBreakpoints). Same registry-bounds contract as `cache`: one
    // entry per DISTINCT breakpoint set, and an app's set of band maps is
    // small and static. The boundary boolean signals themselves live in
    // `cache` (breakpoints() builds them through media()), shared across every
    // band map that reuses a threshold.
    /** @type {Map<string, any>} */
    const breakpointsCache = new Map();
    /** @type {WeakMap<object, Map<string, any>>} */
    const containerCache = new WeakMap();
    // Dev-only: elements already warned about a missing query container, so the
    // LM-02 warning fires at most once per element. WeakMap-adjacent (WeakSet)
    // so it never retains an element the caller has dropped.
    /** @type {WeakSet<object>} */
    const warnedContainers = new WeakSet();
    // Test-only seam (LM-03): maps a container signal to the engine onChange
    // that drives it, so __flipForTests()/_flip() can simulate a verdict flip
    // on the default instance (which uses the real node/browser engine, not a
    // mock). Keyed by signal identity, off the signal's shape -- same reasoning
    // as containerDisposers below.
    /** @type {WeakMap<any, (matches: boolean) => void>} */
    const containerOnChange = new WeakMap();
    // Per-instance disposers keyed by signal identity. Kept off the signal
    // object so containerMedia() and media() signals share the same V8
    // hidden class -- critical for monomorphic effect() call sites that read
    // both kinds. Ready for a future explicit dispose API without a v1.1
    // signal-shape churn.
    /** @type {WeakMap<any, () => void>} */
    const containerDisposers = new WeakMap();
    /** @type {((q: string) => any) | null} */
    let boundNative = null;
    // v1.4.1 bfcache: this instance attaches ONE `pageshow` listener, lazily, on
    // its first media()/containerMedia(). Guard flag => at most once per
    // instance; SSR/no-DOM (no addEventListener) sets the flag and does nothing.
    let pageshowAttached = false;

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

    // v1.4.1 bfcache: re-pin every watched answer. Engine A re-reads each mql and
    // re-pushes its verdict; Engine B delegates to the engine's own resync. Each
    // Engine-A entry is fail-closed (a throwing matches getter or set must not
    // abort the rest or escape). sig.set dedups an unchanged value to a no-op, so
    // an UNCHANGED restore fires zero downstream runs and retains 0 B; a value
    // that changed while the page was frozen fires exactly one run. Cold path
    // only -- never on a hot read.
    function _resync() {
        for (const query of mqls.keys()) {
            try {
                const mql = mqls.get(query);
                const sig = cache.get(query);
                if (sig !== undefined && mql !== undefined) {
                    sig.set(mql.matches === true);
                }
            } catch (_e) { /* fail-closed per entry */ }
        }
        const eng = containerEngine;
        if (eng !== null && typeof eng.resync === "function") {
            try { eng.resync(); } catch (_e) { /* fail-closed */ }
        }
    }

    // The `pageshow` listener body. Only a bfcache restore (persisted === true)
    // re-pins the answer; an ordinary navigation pageshow is a no-op (nothing
    // went stale). NOT visibilitychange -- a tab hidden/shown in place keeps
    // firing live change/transitionrun events, so it needs no resync.
    function onPageshow(e) {
        if (!e || e.persisted !== true) return;
        _resync();
    }

    function ensurePageshow() {
        if (pageshowAttached) return;
        pageshowAttached = true; // at most once, even on SSR (then a no-op)
        if (typeof globalThis !== "undefined"
            && typeof globalThis.addEventListener === "function") {
            globalThis.addEventListener("pageshow", onPageshow);
        }
    }

    function media(query) {
        let sig = cache.get(query);
        if (sig !== undefined) return sig;
        ensurePageshow(); // cold path only; hot cache hit returned above
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
        mqls.set(query, mql); // sibling entry for bfcache resync (cold path)
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
        ensurePageshow(); // cold path only; hot cache hit returned above

        // Dev-only footgun check (LM-02). The `typeof process` guard keeps
        // unbundled browsers safe (short-circuits before touching process.env),
        // while the adjacent `process.env.NODE_ENV !== "production"` lets a
        // bundler fold the condition to `false` and dead-code-eliminate the
        // whole block from a production build. Runs on first materialization
        // for this (el, query); silent off-DOM.
        if (typeof process !== "undefined" && process.env.NODE_ENV !== "production") {
            warnIfNoQueryContainer(el, query, warnedContainers);
        }

        const engine = resolveContainerEngine();
        // Two-phase init: engine returns `initial` synchronously and MUST
        // NOT invoke onChange until after `watch` returns. Engines that
        // need to signal a sync state change during watch() should fold it
        // into `initial` -- the `sig` reference does not exist yet, so a
        // sync call to onChange here silently drops the flip.
        const onChange = (matches) => {
            if (sig !== undefined) sig.set(matches);
        };
        const { initial, dispose } = engine.watch(el, query, onChange);
        sig = signal(initial);
        // Disposers live in a per-instance WeakMap keyed by signal identity,
        // NOT as a property on the signal. Tagging the signal object would
        // give containerMedia() signals a different V8 hidden class than
        // media() signals -- any shared effect() reading both would go
        // polymorphic. Kept off the shape for zero divergence.
        containerDisposers.set(sig, dispose);
        containerOnChange.set(sig, onChange);
        elCache.set(query, sig);
        return sig;
    }

    // containerStyle(el, prop, value) -> Signal<boolean> for a container STYLE
    // query: is `prop` computed to `value` on el's nearest ancestor container?
    // Constructs the canonical condition `style(<prop>: <value>)` and routes it
    // through containerMedia -- so it inherits the exact engine, memoization,
    // disposer, _flip seam and 0-B/flip allocation profile. We CONSTRUCT the
    // condition (never parse one), and we never register the caller's property
    // (only --lm-v is ours), so the "no query parsing" thesis and the
    // no-namespace-pollution rule both hold. LM-04: the footgun warning skips
    // style() conditions, since they need no size container.
    function containerStyle(el, prop, value) {
        if (el === null || (typeof el !== "object" && typeof el !== "function")) {
            throw new TypeError(
                "lite-media: containerStyle(el, prop, value) requires an Element as first arg."
            );
        }
        if (typeof prop !== "string" || prop === "") {
            throw new TypeError(
                "lite-media: containerStyle(el, prop, value) requires a non-empty "
                + "property-name string (e.g. '--theme')."
            );
        }
        if (typeof value !== "string") {
            throw new TypeError(
                "lite-media: containerStyle(el, prop, value) requires a string value "
                + "(e.g. 'dark')."
            );
        }
        // Canonical form: exactly one space after the colon. A raw
        // containerMedia(el, 'style(--theme: dark)') with the same spacing hits
        // the SAME cached signal; different spacing is a different cache key,
        // which the static-query-vocabulary precondition already covers.
        return containerMedia(el, "style(" + prop + ": " + value + ")");
    }

    // Test-only seam (LM-03). Simulate an engine verdict flip by routing
    // `matches` through the exact onChange the engine would call. Lets a test
    // exercise the containerMedia -> sig.set path (including sig.set's
    // equal-value no-op dedup) on the default instance without a real browser.
    // Throws if `sig` is not a live container signal from THIS instance.
    function _flip(sig, matches) {
        const onChange = containerOnChange.get(sig);
        if (onChange === undefined) {
            throw new Error(
                "lite-media: _flip() expects a container signal returned by "
                + "this instance's containerMedia(). Unknown signal."
            );
        }
        onChange(matches === true);
    }

    // breakpoints(map) -> computed<string> of the active band name. See the
    // normalizeBreakpoints header for the model. Memoized per canonical map key.
    function breakpoints(map) {
        const norm = normalizeBreakpoints(map);
        let sig = breakpointsCache.get(norm.key);
        if (sig !== undefined) return sig;
        const names = norm.names;
        const thresholds = norm.thresholds;
        // One boundary boolean per threshold, via media() so the MQL wiring,
        // memoization and allocation profile are shared. Built once here on the
        // cold path; a throw from media() (no matchMedia + no ssrDefault)
        // propagates before anything is cached, same fail-loud contract.
        const boundaries = [];
        for (let i = 0; i < thresholds.length; i++) {
            boundaries.push(media("(min-width: " + thresholds[i] + "px)"));
        }
        // Active band = highest-index boundary that matches; else the floor
        // (index 0, the smallest threshold). The scan reads pre-built arrays
        // and returns a stored token -- no allocation on the hot read path.
        // Index 0 is never read here: it is the unconditional floor, so we
        // neither track it nor pay for a boundary that would only flip below
        // the smallest declared width. `names` holds stable string references,
        // so an unchanged band returns === the same token and computed's
        // equality suppresses the downstream notification (one run per flip).
        sig = computed(() => {
            for (let i = boundaries.length - 1; i >= 1; i--) {
                if (boundaries[i]()) return names[i];
            }
            return names[0];
        });
        breakpointsCache.set(norm.key, sig);
        return sig;
    }

    function stats() {
        return {
            watched: cache.size,
            bands: breakpointsCache.size,
            // Only user-supplied config counts as "configured". A lazily-
            // resolved default engine (detectDefaultContainerEngine on first
            // containerMedia call) does not flip this bit -- otherwise merely
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
        containerStyle,
        breakpoints,
        reducedMotion()       { return media(Q_REDUCED_MOTION); },
        darkScheme()          { return media(Q_DARK_SCHEME); },
        hoverCapable()        { return media(Q_HOVER_CAPABLE); },
        coarsePointer()       { return media(Q_COARSE_POINTER); },
        forcedColors()        { return media(Q_FORCED_COLORS); },
        moreContrast()        { return media(Q_MORE_CONTRAST); },
        reducedData()         { return media(Q_REDUCED_DATA); },
        reducedTransparency() { return media(Q_REDUCED_TRANSPARENCY); },
        standaloneDisplay()   { return media(Q_STANDALONE_DISPLAY); },
        highDynamicRange()    { return media(Q_HIGH_DYNAMIC_RANGE); },
        stats,
        _flip,
        // v1.4.1 test-only seams (LM bfcache). _resync() runs the raw resync
        // path (no event object); _pageshow(persisted) exercises the exact gated
        // listener body a real `pageshow` would. See __pageshowForTests.
        _resync,
        _pageshow(persisted) { onPageshow({ persisted: persisted }); },
    };
}

// ---------------------------------------------------------------------------
// Default instance -- v1.0 module-level surface with lock semantics
// ---------------------------------------------------------------------------
// Configuration accumulates in module-scope slots. The instance is (re-)built
// on first materialization, capturing whatever configure() has set. Once a
// materialization succeeds, the lock engages and further configure() throws.
// A failed materialization does NOT lock -- same recoverable contract as v1.0.

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

/**
 * Materialize a reactive boolean signal for a container STYLE query
 * (`@container style(<prop>: <value>)`), scoped to an element. Constructs the
 * condition and delegates to containerMedia(); same lock semantics. A style()
 * query needs no container-type on any ancestor. See createMedia().containerStyle.
 */
export function containerStyle(el, prop, value) {
    const result = ensureDefault().containerStyle(el, prop, value);
    _defaultLocked = true;
    return result;
}

/**
 * Compile a named breakpoint map `{ name: minWidthPx }` into a single
 * computed<string> whose value is the active band name (the highest matching
 * threshold, with the smallest entry as the mobile-first floor). Same lock
 * semantics as media(). See createMedia().breakpoints for the model.
 */
export function breakpoints(map) {
    const result = ensureDefault().breakpoints(map);
    _defaultLocked = true;
    return result;
}

// Preference shortcuts -- delegate through the module-level media() so the
// lock semantics apply uniformly.
export function reducedMotion()       { return media(Q_REDUCED_MOTION); }
export function darkScheme()          { return media(Q_DARK_SCHEME); }
export function hoverCapable()        { return media(Q_HOVER_CAPABLE); }
export function coarsePointer()       { return media(Q_COARSE_POINTER); }
export function forcedColors()        { return media(Q_FORCED_COLORS); }
export function moreContrast()        { return media(Q_MORE_CONTRAST); }
export function reducedData()         { return media(Q_REDUCED_DATA); }
export function reducedTransparency() { return media(Q_REDUCED_TRANSPARENCY); }
export function standaloneDisplay()   { return media(Q_STANDALONE_DISPLAY); }
export function highDynamicRange()    { return media(Q_HIGH_DYNAMIC_RANGE); }

/** Cheap snapshot of the default instance's state. */
export function stats() {
    const inst = _defaultInstance;
    const snap = inst !== null ? inst.stats() : null;
    return {
        watched: snap !== null ? snap.watched : 0,
        bands: snap !== null ? snap.bands : 0,
        configured: _defaultMatchMedia !== undefined
            || _defaultSsrDefault !== undefined
            || _defaultContainerEngine !== undefined,
        locked: _defaultLocked,
    };
}

/** @internal -- test-only. Resets ALL default-instance state including engine. */
export function __resetForTests() {
    _defaultMatchMedia = undefined;
    _defaultSsrDefault = undefined;
    _defaultContainerEngine = undefined;
    _defaultLocked = false;
    _defaultInstance = null;
}

/**
 * @internal -- test-only escape hatch. NOT part of the semver contract.
 * Simulate a container verdict flip on the default instance by routing
 * `matches` through the engine onChange that owns `sig`. Materializing the
 * default instance if needed; throws if `sig` is not one of its container
 * signals. See createMedia()._flip.
 */
export function __flipForTests(sig, matches) {
    return ensureDefault()._flip(sig, matches);
}

/**
 * @internal -- test-only escape hatch. NOT part of the semver contract.
 * Returns a fresh browser container engine (the same factory
 * detectDefaultContainerEngine picks in a browser realm), so the v1.4.0
 * multi-root watch/dispose contract can be exercised directly against a mock
 * DOM. There is no public container-dispose API; this is the seam the multi-root
 * dispose tests use, mirroring __flipForTests / __resetForTests.
 */
export function __browserEngineForTests() {
    return makeBrowserContainerEngine();
}

/**
 * @internal -- test-only escape hatch. NOT part of the semver contract.
 * Synthesize a `pageshow` on the default instance with the given `persisted`
 * flag and run the exact gated listener body (v1.4.1 bfcache). persisted !==
 * true is a no-op; persisted === true re-pins every Engine A mql verdict and
 * every Engine B sentinel verdict, so tests exercise the restore path with no
 * real browser. Mirrors __flipForTests. Materializes the default instance.
 */
export function __pageshowForTests(persisted) {
    return ensureDefault()._pageshow(persisted);
}
