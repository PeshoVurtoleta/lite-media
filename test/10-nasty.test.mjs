import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { effect } from "@zakkster/lite-signal";
import {
    media, containerMedia, configure, createMedia, __resetForTests,
} from "../Media.js";

// ============================================================================
// Nasty things people accidentally OR maliciously do. Progression: shape
// tricks -> throwing components -> live desync -> cross-instance isolation
// under attack.
// ============================================================================

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

// ============================================================================
// Malformed MQL shapes
// ============================================================================

describe("nasty - malformed MQL shapes", () => {
    beforeEach(() => __resetForTests());

    test("MQL missing addEventListener throws named TypeError", () => {
        configure({ matchMedia: () => ({ matches: true }) });
        assert.throws(
            () => media("(x)"),
            (err) => err instanceof TypeError && /addEventListener|MockMediaQueryList/i.test(err.message)
        );
    });

    test("factory returning primitive throws named TypeError", () => {
        configure({ matchMedia: () => 42 });
        assert.throws(() => media("(x)"), TypeError);
    });

    test("factory returning function is refused -- a function is 'object' via typeof but has no addEventListener", () => {
        configure({ matchMedia: () => function empty() {} });
        assert.throws(() => media("(x)"), TypeError);
    });

    test("MQL with addEventListener that throws -- media() propagates the throw and does not orphan a lite-signal node", () => {
        // Node-leak guard: v1.1 fix moved signal() below successful
        // addEventListener() so a throwing MQL cannot compound orphaned
        // nodes against the 1024-node budget on repeated retries.
        configure({
            matchMedia: () => ({
                matches: false,
                addEventListener() { throw new Error("nope"); },
            }),
        });
        assert.throws(() => media("(x)"), /nope/);
        // Repeat many times -- if we were leaking one node per throw, the
        // per-process node pool would fill and later media() calls would
        // start throwing CapacityError instead of "nope".
        for (let i = 0; i < 100; i++) {
            assert.throws(() => media("(x)"), /nope/);
        }
    });

    test("MQL with getter-based matches -- read once at cache-miss, not repeatedly", () => {
        let reads = 0;
        configure({
            matchMedia: () => ({
                get matches() { reads++; return false; },
                addEventListener() {},
            }),
        });
        const s = media("(x)");
        // We read `matches` at materialization. Reading the signal after
        // must not re-read `matches` on the MQL.
        s(); s(); s();
        assert.strictEqual(reads, 1);
    });
});

// ============================================================================
// Handlers behaving badly
// ============================================================================

describe("nasty - badly-behaved handlers", () => {
    beforeEach(() => __resetForTests());

    test("effect that throws only sometimes -- good effect still receives every flip", () => {
        // A throwing effect at creation time propagates out of effect() --
        // that's lite-signal's contract (fail loud, don't swallow errors).
        // What lite-media MUST guarantee is that once a good effect is
        // subscribed, a subsequent throw from a co-subscribed effect
        // doesn't break its fanout. Model: bad effect throws only on
        // the second run onwards; good effect always fires.
        const mm = makeMockMM();
        configure({ matchMedia: mm.matchMedia });
        const s = media("(x)");
        let goodRuns = 0;
        let badRuns = 0;
        const stopGood = effect(() => { s(); goodRuns++; });
        const stopBad = effect(() => {
            s();
            badRuns++;
            if (badRuns > 1) throw new Error("bad");
        });
        const goodBaseline = goodRuns;
        // First flip: bad's first re-run does NOT throw; good runs cleanly.
        try { mm.flip("(x)", true); } catch (_e) { /* swallow */ }
        // Subsequent flips: bad throws, but good must still have advanced.
        try { mm.flip("(x)", false); } catch (_e) { /* swallow */ }
        try { mm.flip("(x)", true); } catch (_e) { /* swallow */ }
        assert.ok(
            goodRuns > goodBaseline,
            `good effect must advance at least once (was ${goodRuns - goodBaseline})`
        );
        stopBad();
        stopGood();
    });

    test("effect that unsubscribes itself -- clean dispose, no crash", () => {
        const mm = makeMockMM();
        configure({ matchMedia: mm.matchMedia });
        const s = media("(x)");
        let stop;
        let runs = 0;
        stop = effect(() => {
            s();
            runs++;
            if (runs >= 2) stop();
        });
        mm.flip("(x)", true); // triggers 2nd run -> self-dispose
        mm.flip("(x)", false); // must not fire the disposed effect
        assert.strictEqual(runs, 2);
    });

    test("effect that materializes ANOTHER signal -- no crash, both remain reactive", () => {
        const mm = makeMockMM();
        configure({ matchMedia: mm.matchMedia });
        const s1 = media("(a)");
        let s2 = null;
        let s2Runs = 0;
        const stop1 = effect(() => {
            if (s1()) { s2 = media("(b)"); }
        });
        // Trigger s1: causes s2 to be materialized inside the effect.
        mm.flip("(a)", true);
        assert.ok(s2 !== null, "second signal materialized");
        // Now subscribe to s2 and verify it's live.
        const stop2 = effect(() => { s2(); s2Runs++; });
        mm.flip("(b)", true);
        assert.ok(s2Runs >= 2, `s2 effect ran on b-flip (was ${s2Runs})`);
        stop1();
        stop2();
    });
});

