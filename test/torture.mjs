// ===========================================================================
// lite-media torture gate  --  node --expose-gc test/torture.mjs
// ===========================================================================
// The mandated proof gate (CLAUDE.md pipeline): every module change is proven
// here. It commits the package's central allocation claims as numbers and
// proves the teardown/ownership contract, using:
//   @zakkster/lite-gc-profiler  -- does this operation allocate?
//   @zakkster/lite-leak         -- was this resource released when disposed?
//
// No gate output is a FAIL: the script runs every tier to completion, prints a
// verdict per tier, and exits non-zero if any hard assertion failed.
//
// Node-budget note: lite-signal enforces a fixed ~1024 live-node budget. Tiers
// that need many signals dispose() each one to free the pool, so the churn
// counts below are real, not capped by the budget. Where a ceiling IS the
// finding (registry fail-closed), we exercise it deliberately and log it.

import {
    assertAllocs, measureAllocs,
    GcProfiler, checkNoGc,
    GcBudgetError, GcInconclusiveError,
} from "@zakkster/lite-gc-profiler";
import { createLeakTracker } from "@zakkster/lite-leak";
import { effect, dispose } from "@zakkster/lite-signal";
import { createMedia, __browserEngineForTests } from "../Media.js";

// This file lives in test/, so `node --test` (used by `npm test`) discovers and
// runs it too. Without --expose-gc the allocation gates cannot run, so we skip
// cleanly (exit 0) rather than fail the suite. The real gate is
// `npm run test:torture` (node --expose-gc test/torture.mjs), and `npm run
// test:gc` (node --expose-gc --test) runs these gates in-suite with gc present.
if (typeof globalThis.gc !== "function") {
    console.log("torture: skipped -- run `npm run test:torture` (needs --expose-gc).");
    process.exit(0);
}

// --- tiny runner -----------------------------------------------------------
let failures = 0;
let warns = 0;
const committed = {}; // tier -> committed number, printed at the end

function gate(name, fn) {
    try {
        const note = fn();
        console.log("  PASS  " + name + (note ? "  -- " + note : ""));
    } catch (err) {
        if (err instanceof GcInconclusiveError) {
            warns += 1;
            console.log("  WARN  " + name + "  -- inconclusive: " + err.message);
            return;
        }
        failures += 1;
        const msg = (err && err.message) ? err.message : String(err);
        console.log("  FAIL  " + name + "  -- " + msg);
    }
}

// Async variant for a retention gate that must gc + settle before reading
// tracker.size() (lite-leak finalizers fire asynchronously). Same verdict
// contract as gate().
async function gateAsync(name, fn) {
    try {
        const note = await fn();
        console.log("  PASS  " + name + (note ? "  -- " + note : ""));
    } catch (err) {
        if (err instanceof GcInconclusiveError) {
            warns += 1;
            console.log("  WARN  " + name + "  -- inconclusive: " + err.message);
            return;
        }
        failures += 1;
        const msg = (err && err.message) ? err.message : String(err);
        console.log("  FAIL  " + name + "  -- " + msg);
    }
}

// A flippable multi-query matchMedia mock. Reuses one event object across all
// flips so the HARNESS contributes no per-call allocation -- anything measured
// is lite-media's + lite-signal's.
function makeMatchMedia() {
    const handlers = new Map(); // query -> handler
    const state = new Map();    // query -> matches
    const evt = { matches: false };
    const mm = (query) => ({
        get matches() { return state.get(query) === true; },
        addEventListener(type, h) { if (type === "change") handlers.set(query, h); },
        removeEventListener(type, h) { if (type === "change" && handlers.get(query) === h) handlers.delete(query); },
    });
    function flip(query, matches) {
        if (state.get(query) === matches) return; // real change only
        state.set(query, matches);
        evt.matches = matches;
        const h = handlers.get(query);
        if (h) h(evt);
    }
    // Mutate the verdict WITHOUT dispatching a change event -- exactly what a
    // bfcache freeze does (the answer moves while the page is suspended and no
    // event is delivered until something re-reads it). The bfcache tier uses
    // this to prove resync() re-pins a verdict a `change` handler never saw.
    function setSilent(query, matches) { state.set(query, matches); }
    return { mm, flip, setSilent };
}

// A minimal realm/DOM mock so the v1.4.0 multi-root tiers can drive the REAL
// browser engine (via __browserEngineForTests / detectDefaultContainerEngine)
// browserlessly. The measured 0-B loops go through _flip (no DOM touch); the mock
// is used only on the cold setup path, so it contributes nothing to the gates.
let mockConstructions = 0;
let mockRegisterCalls = 0;
let _savedDoc;
let _savedSheet;
let _savedGCS;
let _savedCSS;
let _mockDoc;

