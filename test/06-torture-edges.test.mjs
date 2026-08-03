import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { effect } from "@zakkster/lite-signal";
import {
    media, containerMedia, configure, __resetForTests, stats,
} from "../Media.js";

// This file exercises smallest / weirdest inputs and light-weight lifecycle
// scenarios. Node budget kept modest so it fits in a single subprocess.

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

function makeContainerEngine() {
    const listeners = new Map();
    return {
        flip(el, q, m) {
            const cb = listeners.get(el.id + "|" + q);
            if (cb !== undefined) cb(m);
        },
        watch(el, q, onChange) {
            const key = el.id + "|" + q;
            listeners.set(key, onChange);
            return { initial: false, dispose() { listeners.delete(key); } };
        },
    };
}

// ============================================================================
// Tier 1 -- smallest surprises (edge-value queries)
// ============================================================================

describe("torture - edges -- degenerate queries", () => {
    beforeEach(() => __resetForTests());

    test("empty string query -- factory called with '', signal is inert-but-real", () => {
        const mm = makeMockMM();
        configure({ matchMedia: mm.matchMedia });
        const s = media("");
        assert.strictEqual(typeof s, "function");
        assert.strictEqual(s(), false);
    });

    test("whitespace-only queries are distinct cache keys from empty and each other", () => {
        const mm = makeMockMM();
        configure({ matchMedia: mm.matchMedia });
        const a = media("");
        const b = media(" ");
        const c = media("\t");
        assert.notStrictEqual(a, b);
        assert.notStrictEqual(b, c);
        assert.strictEqual(stats().watched, 3);
    });

    test("query with newlines and tabs -- no crash, distinct signal", () => {
        const mm = makeMockMM();
        configure({ matchMedia: mm.matchMedia });
        const s = media("(min-width:\n\t 400px)");
        assert.strictEqual(typeof s, "function");
    });

    test("query with unicode -- Cyrillic, emoji, RTL marks", () => {
        const mm = makeMockMM();
        configure({ matchMedia: mm.matchMedia });
        assert.doesNotThrow(() => media("(prefers-color-scheme: \u0442\u0451\u043c\u043d\u0430\u044f)"));
        assert.doesNotThrow(() => media("(min-width: \u{1F680}px)"));
        assert.doesNotThrow(() => media("\u200F(min-width: 400px)\u200E"));
    });

    test("query with quotes and backticks -- cache key survives verbatim", () => {
        const mm = makeMockMM();
        configure({ matchMedia: mm.matchMedia });
        const q = "(min-width: 400px) and (\"custom\": 'value')";
        const s1 = media(q);
        const s2 = media(q);
        assert.strictEqual(s1, s2);
    });

    test("10KB query -- memoization holds, no crash", () => {
        const mm = makeMockMM();
        configure({ matchMedia: mm.matchMedia });
        const q = "(min-width: 400px)" + " and (min-height: 400px)".repeat(500);
        assert.ok(q.length > 10_000);
        const a = media(q);
        const b = media(q);
        assert.strictEqual(a, b);
    });

    test("prototype-adjacent query strings are just strings -- no pollution", () => {
        // Map keys don't share Object.prototype with plain-object caches, so
        // '__proto__' / 'constructor' / 'toString' are just cache keys.
        const mm = makeMockMM();
        configure({ matchMedia: mm.matchMedia });
        assert.doesNotThrow(() => media("__proto__"));
        assert.doesNotThrow(() => media("constructor"));
        assert.doesNotThrow(() => media("toString"));
        assert.strictEqual(stats().watched, 3);
    });
});

// ============================================================================
// Lightweight lifecycle
// ============================================================================

describe("torture - lifecycle -- many subscribe/unsubscribe on one signal", () => {
    beforeEach(() => __resetForTests());

    test("1000 effect subscribe/unsubscribe cycles on one signal -- one survives", () => {
        // High churn on a small graph. Each effect is created and destroyed
        // in sequence -- only one node exists at a time. Fits easily in the
        // node budget.
        const mm = makeMockMM();
        configure({ matchMedia: mm.matchMedia });
        const s = media("(x)");
        for (let i = 0; i < 1000; i++) {
            const stop = effect(() => { s(); });
            stop();
        }
        // Final subscriber still sees fresh flips.
        let last = null;
        const stop = effect(() => { last = s(); });
        assert.strictEqual(last, false);
        mm.flip("(x)", true);
        assert.strictEqual(last, true);
        stop();
    });

    test("__resetForTests() truly resets -- post-reset materialization succeeds fresh", () => {
        const mm = makeMockMM();
        configure({ matchMedia: mm.matchMedia });
        media("(x)");
        media("(y)");
        assert.strictEqual(stats().watched, 2);
        __resetForTests();
        assert.strictEqual(stats().watched, 0);
        assert.strictEqual(stats().locked, false);
        assert.strictEqual(stats().configured, false);
        const mm2 = makeMockMM();
        configure({ matchMedia: mm2.matchMedia });
        assert.doesNotThrow(() => media("(x)"));
    });
});

// ============================================================================
// Mixed engines
// ============================================================================

describe("torture - mixed -- media() and containerMedia() interleaved", () => {
    beforeEach(() => __resetForTests());

    test("media() and containerMedia() coexist without cross-contamination", () => {
        const mm = makeMockMM();
        const ce = makeContainerEngine();
        configure({ matchMedia: mm.matchMedia, containerEngine: ce });
        const el = { id: "el-1" };
        const mSig = media("(x)");
        const cSig = containerMedia(el, "(x)");
        assert.notStrictEqual(mSig, cSig);
        mm.flip("(x)", true);
        assert.strictEqual(mSig(), true);
        assert.strictEqual(cSig(), false);
        ce.flip(el, "(x)", true);
        assert.strictEqual(cSig(), true);
    });

    test("100 containerMedia signals across 10 elements -- each independent", () => {
        const mm = makeMockMM();
        const ce = makeContainerEngine();
        configure({ matchMedia: mm.matchMedia, containerEngine: ce });
        const els = [];
        for (let i = 0; i < 10; i++) els.push({ id: `el-${i}` });
        for (let i = 0; i < 10; i++) {
            for (let j = 0; j < 10; j++) {
                containerMedia(els[i], `(min-width: ${j * 100}px)`);
            }
        }
        // Flip one -- only its signal moves.
        ce.flip(els[3], "(min-width: 800px)", true);
        assert.strictEqual(containerMedia(els[3], "(min-width: 800px)")(), true);
        assert.strictEqual(containerMedia(els[4], "(min-width: 800px)")(), false);
    });
});
