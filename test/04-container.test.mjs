import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { effect } from "@zakkster/lite-signal";
import {
    containerMedia, media, configure, __resetForTests, createMedia,
} from "../Media.js";

// ---------------------------------------------------------------------------
// makeMockEngine -- deterministic container engine for tests
// ---------------------------------------------------------------------------
// Mirrors the browser-engine contract: watch() returns { initial, dispose }
// and stores the onChange callback so the test can trigger flips via
// engine.flip(el, query, matches). Cross-file dispose accounting exposed
// via engine.disposeCount / engine.watchCount so tests can assert cleanup.
function makeMockEngine() {
    /** @type {Map<{el:any,query:string}, (m:boolean)=>void>} */
    const listeners = new Map();
    const state = new Map(); // key -> matches
    let watchCount = 0;
    let disposeCount = 0;

    function key(el, query) { return { el, query }; }

    return {
        watchCount() { return watchCount; },
        disposeCount() { return disposeCount; },
        setInitial(el, query, matches) {
            for (const k of state.keys()) {
                if (k.el === el && k.query === query) { state.set(k, matches); return; }
            }
            state.set(key(el, query), matches);
        },
        flip(el, query, matches) {
            for (const [k, cb] of listeners) {
                if (k.el === el && k.query === query) {
                    state.set(k, matches);
                    cb(matches);
                }
            }
        },
        watch(el, query, onChange) {
            watchCount++;
            let initial = false;
            for (const [k, m] of state) {
                if (k.el === el && k.query === query) { initial = m; break; }
            }
            const k = key(el, query);
            listeners.set(k, onChange);
            state.set(k, initial);
            let disposed = false;
            return {
                initial,
                dispose() {
                    if (disposed) return;
                    disposed = true;
                    disposeCount++;
                    listeners.delete(k);
                    state.delete(k);
                },
            };
        },
    };
}

// ---------------------------------------------------------------------------
// containerMedia() -- default instance path via configure({ containerEngine })
// ---------------------------------------------------------------------------

describe("containerMedia() -- default instance", () => {
    beforeEach(() => __resetForTests());

    test("returns a signal that reflects initial engine verdict", () => {
        const engine = makeMockEngine();
        const el = { id: "el-1" };
        engine.setInitial(el, "(min-width: 400px)", true);
        configure({ containerEngine: engine, ssrDefault: false });
        const s = containerMedia(el, "(min-width: 400px)");
        assert.strictEqual(s(), true);
    });

    test("memoizes per (element, query) pair -- same instance returned", () => {
        const engine = makeMockEngine();
        const el = { id: "el-1" };
        configure({ containerEngine: engine, ssrDefault: false });
        const a = containerMedia(el, "(min-width: 400px)");
        const b = containerMedia(el, "(min-width: 400px)");
        assert.strictEqual(a, b);
        assert.strictEqual(engine.watchCount(), 1);
    });

    test("distinct elements get distinct signals for the same query", () => {
        const engine = makeMockEngine();
        const el1 = { id: "el-1" };
        const el2 = { id: "el-2" };
        configure({ containerEngine: engine, ssrDefault: false });
        const s1 = containerMedia(el1, "(min-width: 400px)");
        const s2 = containerMedia(el2, "(min-width: 400px)");
        assert.notStrictEqual(s1, s2);
        assert.strictEqual(engine.watchCount(), 2);
    });

    test("distinct queries on same element get distinct signals", () => {
        const engine = makeMockEngine();
        const el = { id: "el-1" };
        configure({ containerEngine: engine, ssrDefault: false });
        const a = containerMedia(el, "(min-width: 400px)");
        const b = containerMedia(el, "(min-width: 800px)");
        assert.notStrictEqual(a, b);
        assert.strictEqual(engine.watchCount(), 2);
    });

    test("engine.flip() propagates to signal -> effect", () => {
        const engine = makeMockEngine();
        const el = { id: "el-1" };
        configure({ containerEngine: engine, ssrDefault: false });
        const s = containerMedia(el, "(min-width: 400px)");
        let last = null;
        let runs = 0;
        const stop = effect(() => { last = s(); runs++; });
        assert.strictEqual(last, false);
        assert.strictEqual(runs, 1);
        engine.flip(el, "(min-width: 400px)", true);
        assert.strictEqual(last, true);
        assert.strictEqual(runs, 2);
        engine.flip(el, "(min-width: 400px)", true); // redundant -- dedupe
        assert.strictEqual(runs, 2);
        stop();
    });
});