function makeMockSheetClass() {
    return class Sheet {
        constructor() { mockConstructions += 1; this.rules = []; this.cssRules = this.rules; }
        replaceSync(t) { this.rules.length = 0; this.rules.push(t); }
        insertRule(r, i) { this.rules.splice(i, 0, r); return i; }
    };
}
function mockComputedFor(node) {
    if (node.__cs !== undefined) return node.__cs;
    const cs = {
        getPropertyValue(p) {
            if (p === "container-type") return "inline-size";
            if (p === "--lm-v") return node.__lmv === undefined ? "off" : node.__lmv;
            return "";
        },
    };
    node.__cs = cs;
    return cs;
}
function makeMockSentinel(doc) {
    const listeners = [];
    return {
        nodeType: 1, ownerDocument: doc, className: "", parentNode: null,
        __attrs: {}, __lmv: "off", __listeners: listeners,
        setAttribute(k, v) { this.__attrs[k] = v; },
        addEventListener(type, h) { listeners.push({ type: type, h: h }); },
        removeEventListener(type, h) {
            for (let i = 0; i < listeners.length; i += 1) {
                if (listeners[i].type === type && listeners[i].h === h) { listeners.splice(i, 1); return; }
            }
        },
    };
}
function installMockDom() {
    mockConstructions = 0;
    mockRegisterCalls = 0;
    _savedDoc = globalThis.document;
    _savedSheet = globalThis.CSSStyleSheet;
    _savedGCS = globalThis.getComputedStyle;
    _savedCSS = globalThis.CSS;
    const Sheet = makeMockSheetClass();
    const win = { CSSStyleSheet: Sheet, getComputedStyle: mockComputedFor };
    _mockDoc = {
        nodeType: 9, defaultView: win, ownerDocument: null, adoptedStyleSheets: [],
        createElement(_t) { return makeMockSentinel(_mockDoc); },
    };
    globalThis.document = _mockDoc;
    globalThis.CSSStyleSheet = Sheet;
    globalThis.getComputedStyle = mockComputedFor;
    globalThis.CSS = { registerProperty() { mockRegisterCalls += 1; } };
    return _mockDoc;
}
function restoreMockDom() {
    try { globalThis.document = _savedDoc; }
    finally {
        try { globalThis.CSSStyleSheet = _savedSheet; }
        finally {
            try { globalThis.getComputedStyle = _savedGCS; }
            finally { globalThis.CSS = _savedCSS; }
        }
    }
}
function makeMockShadowRoot(doc) {
    return { nodeType: 11, host: null, ownerDocument: doc, adoptedStyleSheets: [] };
}
function makeMockElement(root, doc) {
    return {
        nodeType: 1, ownerDocument: doc, parentElement: null, children: [], __root: root,
        getRootNode() { return this.__root; },
        appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
        removeChild(c) {
            const i = this.children.indexOf(c);
            if (i >= 0) this.children.splice(i, 1);
            c.parentNode = null; return c;
        },
    };
}

// ---------------------------------------------------------------------------
console.log("lite-media torture gate\n");

// TIER 1 -- media path: 0 bytes retained per flip. -----------------------------
gate("media path: 0 B retained per flip (assertAllocs maxBytesPerCall:0)", () => {
    const { mm, flip } = makeMatchMedia();
    const m = createMedia({ matchMedia: mm });
    const q = "(min-width: 700px)";
    const sig = m.media(q);
    let sink = false;
    const stop = effect(() => { sink = sig(); });
    let v = false;
    const one = () => { v = !v; flip(q, v); };
    const r = measureAllocs(one, { iterations: 2000, batches: 8 });
    committed["media.bytesPerFlip"] = r.bytesPerCall;
    assertAllocs(one, { maxBytesPerCall: 0 }, { iterations: 2000, batches: 8 });
    stop();
    dispose(sig);
    if (sink !== v) throw new Error("effect did not observe the last flip");
    return "bytesPerCall=" + r.bytesPerCall;
});

// TIER 2 -- container path: 0 B per verdict flip AND 0 B per non-flip frame. ---
// The package's central perf claim in v1.1.x: cost is flat -- a container
// verdict is a boolean, so a flip is a zero-alloc sig.set and a resize frame
// that does not cross a breakpoint costs nothing at all.
gate("container path: 0 B per verdict flip", () => {
    const m = createMedia({ ssrDefault: false }); // node inert engine
    const sig = m.containerMedia({}, "(min-width: 400px)");
    let sink = false;
    const stop = effect(() => { sink = sig(); });
    let v = false;
    const one = () => { v = !v; m._flip(sig, v); };
    const r = measureAllocs(one, { iterations: 2000, batches: 8 });
    committed["container.bytesPerFlip"] = r.bytesPerCall;
    assertAllocs(one, { maxBytesPerCall: 0 }, { iterations: 2000, batches: 8 });
    stop();
    dispose(sig);
    if (sink !== v) throw new Error("effect did not observe the last flip");
    return "bytesPerCall=" + r.bytesPerCall;
});

gate("container path: 0 B per non-flip frame (allocation tracks flips, not frames)", () => {
    const m = createMedia({ ssrDefault: false });
    const sig = m.containerMedia({}, "(min-width: 400px)");
    let sink = false;
    const stop = effect(() => { sink = sig(); });
    const frame = () => { m._flip(sig, true); }; // steady verdict: no-op after first
    const r = measureAllocs(frame, { iterations: 2000, batches: 8 });
    committed["container.bytesPerFrame"] = r.bytesPerCall;
    assertAllocs(frame, { maxBytesPerCall: 0 }, { iterations: 2000, batches: 8 });
    stop();
    dispose(sig);
    void sink;
    return "bytesPerCall=" + r.bytesPerCall;
});

