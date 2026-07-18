import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { effect } from "@zakkster/lite-signal";
import { media, configure, __resetForTests } from "../Media.js";

const HAS_GC = typeof globalThis.gc === "function";

// Inline mock — identical shape to test/01, kept local so each file is
// self-contained (Node's --test runs each file in its own subprocess by
// default; cross-file isolation is free, but each file should read cleanly on
// its own).
function makeMock() {
    const registry = new Map();
    function ensure(q) {
        let e = registry.get(q);
        if (e === undefined) {
            e = { matches: false, listeners: new Set() };
            registry.set(q, e);
        }
        return e;
    }
    function matchMedia(q) {
        const e = ensure(q);
        return {
            get matches() { return e.matches; },
            addEventListener(type, h) { if (type === "change") e.listeners.add(h); },
            removeEventListener(type, h) { if (type === "change") e.listeners.delete(h); },
        };
    }
    function flip(q, m) {
        const e = registry.get(q);
        if (e !== undefined) {
            e.matches = m;
            for (const h of e.listeners) h({ matches: m });
        }
    }
    return { matchMedia, flip };
}

describe("zero-GC — heap-delta guard", () => {
    beforeEach(() => __resetForTests());

    // The core steady-state claim: after all signals are materialized and all
    // effects are attached, a storm of `change` events allocates nothing on
    // lite-media's path. The handler closures are hoisted at cache-miss time
    // and reused for every event; lite-signal itself is zero-GC by design.
    //
    // Budget: 200 KB after 10k flips × 20 signals = 200k events. That's the
    // same order lite-signal budgets for 100k signal.set() calls; lite-media
    // adds a getter access (`e.matches`) and one method call per event, both
    // allocation-free. Test skips when --expose-gc isn't set (matches
    // lite-signal's Tier 2 pattern).
    test(
        "10k flips across 20 signals hold heap flat",
        { skip: !HAS_GC },
        () => {
            const mock = makeMock();
            configure({ matchMedia: mock.matchMedia });

            const N_SIGNALS = 20;
            const queries = [];
            let effectRuns = 0;
            for (let i = 0; i < N_SIGNALS; i++) {
                const q = `(width: ${i}px)`;
                queries.push(q);
                const s = media(q);
                effect(() => { s(); effectRuns++; });
            }
            const baselineRuns = effectRuns;

            // Warm-up: several rounds of alternating flips prime any lazy inline
            // caches in V8 and settle heap growth. Without warm-up, first-flip
            // IC pollution shows up as false positive allocation.
            for (let i = 0; i < 3; i++) {
                for (const q of queries) mock.flip(q, true);
                for (const q of queries) mock.flip(q, false);
            }

            globalThis.gc();
            const startHeap = process.memoryUsage().heapUsed;

            const N_FLIPS = 10_000;
            for (let i = 0; i < N_FLIPS; i++) {
                const m = (i & 1) === 1;
                for (const q of queries) mock.flip(q, m);
            }

            globalThis.gc();
            const endHeap = process.memoryUsage().heapUsed;
            const delta = endHeap - startHeap;

            // Sanity: the flips actually reached the effects (guards against
            // silently-broken setups where the mock never dispatches).
            assert.ok(
                effectRuns > baselineRuns + N_FLIPS,
                `expected effect re-runs on flips, got ${effectRuns - baselineRuns}`
            );

            assert.ok(
                delta < 200 * 1024,
                `heap delta ${delta} bytes exceeds 200 KB budget`
            );
        }
    );
});

describe("zero-GC — no timers scheduled", () => {
    beforeEach(() => __resetForTests());

    // Grep-adjacent guard: the pasted proposal we rejected in the roadmap used
    // setTimeout for debouncing. lite-media must not touch timers on any code
    // path exercised here. Wrapping setTimeout/setInterval with a counter is
    // enough — if anything sneaks in, the test fails loud.
    test("flip storm never calls setTimeout / setInterval", () => {
        const mock = makeMock();
        configure({ matchMedia: mock.matchMedia });

        const original_setTimeout  = globalThis.setTimeout;
        const original_setInterval = globalThis.setInterval;
        let timerCount = 0;

        globalThis.setTimeout  = (...args) => { timerCount++; return original_setTimeout(...args); };
        globalThis.setInterval = (...args) => { timerCount++; return original_setInterval(...args); };

        try {
            const s = media("(any)");
            const stop = effect(() => { s(); });
            for (let i = 0; i < 1000; i++) mock.flip("(any)", (i & 1) === 1);
            stop();
            assert.strictEqual(
                timerCount, 0,
                "lite-media must not schedule any timers on the media path"
            );
        } finally {
            globalThis.setTimeout  = original_setTimeout;
            globalThis.setInterval = original_setInterval;
        }
    });
});