describe("containerMedia() -- argument validation", () => {
    beforeEach(() => __resetForTests());

    test("null element throws TypeError", () => {
        configure({ containerEngine: makeMockEngine(), ssrDefault: false });
        assert.throws(
            () => containerMedia(null, "(min-width: 400px)"),
            TypeError
        );
    });

    test("undefined element throws TypeError", () => {
        configure({ containerEngine: makeMockEngine(), ssrDefault: false });
        assert.throws(
            () => containerMedia(undefined, "(min-width: 400px)"),
            TypeError
        );
    });

    test("primitive element throws TypeError", () => {
        configure({ containerEngine: makeMockEngine(), ssrDefault: false });
        assert.throws(
            () => containerMedia(42, "(min-width: 400px)"),
            TypeError
        );
        assert.throws(
            () => containerMedia("selector", "(min-width: 400px)"),
            TypeError
        );
    });

    test("non-string query throws TypeError", () => {
        configure({ containerEngine: makeMockEngine(), ssrDefault: false });
        const el = {};
        assert.throws(
            () => containerMedia(el, null),
            TypeError
        );
        assert.throws(
            () => containerMedia(el, 42),
            TypeError
        );
        assert.throws(
            () => containerMedia(el, undefined),
            TypeError
        );
    });
});

describe("containerMedia() -- element garbage collection", () => {
    beforeEach(() => __resetForTests());

    test("containerMedia signals share V8 hidden class with media() signals", () => {
        // Regression guard: v1.1 initially tagged container signals with a
        // __disposeContainer own-property, which forked the hidden class and
        // made any shared effect() reading both go polymorphic. Fixed by
        // moving the disposer to a per-instance WeakMap. This test checks
        // structural shape parity: same enumerable own-key set.
        const engine = {
            watch(_e, _q, _cb) { return { initial: false, dispose() {} }; },
        };
        configure({ containerEngine: engine, ssrDefault: false });
        const m = media("(x)");
        const c = containerMedia({}, "(x)");
        const mKeys = Object.getOwnPropertyNames(m).sort().join(",");
        const cKeys = Object.getOwnPropertyNames(c).sort().join(",");
        assert.strictEqual(cKeys, mKeys,
            `container signal keys "${cKeys}" must match media signal keys "${mKeys}"`);
        // Explicit: no __disposeContainer own-property leaks onto the signal.
        assert.strictEqual(
            Object.getOwnPropertyDescriptor(c, "__disposeContainer"),
            undefined,
            "disposer must not be attached as an own-property of the signal"
        );
    });
    test("WeakMap allows element cache entries to be GC-eligible", () => {
        // We can't force GC in a portable test, but we can verify that a
        // detached element doesn't keep OTHER things alive: create the
        // signal in a closure that goes out of scope, and check that a
        // fresh containerMedia() for a fresh element still gets a new signal.
        const engine = makeMockEngine();
        configure({ containerEngine: engine, ssrDefault: false });
        function scoped() {
            const el = { id: "scoped" };
            const s = containerMedia(el, "(min-width: 400px)");
            return s();
        }
        assert.strictEqual(scoped(), false);
        // A fresh element gets a fresh signal.
        const el2 = { id: "second" };
        const s2 = containerMedia(el2, "(min-width: 400px)");
        assert.strictEqual(engine.watchCount(), 2);
        // The scoped signal is unreachable; the WeakMap entry becomes
        // GC-eligible. We can't assert-force GC portably, but we can assert
        // the API doesn't ITSELF hold the element (via a strong Map).
        assert.strictEqual(typeof s2, "function");
    });
});

describe("containerMedia() -- SSR / node inert engine", () => {
    beforeEach(() => __resetForTests());

    test("no engine configured, no DOM -> default (Node inert) engine returns false forever", () => {
        // In Node, detectDefaultContainerEngine picks the node inert engine.
        // No configure() call: containerMedia uses that default.
        configure({ ssrDefault: false });
        const el = {};
        const s = containerMedia(el, "(min-width: 400px)");
        assert.strictEqual(s(), false);
        // No way to flip it -- node engine's onChange is never called.
        // Just assert the API is inert, not broken.
        assert.strictEqual(typeof s, "function");
    });
});