// TIER 3 -- media flip storm: no major GC, no ArrayBuffer growth. ---------------
gate("media flip storm: no major GC + 0 ArrayBuffer growth (100 sigs x 2000 toggles)", () => {
    const { mm, flip } = makeMatchMedia();
    const m = createMedia({ matchMedia: mm });
    const N = 100;
    const sigs = [];
    const stops = [];
    let sink = 0;
    for (let i = 0; i < N; i += 1) {
        const q = "(min-width: " + (100 + i) + "px)";
        const s = m.media(q);
        sigs.push({ q, s });
        stops.push(effect(() => { sink += s() ? 1 : 0; }));
    }
    function storm(v0) {
        let v = v0;
        for (let t = 0; t < 2000; t += 1) {
            v = !v;
            for (let i = 0; i < N; i += 1) flip(sigs[i].q, v);
        }
        return v;
    }
    // (a) ArrayBuffer growth -- measured with NO profiler in the window, so the
    //     profiler's own ring buffers are not attributed to lite-media.
    storm(false); // warm
    globalThis.gc();
    const ab0 = process.memoryUsage().arrayBuffers;
    storm(false);
    globalThis.gc();
    const ab1 = process.memoryUsage().arrayBuffers;
    const abGrowth = ab1 - ab0;
    // (b) Major-GC check -- profiler around a separate storm run.
    const prof = new GcProfiler();
    prof.start();
    storm(false);
    prof.forceSettle();
    const summary = prof.summary();
    prof.stop();
    committed["storm.arrayBuffersGrowthBytes"] = abGrowth;
    committed["storm.majors"] = summary.gc ? summary.gc.major : null;
    const res = checkNoGc(summary, { maxMajor: 0 });
    for (const st of stops) st();
    for (const { s } of sigs) dispose(s);
    if (res.verdict === "fail") {
        throw new Error("major GC during steady-state flips: " + JSON.stringify(res.violations));
    }
    if (abGrowth > 0) {
        throw new Error("ArrayBuffer backing store grew " + abGrowth + " B during flip storm");
    }
    void sink;
    return "majors=" + (summary.gc ? summary.gc.major : "?")
        + " abGrowth=" + abGrowth + "B verdict=" + res.verdict;
});

// TIER 4 -- duplicate-event storm: exactly one effect run (WebKit #279012). -----
// A flip that re-fires with the same verdict must produce no additional effect
// run, because sig.set with an equal value is a no-op.
gate("duplicate-event storm: 10k duplicate flips => exactly one effect run", () => {
    const m = createMedia({ ssrDefault: false });
    const sig = m.containerMedia({}, "(min-width: 400px)");
    let runs = 0;
    const stop = effect(() => { runs += 1; sig(); });
    const base = runs; // 1 (effects run once on creation)
    for (let i = 0; i < 10000; i += 1) m._flip(sig, true); // all identical
    const afterDupes = runs;
    m._flip(sig, false); // a real change
    const afterChange = runs;
    stop();
    dispose(sig);
    if (afterDupes !== base + 1) {
        throw new Error("duplicate flips re-ran the effect: base=" + base
            + " afterDupes=" + afterDupes + " (expected " + (base + 1) + ")");
    }
    if (afterChange !== afterDupes + 1) {
        throw new Error("a real verdict change did not re-run the effect");
    }
    return "runs: creation=1, +1 on first true, +0 across 9999 dupes, +1 on change";
});

// TIER 5 -- attach/detach churn: every watcher releases its resources. ----------
// lite-leak answers ownership: a sentinel tracked to a watcher whose dispose
// runs must be released; a dispose that forgets is a finding. The instrumented
// engine mirrors the browser engine's create-sentinel / dispose-removes-
// listener lifecycle (the real engine needs a DOM); lite-media drives it and
// stores each disposer, which we invoke to simulate teardown.
function churn(forgetUntrack, N) {
    let leaks = 0;
    const tracker = createLeakTracker({
        name: "lite-media-container",
        onLeak: () => { leaks += 1; },
    });
    const disposers = [];
    const engine = {
        watch(el, query, _onChange) {
            const sentinel = { el, query };          // stand-in for the DOM sentinel
            const handle = tracker.track(sentinel, () => {}); // owned resource
            let disposed = false;
            const d = {
                initial: false,
                dispose() {
                    if (disposed) return;
                    disposed = true;
                    if (!forgetUntrack) tracker.untrack(handle); // release ownership
                },
            };
            disposers.push(d.dispose);
            return d;
        },
    };
    const m = createMedia({ containerEngine: engine });
    for (let i = 0; i < N; i += 1) {
        const el = {};
        const sig = m.containerMedia(el, "(min-width: 400px)");
        dispose(sig); // free the node-pool slot; el is dropped next iteration
    }
    const liveBeforeTeardown = tracker.size();
    for (const d of disposers) d();
    return { tracker, leaks, liveBeforeTeardown, liveAfter: tracker.size(), N };
}

gate("attach/detach churn (4096): clean teardown releases every sentinel", () => {
    const N = 4096;
    const r = churn(false, N);
    if (r.liveBeforeTeardown !== N) {
        throw new Error("expected " + N + " tracked before teardown, got " + r.liveBeforeTeardown);
    }
    if (r.liveAfter !== 0) {
        throw new Error("after disposing all watchers, " + r.liveAfter + " sentinels still tracked");
    }
    return N + " watched -> 0 after dispose";
});

gate("attach/detach churn control: a dispose that forgets untrack IS caught", () => {
    const N = 512;
    const r = churn(true, N);
    // The control proves the gate above can fail: forgotten untrack leaves the
    // sentinels owned. If this did NOT leak, the clean gate proves nothing.
    if (r.liveAfter !== N) {
        throw new Error("control did not surface the leak: liveAfter=" + r.liveAfter);
    }
    return "control leaks " + r.liveAfter + " as expected (gate is load-bearing)";
});

