import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { effect } from "@zakkster/lite-signal";
import {
    containerStyle, containerMedia, configure, __resetForTests, createMedia,
} from "../Media.js";

// ---------------------------------------------------------------------------
// containerStyle(el, prop, value) — Engine B's style()-query class (v1.3.0)
// ---------------------------------------------------------------------------
// containerStyle CONSTRUCTS the canonical condition `style(<prop>: <value>)`
// and routes it through containerMedia — so it inherits the same engine,
// memoization, disposer and _flip seam. These tests drive the exact production
// delegation via a mock container engine keyed by (el, query): if the engine
// sees `style(--theme: dark)`, the construction is byte-correct.

function makeMockEngine() {
    /** @type {Map<{el:any,query:string}, (m:boolean)=>void>} */
    const listeners = new Map();
    const state = new Map(); // key -> matches
    let watchCount = 0;
    let disposeCount = 0;
    const seenQueries = [];

    function key(el, query) { return { el, query }; }

    return {
        watchCount() { return watchCount; },
        disposeCount() { return disposeCount; },
        seenQueries() { return seenQueries.slice(); },
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
            seenQueries.push(query);
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
// Construction & delegation
// ---------------------------------------------------------------------------

describe("containerStyle() — canonical construction & delegation", () => {
    beforeEach(() => __resetForTests());

    test("constructs the exact condition 'style(<prop>: <value>)'", () => {
        const engine = makeMockEngine();
        const el = { id: "el-1" };
        engine.setInitial(el, "style(--theme: dark)", true);
        configure({ containerEngine: engine, ssrDefault: false });
        const s = containerStyle(el, "--theme", "dark");
        assert.strictEqual(s(), true);
        assert.deepEqual(engine.seenQueries(), ["style(--theme: dark)"]);
    });

    test("initial verdict false when the engine reports no match", () => {
        const engine = makeMockEngine();
        const el = { id: "el-1" };
        configure({ containerEngine: engine, ssrDefault: false });
        const s = containerStyle(el, "--density", "compact");
        assert.strictEqual(s(), false);
    });

    test("works with a registered-property name and a plain value", () => {
        const engine = makeMockEngine();
        const el = { id: "el-1" };
        engine.setInitial(el, "style(--variant: hero)", true);
        configure({ containerEngine: engine, ssrDefault: false });
        assert.strictEqual(containerStyle(el, "--variant", "hero")(), true);
    });
});

// ---------------------------------------------------------------------------
// Memoization — shares the containerMedia cache
// ---------------------------------------------------------------------------

describe("containerStyle() — memoization", () => {
    beforeEach(() => __resetForTests());

    test("same (el, prop, value) returns the same signal, one watch", () => {
        const engine = makeMockEngine();
        const el = { id: "el-1" };
        configure({ containerEngine: engine, ssrDefault: false });
        const a = containerStyle(el, "--theme", "dark");
        const b = containerStyle(el, "--theme", "dark");
        assert.strictEqual(a, b);
        assert.strictEqual(engine.watchCount(), 1);
    });

    test("shares the cache with an equivalent raw containerMedia() string", () => {
        const engine = makeMockEngine();
        const el = { id: "el-1" };
        configure({ containerEngine: engine, ssrDefault: false });
        const viaStyle = containerStyle(el, "--theme", "dark");
        const viaRaw = containerMedia(el, "style(--theme: dark)");
        assert.strictEqual(viaStyle, viaRaw); // identical canonical key
        assert.strictEqual(engine.watchCount(), 1);
    });

    test("distinct value gets a distinct signal", () => {
        const engine = makeMockEngine();
        const el = { id: "el-1" };
        configure({ containerEngine: engine, ssrDefault: false });
        const dark = containerStyle(el, "--theme", "dark");
        const light = containerStyle(el, "--theme", "light");
        assert.notStrictEqual(dark, light);
        assert.strictEqual(engine.watchCount(), 2);
    });

    test("distinct property gets a distinct signal", () => {
        const engine = makeMockEngine();
        const el = { id: "el-1" };
        configure({ containerEngine: engine, ssrDefault: false });
        const a = containerStyle(el, "--theme", "dark");
        const b = containerStyle(el, "--mode", "dark");
        assert.notStrictEqual(a, b);
    });

    test("distinct elements get distinct signals for the same query", () => {
        const engine = makeMockEngine();
        const el1 = { id: "el-1" };
        const el2 = { id: "el-2" };
        configure({ containerEngine: engine, ssrDefault: false });
        const s1 = containerStyle(el1, "--theme", "dark");
        const s2 = containerStyle(el2, "--theme", "dark");
        assert.notStrictEqual(s1, s2);
        assert.strictEqual(engine.watchCount(), 2);
    });
});

// ---------------------------------------------------------------------------
// Reactivity
// ---------------------------------------------------------------------------

describe("containerStyle() — reactivity", () => {
    beforeEach(() => __resetForTests());

    test("engine.flip() propagates to signal -> effect", () => {
        const engine = makeMockEngine();
        const el = { id: "el-1" };
        configure({ containerEngine: engine, ssrDefault: false });
        const s = containerStyle(el, "--theme", "dark");
        let last = null;
        let runs = 0;
        const stop = effect(() => { last = s(); runs++; });
        assert.strictEqual(last, false);
        assert.strictEqual(runs, 1);
        engine.flip(el, "style(--theme: dark)", true);
        assert.strictEqual(last, true);
        assert.strictEqual(runs, 2);
        stop();
    });

    test("a duplicate flip to the same value is a no-op (one effect run)", () => {
        const engine = makeMockEngine();
        const el = { id: "el-1" };
        configure({ containerEngine: engine, ssrDefault: false });
        const s = containerStyle(el, "--theme", "dark");
        let runs = 0;
        const stop = effect(() => { s(); runs++; });
        assert.strictEqual(runs, 1);
        engine.flip(el, "style(--theme: dark)", true);
        assert.strictEqual(runs, 2);
        engine.flip(el, "style(--theme: dark)", true); // equal value -> no push
        assert.strictEqual(runs, 2);
        stop();
    });
});

// ---------------------------------------------------------------------------
// Validation — fail closed
// ---------------------------------------------------------------------------

describe("containerStyle() — validation", () => {
    beforeEach(() => __resetForTests());

    function withEngine() {
        configure({ containerEngine: makeMockEngine(), ssrDefault: false });
    }

    test("throws TypeError on a null / primitive element", () => {
        withEngine();
        assert.throws(() => containerStyle(null, "--theme", "dark"), /Element as first arg/);
        assert.throws(() => containerStyle(42, "--theme", "dark"), /Element as first arg/);
        assert.throws(() => containerStyle("el", "--theme", "dark"), /Element as first arg/);
    });

    test("throws TypeError on a non-string or empty property", () => {
        withEngine();
        const el = { id: "el-1" };
        assert.throws(() => containerStyle(el, "", "dark"), /non-empty/);
        assert.throws(() => containerStyle(el, 123, "dark"), /non-empty/);
        assert.throws(() => containerStyle(el, null, "dark"), /non-empty/);
    });

    test("throws TypeError on a non-string value", () => {
        withEngine();
        const el = { id: "el-1" };
        assert.throws(() => containerStyle(el, "--theme", 1), /string value/);
        assert.throws(() => containerStyle(el, "--theme", null), /string value/);
        assert.throws(() => containerStyle(el, "--theme", undefined), /string value/);
    });

    test("a throwing call caches nothing (no partial state)", () => {
        const engine = makeMockEngine();
        const el = { id: "el-1" };
        configure({ containerEngine: engine, ssrDefault: false });
        assert.throws(() => containerStyle(el, "--theme", 1));
        assert.strictEqual(engine.watchCount(), 0); // never reached the engine
    });
});

// ---------------------------------------------------------------------------
// LM-04 — the footgun warning must stay silent for style() queries
// ---------------------------------------------------------------------------
// style() queries resolve against any ancestor and need no container-type, so
// warning would be a false positive. A size query on the same element still
// warns (the control that proves the harness is live).

function elem(ct, parent) {
    return { __ct: ct, parentElement: parent === undefined ? null : parent };
}
function inertEngine() {
    return { watch() { return { initial: false, dispose() {} }; } };
}

describe("LM-04 — no container-type warning for style() queries", () => {
    let savedGCS, savedWarn, savedEnv, warnings;

    beforeEach(() => {
        savedGCS = globalThis.getComputedStyle;
        savedWarn = console.warn;
        savedEnv = process.env.NODE_ENV;
        warnings = [];
        console.warn = (...args) => { warnings.push(args); };
        delete process.env.NODE_ENV; // dev, not production
        globalThis.getComputedStyle = (node) => ({
            getPropertyValue(prop) {
                if (prop !== "container-type") return "";
                return (node && typeof node.__ct === "string") ? node.__ct : "normal";
            },
        });
    });

    afterEach(() => {
        globalThis.getComputedStyle = savedGCS;
        console.warn = savedWarn;
        if (savedEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = savedEnv;
    });

    test("containerStyle() on a container-type:normal element does NOT warn", () => {
        const m = createMedia({ containerEngine: inertEngine() });
        m.containerStyle(elem("normal"), "--theme", "dark");
        assert.equal(warnings.length, 0);
    });

    test("a raw style() string via containerMedia() also does NOT warn", () => {
        const m = createMedia({ containerEngine: inertEngine() });
        m.containerMedia(elem("normal"), "style(--theme: dark)");
        assert.equal(warnings.length, 0);
    });

    test("CONTROL: a size query on the same element DOES warn", () => {
        const m = createMedia({ containerEngine: inertEngine() });
        m.containerMedia(elem("normal"), "(min-width: 400px)");
        assert.equal(warnings.length, 1);
        assert.match(warnings[0][0], /container-type is 'normal'/);
    });

    test("leading/trailing space before style( is still recognized", () => {
        const m = createMedia({ containerEngine: inertEngine() });
        m.containerMedia(elem("normal"), "  style(--theme: dark)  ");
        assert.equal(warnings.length, 0);
    });
});

// ---------------------------------------------------------------------------
// SSR / off-DOM — inherits the containerMedia contract
// ---------------------------------------------------------------------------

describe("containerStyle() — SSR / off-DOM", () => {
    beforeEach(() => __resetForTests());

    test("off-DOM (Node engine) returns a stable false signal, never throws", () => {
        // No containerEngine + no DOM -> detectDefaultContainerEngine picks the
        // inert Node engine. No matchMedia needed: this is the container path.
        const m = createMedia({});
        const el = { id: "el-1" };
        const s = m.containerStyle(el, "--theme", "dark");
        assert.strictEqual(s(), false);
        assert.strictEqual(m.containerStyle(el, "--theme", "dark"), s); // memoized
    });
});

// ---------------------------------------------------------------------------
// Surfaces — scoped instance and module-level export both exist
// ---------------------------------------------------------------------------

describe("containerStyle() — surfaces", () => {
    beforeEach(() => __resetForTests());

    test("scoped createMedia() exposes containerStyle", () => {
        const engine = makeMockEngine();
        const el = { id: "el-1" };
        engine.setInitial(el, "style(--theme: dark)", true);
        const m = createMedia({ containerEngine: engine, ssrDefault: false });
        assert.strictEqual(typeof m.containerStyle, "function");
        assert.strictEqual(m.containerStyle(el, "--theme", "dark")(), true);
    });

    test("module-level containerStyle locks the default instance", () => {
        const engine = makeMockEngine();
        const el = { id: "el-1" };
        configure({ containerEngine: engine, ssrDefault: false });
        containerStyle(el, "--theme", "dark");
        // After a successful materialization, configure() must throw.
        assert.throws(() => configure({ ssrDefault: true }), /before the first successful/);
    });
});