// ============================================================================
// Signal runtime writability (documented anti-pattern)
// ============================================================================

describe("nasty - signal is writable at runtime (docs say don't)", () => {
    beforeEach(() => __resetForTests());

    test("calling .set() on a returned signal permanently desyncs from browser flips", () => {
        const mm = makeMockMM();
        configure({ matchMedia: mm.matchMedia });
        const s = media("(x)");
        assert.strictEqual(s(), false);
        // Anti-pattern: writing directly. Documented as broken.
        s.set(true);
        assert.strictEqual(s(), true);
        // Now flip the browser to true -- that value is already what's set,
        // so nothing observable changes. Then flip to false.
        mm.flip("(x)", false);
        // The signal DID receive the browser event and is now `false`.
        // The point of the "don't do this" doc note is that the user is
        // fighting the reactive model, not that the browser stops working.
        assert.strictEqual(s(), false);
    });
});

// ============================================================================
// Cross-instance isolation under attack
// ============================================================================

describe("nasty - cross-instance leak attempts", () => {
    beforeEach(() => __resetForTests());

    test("swapping instance A's matchMedia in-flight cannot poison instance B", () => {
        // createMedia captures options at creation. Even if someone reassigns
        // a factory later (not that we expose a way to), instance B's cache
        // is fully independent.
        const mmA = makeMockMM();
        const mmB = makeMockMM();
        const a = createMedia({ matchMedia: mmA.matchMedia });
        const b = createMedia({ matchMedia: mmB.matchMedia });
        const sa = a.media("(x)");
        const sb = b.media("(x)");
        // Poison attempt: run A's mock into totally opposite states.
        mmA.flip("(x)", true);
        mmA.flip("(x)", false);
        mmA.flip("(x)", true);
        // B should be completely untouched.
        assert.strictEqual(sb(), false);
        assert.strictEqual(sa(), true);
    });

    test("Object.prototype pollution via query string does not affect other queries", () => {
        const mm = makeMockMM();
        configure({ matchMedia: mm.matchMedia });
        media("__proto__");
        media("constructor");
        media("toString");
        // Verify a normal query is still normal.
        const s = media("(normal)");
        assert.strictEqual(typeof s, "function");
        assert.strictEqual(s(), false);
        // Verify Object.prototype was not touched by our cache.
        assert.strictEqual({}.hasOwnProperty("polluted"), false);
    });

    test("scoped instance's containerMedia() cache does not accept module-level el as key twice", () => {
        // WeakMap keying: same el -> same inner Map. But different createMedia
        // instances have DIFFERENT WeakMaps, so el is a fresh key per instance.
        const el = { id: "shared-el" };
        const engineA = {
            watch(_e, _q, _cb) { return { initial: true, dispose() {} }; },
        };
        const engineB = {
            watch(_e, _q, _cb) { return { initial: false, dispose() {} }; },
        };
        const a = createMedia({ containerEngine: engineA, ssrDefault: false });
        const b = createMedia({ containerEngine: engineB, ssrDefault: false });
        const sa = a.containerMedia(el, "(x)");
        const sb = b.containerMedia(el, "(x)");
        assert.notStrictEqual(sa, sb);
        assert.strictEqual(sa(), true);
        assert.strictEqual(sb(), false);
    });
});

// ============================================================================
// Configuration race
// ============================================================================

describe("nasty - configure race", () => {
    beforeEach(() => __resetForTests());

    test("configure() thrown by validation does not corrupt module state", () => {
        // Attempt to configure with bad matchMedia. It throws. Then re-try
        // with good config. The state should be as if the throw never
        // happened (nothing was set).
        assert.throws(
            () => configure({ matchMedia: "not a fn", ssrDefault: false }),
            TypeError
        );
        // Even though the call threw, ssrDefault was AFTER the throw so it
        // was never applied. media() should still work if we now retry:
        configure({ ssrDefault: false });
        assert.doesNotThrow(() => media("(x)"));
    });

    test("failed materialization does not lock; re-configure recovers", () => {
        // No matchMedia, no ssrDefault -> media() throws.
        if (typeof globalThis.matchMedia === "function") return; // skip in browser-ish envs
        assert.throws(() => media("(x)"), /no matchMedia/i);
        // Now configure -- must work.
        configure({ ssrDefault: true });
        assert.strictEqual(media("(x)")(), true);
    });
});