// TIER 7 -- breakpoints: cost tracks band CHANGES, not resize frames. -----------
// The v1.2.0 claim: breakpoints() compiles to one interned-token computed, so a
// band change is a zero-alloc token swap and a read of a stable band is a
// zero-alloc cache hit. A resize that does not cross a threshold fires no
// boundary event at all -- there is nothing to measure between crossings -- so
// the honest per-frame proof is that a stable-band READ costs nothing.
gate("breakpoints: 0 B retained per band change (assertAllocs maxBytesPerCall:0)", () => {
    const { mm, flip } = makeMatchMedia();
    const m = createMedia({ matchMedia: mm });
    const Q_MD = "(min-width: 768px)";
    const bp = m.breakpoints({ sm: 0, md: 768, lg: 1024 });
    let sink = "";
    const stop = effect(() => { sink = bp(); });
    let v = false;
    const one = () => { v = !v; flip(Q_MD, v); }; // sm <-> md: one band change/call
    const r = measureAllocs(one, { iterations: 2000, batches: 8 });
    committed["breakpoints.bytesPerBandChange"] = r.bytesPerCall;
    assertAllocs(one, { maxBytesPerCall: 0 }, { iterations: 2000, batches: 8 });
    stop();
    dispose(bp);
    dispose(m.media(Q_MD));
    dispose(m.media("(min-width: 1024px)"));
    dispose(m.media("(min-width: 0px)"));
    if (sink !== (v ? "md" : "sm")) throw new Error("effect did not observe the last band");
    return "bytesPerCall=" + r.bytesPerCall;
});

gate("breakpoints: 0 B per read of a stable band (cache hit, flat vs frame count)", () => {
    const { mm, flip } = makeMatchMedia();
    const m = createMedia({ matchMedia: mm });
    flip("(min-width: 768px)", true); // land on a stable "md"
    const bp = m.breakpoints({ sm: 0, md: 768, lg: 1024 });
    let sink = "";
    const stop = effect(() => { sink = bp(); }); // make the computed live + clean
    const read = () => { sink = bp(); };          // stable-band read: cache hit
    const r = measureAllocs(read, { iterations: 2000, batches: 8 });
    committed["breakpoints.bytesPerStableRead"] = r.bytesPerCall;
    assertAllocs(read, { maxBytesPerCall: 0 }, { iterations: 2000, batches: 8 });
    stop();
    dispose(bp);
    dispose(m.media("(min-width: 768px)"));
    dispose(m.media("(min-width: 1024px)"));
    dispose(m.media("(min-width: 0px)"));
    if (sink !== "md") throw new Error("stable band was not 'md'");
    return "bytesPerCall=" + r.bytesPerCall;
});

gate("breakpoints: exactly one downstream run per band change (2000-cycle sweep)", () => {
    const { mm, flip } = makeMatchMedia();
    const m = createMedia({ matchMedia: mm });
    const Q_MD = "(min-width: 768px)";
    const Q_LG = "(min-width: 1024px)";
    const bp = m.breakpoints({ sm: 0, md: 768, lg: 1024 });
    let runs = 0;
    let sink = "";
    const stop = effect(() => { runs += 1; sink = bp(); });
    const base = runs; // 1 on creation
    const CYCLES = 2000;
    for (let t = 0; t < CYCLES; t += 1) {
        flip(Q_MD, true);   // sm -> md
        flip(Q_LG, true);   // md -> lg
        flip(Q_LG, false);  // lg -> md
        flip(Q_MD, false);  // md -> sm
    }
    const expected = base + CYCLES * 4; // four real band changes per cycle
    committed["breakpoints.runsPer2000cycles"] = runs;
    stop();
    dispose(bp);
    dispose(m.media(Q_MD));
    dispose(m.media(Q_LG));
    dispose(m.media("(min-width: 0px)"));
    if (runs !== expected) {
        throw new Error("expected " + expected + " runs (1 + 4*" + CYCLES
            + " band changes), got " + runs);
    }
    void sink;
    return runs + " runs = 1 creation + " + (CYCLES * 4) + " band changes";
});

// TIER 8 -- style queries: inherit the container path's zero-alloc profile. -----
// containerStyle() CONSTRUCTS `style(<prop>: <value>)` and routes it through the
// exact containerMedia() path, so a style verdict flip must be the same
// zero-alloc sig.set as a size flip and duplicate verdicts must dedup. These
// gates commit style-specific numbers so a future regression that special-cases
// the style path (e.g. re-parsing or re-constructing the condition per flip)
// fails here. The LM-04 warning-suppression behavior and ITS failing control
// live in test/15-container-style.test.mjs (a behavioral assertion, not a
// number). _flip works on a style signal because containerStyle delegates to
// containerMedia, which registers the onChange seam.
gate("style path: 0 B per verdict flip (assertAllocs maxBytesPerCall:0)", () => {
    const m = createMedia({ ssrDefault: false }); // node inert engine
    const sig = m.containerStyle({}, "--theme", "dark");
    let sink = false;
    const stop = effect(() => { sink = sig(); });
    let v = false;
    const one = () => { v = !v; m._flip(sig, v); };
    const r = measureAllocs(one, { iterations: 2000, batches: 8 });
    committed["style.bytesPerFlip"] = r.bytesPerCall;
    assertAllocs(one, { maxBytesPerCall: 0 }, { iterations: 2000, batches: 8 });
    stop();
    dispose(sig);
    if (sink !== v) throw new Error("effect did not observe the last style flip");
    return "bytesPerCall=" + r.bytesPerCall;
});

gate("style path: duplicate flip => exactly one effect run", () => {
    const m = createMedia({ ssrDefault: false });
    const sig = m.containerStyle({}, "--theme", "dark");
    let runs = 0;
    const stop = effect(() => { runs += 1; sig(); });
    const base = runs; // 1 on creation
    for (let i = 0; i < 10000; i += 1) m._flip(sig, true); // all identical
    const afterDupes = runs;
    m._flip(sig, false); // a real change
    const afterChange = runs;
    stop();
    dispose(sig);
    if (afterDupes !== base + 1) {
        throw new Error("duplicate style flips re-ran the effect: base=" + base
            + " afterDupes=" + afterDupes);
    }
    if (afterChange !== afterDupes + 1) {
        throw new Error("a real style verdict change did not re-run the effect");
    }
    return "runs: creation=1, +1 on first true, +0 across 9999 dupes, +1 on change";
});

