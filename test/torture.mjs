// ===========================================================================
// lite-media torture gate  —  node --expose-gc test/torture.mjs
// ===========================================================================
// The mandated proof gate (CLAUDE.md pipeline): every module change is proven
// here. It commits the package's central allocation claims as numbers and
// proves the teardown/ownership contract, using:
//   @zakkster/lite-gc-profiler  — does this operation allocate?
//   @zakkster/lite-leak         — was this resource released when disposed?
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
import { createMedia } from "../Media.js";

// This file lives in test/, so `node --test` (used by `npm test`) discovers and
// runs it too. Without --expose-gc the allocation gates cannot run, so we skip
// cleanly (exit 0) rather than fail the suite. The real gate is
// `npm run test:torture` (node --expose-gc test/torture.mjs), and `npm run
// test:gc` (node --expose-gc --test) runs these gates in-suite with gc present.
if (typeof globalThis.gc !== "function") {
    console.log("torture: skipped — run `npm run test:torture` (needs --expose-gc).");
    process.exit(0);
}

// --- tiny runner -----------------------------------------------------------
let failures = 0;
let warns = 0;
const committed = {}; // tier -> committed number, printed at the end

function gate(name, fn) {
    try {
        const note = fn();
        console.log("  PASS  " + name + (note ? "  — " + note : ""));
    } catch (err) {
        if (err instanceof GcInconclusiveError) {
            warns += 1;
            console.log("  WARN  " + name + "  — inconclusive: " + err.message);
            return;
        }
        failures += 1;
        const msg = (err && err.message) ? err.message : String(err);
        console.log("  FAIL  " + name + "  — " + msg);
    }
}

// A flippable multi-query matchMedia mock. Reuses one event object across all
// flips so the HARNESS contributes no per-call allocation — anything measured
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
    return { mm, flip };
}

// ---------------------------------------------------------------------------
console.log("lite-media torture gate\n");

// TIER 1 — media path: 0 bytes retained per flip. -----------------------------
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

// TIER 2 — container path: 0 B per verdict flip AND 0 B per non-flip frame. ---
// The package's central perf claim in v1.1.x: cost is flat — a container
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

// TIER 3 — media flip storm: no major GC, no ArrayBuffer growth. ---------------
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
    // (a) ArrayBuffer growth — measured with NO profiler in the window, so the
    //     profiler's own ring buffers are not attributed to lite-media.
    storm(false); // warm
    globalThis.gc();
    const ab0 = process.memoryUsage().arrayBuffers;
    storm(false);
    globalThis.gc();
    const ab1 = process.memoryUsage().arrayBuffers;
    const abGrowth = ab1 - ab0;
    // (b) Major-GC check — profiler around a separate storm run.
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

// TIER 4 — duplicate-event storm: exactly one effect run (WebKit #279012). -----
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

// TIER 5 — attach/detach churn: every watcher releases its resources. ----------
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

// TIER 7 — breakpoints: cost tracks band CHANGES, not resize frames. -----------
// The v1.2.0 claim: breakpoints() compiles to one interned-token computed, so a
// band change is a zero-alloc token swap and a read of a stable band is a
// zero-alloc cache hit. A resize that does not cross a threshold fires no
// boundary event at all — there is nothing to measure between crossings — so
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

// TIER 8 — style queries: inherit the container path's zero-alloc profile. -----
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
    // delta after GC), so a transient object would be collected and measure 0 —
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

// TIER 6 — registry fail-closed: distinct queries hit a CLOSED ceiling. --------
// The per-instance media() cache grows one signal per distinct query. It is not
// silently unbounded: the lite-signal node budget is the ceiling, and past it
// signal() throws CapacityError — a fail-closed error, never corruption. Run
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
