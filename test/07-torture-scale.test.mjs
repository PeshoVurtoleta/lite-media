import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { effect } from "@zakkster/lite-signal";
import { media, configure, __resetForTests, stats } from "../Media.js";

// Scale torture — this file's node budget targets ~700 signals, well below
// lite-signal's 1024 cap. Each Node --test subprocess starts fresh.

function makeMockMM() {
    const reg = new Map();
    return {
        matchMedia(q) {
            let e = reg.get(q);
            if (e === undefined) { e = { matches: false, listeners: new Set() }; reg.set(q, e); }
            return {
                get matches() { return e.matches; },
                addEventListener(t, h) { if (t === "change") e.listeners.add(h); },
                removeEventListener(t, h) { if (t === "change") e.listeners.delete(h); },
            };
        },
        flip(q, m) {
            const e = reg.get(q);
            if (e === undefined) return;
            e.matches = m;
            for (const h of e.listeners) h({ matches: m });
        },
    };
}

describe("torture · scale — many distinct queries", () => {
    beforeEach(() => __resetForTests());

    test("400 distinct queries — all memoize independently", () => {
        const mm = makeMockMM();
        configure({ matchMedia: mm.matchMedia });
        const N = 400;
        for (let i = 0; i < N; i++) media(`(width: ${i}px)`);
        assert.strictEqual(stats().watched, N);
    });

    test("10,000 cache hits are cheap (< 200 ms)", () => {
        const mm = makeMockMM();
        configure({ matchMedia: mm.matchMedia });
        media("(hot)");
        const t0 = performance.now();
        for (let i = 0; i < 10_000; i++) media("(hot)");
        const t1 = performance.now();
        assert.ok(t1 - t0 < 200, `10k cache hits took ${(t1 - t0).toFixed(1)} ms`);
    });
});

describe("torture · scale — fanout to many subscribers", () => {
    beforeEach(() => __resetForTests());

    test("300 subscribers on one signal — one flip fans out to all", () => {
        const mm = makeMockMM();
        configure({ matchMedia: mm.matchMedia });
        const s = media("(x)");
        let runs = 0;
        const stops = [];
        for (let i = 0; i < 300; i++) {
            stops.push(effect(() => { s(); runs++; }));
        }
        const baseline = runs;
        mm.flip("(x)", true);
        assert.strictEqual(runs - baseline, 300);
        mm.flip("(x)", true); // dedupe — no new runs
        assert.strictEqual(runs - baseline, 300);
        mm.flip("(x)", false);
        assert.strictEqual(runs - baseline, 600);
        for (const stop of stops) stop();
    });
});