gate("style path: dispose-during-transition is safe (no throw, no stale run)", () => {
    const m = createMedia({ ssrDefault: false });
    const sig = m.containerStyle({}, "--theme", "dark");
    let runs = 0;
    const stop = effect(() => { runs += 1; sig(); });
    stop();            // teardown order: observer gone first
    dispose(sig);      // then the signal
    const runsAfterTeardown = runs;
    // A late verdict arriving after teardown (the transitionrun-after-dispose
    // window) must not throw and must not resurrect a downstream run.
    m._flip(sig, true);
    m._flip(sig, false);
    if (runs !== runsAfterTeardown) {
        throw new Error("a post-dispose style flip ran a downstream effect");
    }
    return "post-dispose flips: no throw, 0 stale runs";
});

gate("style path control: a RETAINING flip IS caught by the 0-B gate", () => {
    // Proves the gate can fail. maxBytesPerCall:0 measures RETAINED bytes (heap
    // delta after GC), so a transient object would be collected and measure 0 --
    // the control must retain. This variant grows a held array per call, so heap
    // delta per call is > 0 and assertAllocs must throw. If it does NOT throw,
    // the gate is blind.
    const m = createMedia({ ssrDefault: false });
    const sig = m.containerStyle({}, "--theme", "dark");
    const stop = effect(() => { sig(); });
    const held = [];
    let v = false;
    const retaining = () => { v = !v; m._flip(sig, v); held.push(new Array(32).fill(v)); };
    let caught = false;
    try {
        assertAllocs(retaining, { maxBytesPerCall: 0 }, { iterations: 2000, batches: 8 });
    } catch (e) {
        if (e instanceof GcInconclusiveError) throw e; // let the runner WARN
        caught = true;
    }
    stop();
    dispose(sig);
    held.length = 0;
    if (!caught) throw new Error("retaining control was NOT caught by the 0-B gate");
    return "retaining flip correctly tripped maxBytesPerCall:0";
});

// TIER 9 -- multi-root (v1.4.0): interleaved dispose retention across roots. -----
// lite-leak owner attribution across the document + several shadow roots: each
// sentinel is tracked to its watcher; a watcher whose dispose ran must have
// untracked its sentinel. The control forgets the untrack and leaks. (The
// tracker's cleanup closure never closes over the sentinel -- the held-value
// contract.)
function multiRootChurn(forgetUntrack, cycles) {
    const tracker = createLeakTracker({
        name: "lite-media-multiroot",
        onLeak: () => {},
    });
    installMockDom();
    try {
        const engine = __browserEngineForTests();
        const doc = globalThis.document;
        const roots = [doc];
        for (let i = 0; i < 4; i += 1) roots.push(makeMockShadowRoot(doc));
        const wnd = [];
        for (let c = 0; c < cycles; c += 1) {
            const root = roots[c % roots.length];
            const host = makeMockElement(root, doc);
            const rec = engine.watch(host, "(min-width: " + (100 + (c % 5) * 100) + "px)", NOOP_CB);
            const sentinel = host.children[0];
            const handle = tracker.track(sentinel, NOOP_CLEAN);
            const d = () => { rec.dispose(); if (!forgetUntrack) tracker.untrack(handle); };
            wnd.push(d);
            if (wnd.length >= 8) wnd.shift()();
        }
        while (wnd.length > 0) wnd.shift()();
        return { liveAfter: tracker.size(), cycles: cycles };
    } finally {
        restoreMockDom();
    }
}
function NOOP_CB() {}
function NOOP_CLEAN() {}

gate("multi-root churn (4096): clean dispose releases every sentinel across roots", () => {
    const N = 4096;
    const r = multiRootChurn(false, N);
    committed["multiroot.liveAfter"] = r.liveAfter;
    if (r.liveAfter !== 0) {
        throw new Error("after disposing all watchers, " + r.liveAfter + " sentinels still tracked");
    }
    return N + " interleaved watchers across 5 roots -> 0 after dispose";
});

gate("multi-root churn control: a dispose that forgets untrack IS caught", () => {
    const N = 512;
    const r = multiRootChurn(true, N);
    if (r.liveAfter !== N) {
        throw new Error("control did not surface the leak: liveAfter=" + r.liveAfter);
    }
    return "control leaks " + r.liveAfter + " as expected (gate is load-bearing)";
});

// TIER 10 -- single-property invariant under multi-root. ------------------------
// --lm-v is registered exactly ONCE per engine no matter how many roots. Control:
// N engines register N times, proving the single-engine case genuinely deduped.
gate("multi-root: exactly one --lm-v registration across N roots (+ control)", () => {
    const N = 32;
    installMockDom();
    let oneEngine = -1;
    let nEngines = -1;
    try {
        const engine = __browserEngineForTests();
        const doc = globalThis.document;
        for (let i = 0; i < N; i += 1) {
            const shadow = makeMockShadowRoot(doc);
            const host = makeMockElement(shadow, doc);
            engine.watch(host, "(min-width: 400px)", NOOP_CB);
        }
        oneEngine = mockRegisterCalls;
        // Control: a separate engine per root registers once each -> N total.
        mockRegisterCalls = 0;
        for (let i = 0; i < N; i += 1) {
            const e = __browserEngineForTests();
            const shadow = makeMockShadowRoot(doc);
            const host = makeMockElement(shadow, doc);
            e.watch(host, "(min-width: 400px)", NOOP_CB);
        }
        nEngines = mockRegisterCalls;
    } finally {
        restoreMockDom();
    }
    committed["multiroot.registerOneEngine"] = oneEngine;
    committed["multiroot.registerNEngines"] = nEngines;
    if (oneEngine !== 1) throw new Error("expected 1 --lm-v registration for N roots, got " + oneEngine);
    if (nEngines !== N) throw new Error("control: expected " + N + " registrations, got " + nEngines);
    return "one engine=" + oneEngine + " across " + N + " roots, control=" + nEngines;
});

