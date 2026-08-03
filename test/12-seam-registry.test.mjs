import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { effect } from "@zakkster/lite-signal";
import {
    createMedia, containerMedia, media, configure, stats,
    __resetForTests, __flipForTests,
} from "../Media.js";

// ---------------------------------------------------------------------------
// LM-03 -- the __flipForTests / _flip container seam
// ---------------------------------------------------------------------------
// The seam routes a simulated verdict through the exact engine onChange that
// drives the signal, so a test can flip a container verdict on the DEFAULT
// instance (which uses the real node/browser engine, not a mock) without a
// browser. Works with any engine, including the node inert engine, because it
// drives lite-media's own onChange, not the engine's internals.

describe("LM-03 -- __flipForTests seam (default instance)", () => {
    beforeEach(() => __resetForTests());

    test("flips a container signal on the default instance, off-DOM", () => {
        configure({ ssrDefault: false }); // node inert engine
        const el = {};
        const s = containerMedia(el, "(min-width: 400px)");
        assert.equal(s(), false);

        let seen;
        let runs = 0;
        effect(() => { runs += 1; seen = s(); });
        assert.equal(runs, 1);
        assert.equal(seen, false);

        __flipForTests(s, true);
        assert.equal(s(), true);
        assert.equal(seen, true);
        assert.equal(runs, 2);
    });

    test("flip to an equal value is a no-op (sig.set dedup)", () => {
        configure({ ssrDefault: false });
        const s = containerMedia({}, "(min-width: 400px)");
        let runs = 0;
        effect(() => { runs += 1; s(); });
        assert.equal(runs, 1);

        __flipForTests(s, true);
        assert.equal(runs, 2);
        __flipForTests(s, true);  // duplicate verdict
        __flipForTests(s, true);  // duplicate verdict
        assert.equal(runs, 2, "duplicate verdicts must not re-run the effect");

        __flipForTests(s, false);
        assert.equal(runs, 3);
    });

    test("throws on a signal that is not a container signal of the instance", () => {
        configure({ ssrDefault: false });
        const notContainer = media("(min-width: 400px)"); // a media() signal
        assert.throws(() => __flipForTests(notContainer, true), /Unknown signal/);
    });

    test("instance-level _flip works on scoped instances", () => {
        const m = createMedia({ ssrDefault: false });
        const s = m.containerMedia({}, "(min-width: 400px)");
        m._flip(s, true);
        assert.equal(s(), true);
        m._flip(s, false);
        assert.equal(s(), false);
    });
});

// ---------------------------------------------------------------------------
// Registry-bounds invariant (pinned v1.1.2)
// ---------------------------------------------------------------------------
// The per-instance media() cache grows by one entry per DISTINCT query string,
// never per call. The contract is that an app's query vocabulary is small and
// static. Crucially this is NOT silently unbounded: each entry is a lite-signal
// node, and lite-signal enforces a fixed live-node budget (1024 by default,
// reclaimed via GC when signals go unreachable). Past it, signal() throws a
// fail-closed CapacityError rather than growing without bound. The scale
// behaviour (thousands of distinct queries -> CapacityError) is exercised in
// test/torture.mjs, which runs under --expose-gc; here we prove the memo
// mechanism at small N without spending the shared node budget.

describe("registry-bounds invariant", () => {
    test("repeated identical queries do not grow the registry", () => {
        const m = createMedia({ ssrDefault: false });
        for (let i = 0; i < 10000; i += 1) m.media("(min-width: 400px)");
        assert.equal(m.stats().watched, 1); // one signal, 9999 memo hits
    });

    test("distinct queries grow the registry exactly one per query", () => {
        const m = createMedia({ ssrDefault: false });
        const N = 64;
        for (let i = 0; i < N; i += 1) m.media("(min-width: " + i + "px)");
        assert.equal(m.stats().watched, N);
        // Re-touching the same N queries adds nothing.
        for (let i = 0; i < N; i += 1) m.media("(min-width: " + i + "px)");
        assert.equal(m.stats().watched, N);
    });
});

// ---------------------------------------------------------------------------
// SSR container contract (pinned v1.1.2)
// ---------------------------------------------------------------------------
// containerMedia() off-DOM returns a stable `false` signal and never throws.
// This is the conservative, fail-closed verdict and it deliberately differs
// from media() (which throws without ssrDefault).

describe("SSR container contract", () => {
    beforeEach(() => __resetForTests());

    test("containerMedia() off-DOM returns false and never throws", () => {
        // No configure(), no browser: the node inert engine is selected.
        let s;
        assert.doesNotThrow(() => { s = containerMedia({}, "(min-width: 400px)"); });
        assert.equal(s(), false);
    });

    test("ssrDefault does not flip the container verdict (unlike media())", () => {
        configure({ ssrDefault: true });
        // media() honors ssrDefault...
        assert.equal(media("(min-width: 400px)")(), true);
        // ...but containerMedia() stays conservatively false off-DOM.
        assert.equal(containerMedia({}, "(min-width: 400px)")(), false);
    });
});