// TIER 11 -- 0 B/flip preserved inside a shadow root (via _flip seam). ----------
// A container signal materialized on a shadow-root element (real browser engine,
// mock DOM) must still flip at 0 B -- the multi-root cold setup does not taint the
// steady-state verdict push, which is the same sig.set as the document path.
gate("shadow root: 0 B per verdict flip via _flip seam (maxBytesPerCall:0)", () => {
    installMockDom();
    try {
        const m = createMedia(); // browser engine, auto-detected from mock globals
        const doc = globalThis.document;
        const shadow = makeMockShadowRoot(doc);
        const host = makeMockElement(shadow, doc);
        const sig = m.containerMedia(host, "(min-width: 400px)");
        let sink = false;
        const stop = effect(() => { sink = sig(); });
        let v = false;
        const one = () => { v = !v; m._flip(sig, v); };
        const r = measureAllocs(one, { iterations: 2000, batches: 8 });
        committed["shadow.bytesPerFlip"] = r.bytesPerCall;
        assertAllocs(one, { maxBytesPerCall: 0 }, { iterations: 2000, batches: 8 });
        stop();
        dispose(sig);
        if (sink !== v) throw new Error("effect did not observe the last flip");
        return "bytesPerCall=" + r.bytesPerCall;
    } finally {
        restoreMockDom();
    }
});

gate("shadow root control: a RETAINING flip IS caught by the 0-B gate", () => {
    installMockDom();
    try {
        const m = createMedia();
        const doc = globalThis.document;
        const shadow = makeMockShadowRoot(doc);
        const host = makeMockElement(shadow, doc);
        const sig = m.containerMedia(host, "(min-width: 400px)");
        const stop = effect(() => { sig(); });
        const held = [];
        let v = false;
        const retaining = () => { v = !v; m._flip(sig, v); held.push(new Array(32).fill(v)); };
        let caught = false;
        try {
            assertAllocs(retaining, { maxBytesPerCall: 0 }, { iterations: 2000, batches: 8 });
        } catch (e) {
            if (e instanceof GcInconclusiveError) throw e; // let the runner WARN
            caught = true;
        }
        stop();
        dispose(sig);
        held.length = 0;
        if (!caught) throw new Error("retaining control was NOT caught by the 0-B gate");
        return "retaining flip correctly tripped maxBytesPerCall:0";
    } finally {
        restoreMockDom();
    }
});

// TIER 12 -- cold per-root setup is bounded / one-time. ------------------------
// A known (root, query) re-watch must not build a new sheet or re-insert a rule:
// per-root construction and insertRule are cold, first-seen-only work.
gate("multi-root cold setup: 1000 re-watches of a known (root,query) grow nothing", () => {
    installMockDom();
    try {
        const engine = __browserEngineForTests();
        const doc = globalThis.document;
        const shadow = makeMockShadowRoot(doc);
        engine.watch(makeMockElement(shadow, doc), "(min-width: 400px)", NOOP_CB);
        const sheet = shadow.adoptedStyleSheets[0];
        const sheets0 = mockConstructions; // 1 (only this root)
        const rules0 = sheet.rules.length;  // 2 (base + one @container)
        for (let i = 0; i < 1000; i += 1) {
            engine.watch(makeMockElement(shadow, doc), "(min-width: 400px)", NOOP_CB);
        }
        committed["multiroot.coldSheets"] = sheets0;
        committed["multiroot.coldRules"] = rules0;
        if (mockConstructions !== sheets0) {
            throw new Error("re-watch built a new sheet: " + sheets0 + " -> " + mockConstructions);
        }
        if (sheet.rules.length !== rules0) {
            throw new Error("re-watch inserted a rule: " + rules0 + " -> " + sheet.rules.length);
        }
        return "sheets stable at " + sheets0 + ", rules stable at " + rules0 + " across 1000 re-watches";
    } finally {
        restoreMockDom();
    }
});

gate("multi-root cold setup control: fresh roots + a new query DO grow the counters", () => {
    // Proves the gate above is load-bearing. The per-root memo is what keeps the
    // counters flat; bypass it two ways and both counters must move:
    //   (a) N fresh roots build N new sheets (coldSheets grows), and
    //   (b) a NEW query on a known root inserts a new rule (coldRules grows).
    installMockDom();
    try {
        const engine = __browserEngineForTests();
        const doc = globalThis.document;
        const known = makeMockShadowRoot(doc);
        engine.watch(makeMockElement(known, doc), "(min-width: 400px)", NOOP_CB);
        const sheets0 = mockConstructions;                           // 1
        const rules0 = known.adoptedStyleSheets[0].rules.length;     // 2 (base + one)

        // (a) fresh roots -> new sheet each time.
        const N = 8;
        for (let i = 0; i < N; i += 1) {
            const fresh = makeMockShadowRoot(doc);
            engine.watch(makeMockElement(fresh, doc), "(min-width: 400px)", NOOP_CB);
        }
        const grewSheets = mockConstructions - sheets0;

        // (b) a new query on the KNOWN root -> new rule in its sheet.
        engine.watch(makeMockElement(known, doc), "(min-width: 900px)", NOOP_CB);
        const grewRules = known.adoptedStyleSheets[0].rules.length - rules0;

        committed["multiroot.coldSheetsFreshRoots"] = grewSheets;
        committed["multiroot.coldRulesNewQuery"] = grewRules;
        if (grewSheets !== N) {
            throw new Error("control expected +" + N + " sheets for N fresh roots, got +" + grewSheets);
        }
        if (grewRules !== 1) {
            throw new Error("control expected +1 rule for a new query, got +" + grewRules);
        }
        // Both growths would violate the main gate's flatness invariants
        // (constructions === 1, rules === 2) -- that is exactly the point.
        return "fresh roots grew sheets by " + grewSheets
            + ", a new query grew rules by " + grewRules + " (flatness is load-bearing)";
    } finally {
        restoreMockDom();
    }
});

// TIER 13 -- bfcache resync (v1.4.1): a persisted pageshow re-pins every answer.
// The resync path re-reads each watched mql (Engine A) / live sentinel verdict
// (Engine B) and re-pushes it through the SAME sig.set a real event uses. Its
// central claim: an UNCHANGED restore is a pure dedup -- 0 B retained, 0 major GC,
// 0 downstream runs -- while a verdict that moved while the page was frozen
// propagates exactly once. Plus the live-set MUST empty on dispose (retention).
gate("bfcache: 0 B retained per unchanged restore + 0 major GC (16 sigs, maxBytesPerCall:0)", () => {
    const { mm, flip } = makeMatchMedia();
    const m = createMedia({ matchMedia: mm });
    const M = 16;
    const sigs = [];
    const stops = [];
    let sink = 0;
    for (let i = 0; i < M; i += 1) {
        const q = "(min-width: " + (100 + i) + "px)";
        flip(q, (i & 1) === 0); // a fixed, stable verdict per signal
        const s = m.media(q);
        sigs.push(s);
        stops.push(effect(() => { sink += s() ? 1 : 0; }));
    }
    // Unchanged state: every sig.set re-pushes the SAME value -> Object.is dedup.
    const one = () => { m._resync(); };
    const r = measureAllocs(one, { iterations: 2000, batches: 8 });
    committed["bfcache.bytesPerRestore"] = r.bytesPerCall;
    assertAllocs(one, { maxBytesPerCall: 0 }, { iterations: 2000, batches: 8 });

    // Separate maxMajor:0 proof over a resync storm (profiler window, as TIER 3).
    const prof = new GcProfiler();
    prof.start();
    for (let t = 0; t < 20000; t += 1) m._resync();
    prof.forceSettle();
    const summary = prof.summary();
    prof.stop();
    committed["bfcache.majors"] = summary.gc ? summary.gc.major : null;
    const res = checkNoGc(summary, { maxMajor: 0 });
    for (const st of stops) st();
    for (const s of sigs) dispose(s);
    if (res.verdict === "fail") {
        throw new Error("major GC during unchanged resync storm: " + JSON.stringify(res.violations));
    }
    void sink;
    return "bytesPerCall=" + r.bytesPerCall + " majors=" + (summary.gc ? summary.gc.major : "?");
});

gate("bfcache control (mutating): a verdict that moved while frozen propagates on resync", () => {
    // The functional control for the 0-run claim above: a value that changed
    // WITHOUT a change event (setSilent) must be picked up by resync and fire
    // exactly one downstream run. Distinct from the alloc gate.
    const { mm, flip, setSilent } = makeMatchMedia();
    const m = createMedia({ matchMedia: mm });
    const q = "(min-width: 500px)";
    flip(q, false);
    const sig = m.media(q);
    let runs = 0;
    let sink = false;
    const stop = effect(() => { runs += 1; sink = sig(); });
    const base = runs; // 1

    // (a) unchanged restore: exactly 0 downstream runs.
    m._resync();
    const afterUnchanged = runs;

    // (b) verdict moved while the page was frozen (no change event delivered).
    setSilent(q, true);
    if (sig.peek() !== false) throw new Error("verdict should still be stale before resync");
    m._resync();
    const afterMutated = runs;

    stop();
    dispose(sig);
    if (afterUnchanged !== base) {
        throw new Error("unchanged restore fired " + (afterUnchanged - base) + " runs (expected 0)");
    }
    if (afterMutated !== base + 1) {
        throw new Error("mutated restore fired " + (afterMutated - base) + " runs (expected 1)");
    }
    if (sink !== true) throw new Error("resync did not propagate the changed verdict");
    return "unchanged=+0 runs, mutated=+1 run, verdict propagated";
});

gate("bfcache control: a RETAINING resync IS caught by the 0-B gate", () => {
    // Proves the 0-B gate above can fail. maxBytesPerCall:0 measures RETAINED
    // bytes (heap delta after GC), so a transient object collects and measures 0
    // -- the control must RETAIN. This grows a held array per restore, so heap
    // delta per call is > 0 and assertAllocs must throw.
    const { mm, flip } = makeMatchMedia();
    const m = createMedia({ matchMedia: mm });
    const q = "(min-width: 400px)";
    flip(q, true);
    const sig = m.media(q);
    const stop = effect(() => { sig(); });
    const held = [];
    const retaining = () => { m._resync(); held.push(new Array(32).fill(0)); };
    let caught = false;
    try {
        assertAllocs(retaining, { maxBytesPerCall: 0 }, { iterations: 2000, batches: 8 });
    } catch (e) {
        if (e instanceof GcInconclusiveError) throw e; // let the runner WARN
        caught = true;
    }
    stop();
    dispose(sig);
    held.length = 0;
    if (!caught) throw new Error("retaining resync was NOT caught by the 0-B gate");
    return "retaining resync correctly tripped maxBytesPerCall:0";
});

// Engine B live-set retention: dispose() MUST delete its record from `live`, or
// the strong-ref Set pins the record -> verdict -> computed style -> sentinel for
// the page lifetime. The LOAD-BEARING guard is engine._liveSize(): read directly,
// no GC-finalization timing, so it trips the INSTANT dispose() forgets its
// live.delete (a finalization proxy can miss the mock's closure chain). The
// sentinel-finalization tracker check is kept as a real-browser retention proxy.
await gateAsync("bfcache: Engine B live-set empties after dispose (4096 cycles; _liveSize + tracker)", async () => {
    installMockDom();
    try {
        const engine = __browserEngineForTests();
        const doc = globalThis.document;
        const tracker = createLeakTracker({ name: "lite-media-bfcache-live", onLeak: () => {} });
        for (let c = 0; c < 4096; c += 1) {
            const shadow = makeMockShadowRoot(doc);
            const host = makeMockElement(shadow, doc);
            const rec = engine.watch(host, "(min-width: 400px)", NOOP_CB);
            const sentinel = host.children[0];
            tracker.track(sentinel, NOOP_CLEAN); // held-value contract: captures nothing
            engine.resync();                     // exercise the resync path each cycle
            rec.dispose();                       // MUST live.delete(rec) -> live.size back to 0
        }
        // (1) Load-bearing, deterministic: the live Set itself is empty. Fails the
        //     instant live.delete(rec) is removed from dispose().
        const liveSize = engine._liveSize();
        committed["bfcache.liveSetSize"] = liveSize;
        if (liveSize !== 0) {
            throw new Error("Engine B live-set still holds " + liveSize + " records after dispose");
        }
        // (2) Real-browser retention proxy: the tracked sentinels finalized too.
        globalThis.gc();
        await new Promise((r) => setTimeout(r, 50));
        const live = tracker.size();
        committed["bfcache.liveSetAfter"] = live;
        if (live !== 0) {
            throw new Error("Engine B live-set pinned " + live + " sentinels after dispose");
        }
        return "4096 watch/resync/dispose cycles -> live-set size 0 + tracker 0";
    } finally {
        restoreMockDom();
    }
});

gate("bfcache live-set control: undisposed records keep _liveSize non-zero (trips the gate)", () => {
    // Proves assertion (1) above is load-bearing. Skip dispose() on a batch of
    // watchers: with live.delete never reached, engine._liveSize() stays at N, so
    // the size assertion the gate above uses would throw. This is the exact
    // regression removing Media.js live.delete(rec) would cause.
    installMockDom();
    try {
        const engine = __browserEngineForTests();
        const doc = globalThis.document;
        const N = 512;
        for (let c = 0; c < N; c += 1) {
            const shadow = makeMockShadowRoot(doc);
            const host = makeMockElement(shadow, doc);
            engine.watch(host, "(min-width: 400px)", NOOP_CB); // deliberately NOT disposed
        }
        const liveSize = engine._liveSize();
        committed["bfcache.liveSetSizeUndisposed"] = liveSize;
        // Re-apply the gate's own load-bearing assertion; it MUST fail here.
        let tripped = false;
        try {
            if (liveSize !== 0) throw new Error("live-set still holds " + liveSize + " records");
        } catch (_e) {
            tripped = true;
        }
        if (!tripped || liveSize !== N) {
            throw new Error("control did not trip the size gate: liveSize=" + liveSize + " (expected " + N + ")");
        }
        return "undisposed batch leaves _liveSize=" + liveSize + " (size gate is load-bearing)";
    } finally {
        restoreMockDom();
    }
});

// TIER 6 -- registry fail-closed: distinct queries hit a CLOSED ceiling. --------
// The per-instance media() cache grows one signal per distinct query. It is not
// silently unbounded: the lite-signal node budget is the ceiling, and past it
// signal() throws CapacityError -- a fail-closed error, never corruption. Run
// last (it exhausts the shared node pool by design).
gate("registry fail-closed: unbounded distinct queries throw CapacityError, never corrupt", () => {
    const m = createMedia({ ssrDefault: false });
    let count = 0;
    let threw = null;
    try {
        for (let i = 0; i < 20000; i += 1) { m.media("(w:" + i + ")"); count += 1; }
    } catch (e) {
        threw = e;
    }
    committed["registry.entriesBeforeCeiling"] = count;
    if (threw === null) {
        // Node pool grew instead of capping: also acceptable (still bounded by
        // memory, still one-per-query). Report it rather than assume a ceiling.
        return "no ceiling hit in " + count + " distinct queries (node pool grew)";
    }
    if (threw.name !== "CapacityError") {
        throw new Error("expected fail-closed CapacityError, got " + threw.name + ": " + threw.message);
    }
    return "fail-closed at " + count + " distinct queries (" + threw.name + ")";
});

// --- summary ---------------------------------------------------------------
console.log("\ncommitted numbers:");
for (const k of Object.keys(committed)) {
    console.log("  " + k + " = " + committed[k]);
}
console.log("");
if (failures > 0) {
    console.log("TORTURE: " + failures + " FAILURE(S)" + (warns ? ", " + warns + " warning(s)" : ""));
    process.exit(1);
}
console.log("TORTURE: all gates passed" + (warns ? " (" + warns + " inconclusive warning(s))" : ""));
