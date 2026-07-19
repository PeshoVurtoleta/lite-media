import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { effect } from "@zakkster/lite-signal";
import {
    createMedia, media as defaultMedia, __resetForTests,
} from "../Media.js";

// Simple mock MQL factory reused across tests.
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
        setInitial(q, m) {
            let e = reg.get(q);
            if (e === undefined) { e = { matches: false, listeners: new Set() }; reg.set(q, e); }
            e.matches = m;
        },
        size() { return reg.size; },
    };
}

describe("createMedia() — creation contract", () => {
    beforeEach(() => __resetForTests());

    test("returns an object exposing media / containerMedia / prefs / stats", () => {
        const inst = createMedia({ ssrDefault: false });
        assert.strictEqual(typeof inst.media, "function");
        assert.strictEqual(typeof inst.containerMedia, "function");
        assert.strictEqual(typeof inst.reducedMotion, "function");
        assert.strictEqual(typeof inst.darkScheme, "function");
        assert.strictEqual(typeof inst.hoverCapable, "function");
        assert.strictEqual(typeof inst.coarsePointer, "function");
        assert.strictEqual(typeof inst.forcedColors, "function");
        assert.strictEqual(typeof inst.moreContrast, "function");
        assert.strictEqual(typeof inst.reducedData, "function");
        assert.strictEqual(typeof inst.reducedTransparency, "function");
        assert.strictEqual(typeof inst.stats, "function");
    });

    test("no configure() method on scoped instance — options are creation-only", () => {
        const inst = createMedia({ ssrDefault: false });
        assert.strictEqual(inst.configure, undefined);
    });

    test("createMedia() with no args works when window.matchMedia is available OR throws honestly", () => {
        // In Node without any config, this instance can materialize signals
        // only if globalThis.matchMedia exists. On Node it doesn't → media()
        // throws honestly.
        const inst = createMedia();
        if (typeof globalThis.matchMedia === "function") {
            assert.doesNotThrow(() => inst.media("(any)"));
        } else {
            assert.throws(() => inst.media("(any)"), /no matchMedia/i);
        }
    });

    test("null / undefined opts are safe (behaves like createMedia())", () => {
        assert.doesNotThrow(() => createMedia(null));
        assert.doesNotThrow(() => createMedia(undefined));
        assert.doesNotThrow(() => createMedia());
    });

    test("bad containerEngine shape throws TypeError at creation", () => {
        assert.throws(
            () => createMedia({ containerEngine: {} }),
            TypeError
        );
        assert.throws(
            () => createMedia({ containerEngine: { watch: "not a fn" } }),
            TypeError
        );
        assert.throws(
            () => createMedia({ containerEngine: 42 }),
            TypeError
        );
    });
});

describe("createMedia() — isolation", () => {
    beforeEach(() => __resetForTests());

    test("two instances with different matchMedia see different worlds", () => {
        const mmA = makeMockMM();
        const mmB = makeMockMM();
        mmA.setInitial("(x)", true);
        mmB.setInitial("(x)", false);
        const a = createMedia({ matchMedia: mmA.matchMedia });
        const b = createMedia({ matchMedia: mmB.matchMedia });
        assert.strictEqual(a.media("(x)")(), true);
        assert.strictEqual(b.media("(x)")(), false);
    });

    test("flipping mock A does not affect instance B's cached signal", () => {
        const mmA = makeMockMM();
        const mmB = makeMockMM();
        const a = createMedia({ matchMedia: mmA.matchMedia });
        const b = createMedia({ matchMedia: mmB.matchMedia });
        const sa = a.media("(x)");
        const sb = b.media("(x)");
        assert.strictEqual(sa(), false);
        assert.strictEqual(sb(), false);
        mmA.flip("(x)", true);
        assert.strictEqual(sa(), true);
        assert.strictEqual(sb(), false); // isolated
    });

    test("caches are completely independent — same query, different signals", () => {
        const mm = makeMockMM(); // shared factory, different instances
        const a = createMedia({ matchMedia: mm.matchMedia });
        const b = createMedia({ matchMedia: mm.matchMedia });
        const sa = a.media("(x)");
        const sb = b.media("(x)");
        assert.notStrictEqual(sa, sb);
    });

    test("cross-instance dedupe: same query on same instance returns same signal", () => {
        const mm = makeMockMM();
        const a = createMedia({ matchMedia: mm.matchMedia });
        assert.strictEqual(a.media("(x)"), a.media("(x)"));
    });

    test("stats() is per-instance", () => {
        const mm = makeMockMM();
        const a = createMedia({ matchMedia: mm.matchMedia });
        const b = createMedia({ matchMedia: mm.matchMedia });
        a.media("(x)");
        a.media("(y)");
        b.media("(z)");
        assert.strictEqual(a.stats().watched, 2);
        assert.strictEqual(b.stats().watched, 1);
    });

    test("scoped instance never locks (no configure step)", () => {
        const mm = makeMockMM();
        const a = createMedia({ matchMedia: mm.matchMedia });
        a.media("(x)");
        assert.strictEqual(a.stats().locked, false);
    });

    test("stats().configured reflects user-supplied containerEngine on scoped instances", () => {
        // Regression: v1.1 initial impl only checked matchMedia + ssrDefault;
        // a scoped instance created with containerEngine looked unconfigured.
        const eng = {
            watch(_e, _q, _cb) { return { initial: false, dispose() {} }; },
        };
        const a = createMedia({ containerEngine: eng });
        assert.strictEqual(a.stats().configured, true);
        // Without any user config, configured stays false even after a
        // containerMedia() call lazily resolves an engine.
        const b = createMedia({ ssrDefault: false });
        assert.strictEqual(b.stats().configured, true); // ssrDefault DID count
        const c = createMedia();
        c.containerMedia({}, "(x)"); // triggers detectDefaultContainerEngine
        assert.strictEqual(c.stats().configured, false); // lazy default does NOT count
    });

    test("default instance is unaffected by scoped instance activity", () => {
        const mmScoped = makeMockMM();
        const scoped = createMedia({ matchMedia: mmScoped.matchMedia });
        scoped.media("(x)");
        // Default instance still needs its own config or throws.
        if (typeof globalThis.matchMedia !== "function") {
            assert.throws(() => defaultMedia("(x)"), /no matchMedia/i);
        }
    });
});

describe("createMedia() — preference shortcuts use the instance's cache", () => {
    beforeEach(() => __resetForTests());

    test("instance.reducedMotion() and instance.media(canonical query) share signal", () => {
        const mm = makeMockMM();
        const a = createMedia({ matchMedia: mm.matchMedia });
        const rm = a.reducedMotion();
        const canonical = a.media("(prefers-reduced-motion: reduce)");
        assert.strictEqual(rm, canonical);
    });

    test("preferences on instance A do not leak to instance B", () => {
        const mmA = makeMockMM();
        const mmB = makeMockMM();
        mmA.setInitial("(prefers-color-scheme: dark)", true);
        const a = createMedia({ matchMedia: mmA.matchMedia });
        const b = createMedia({ matchMedia: mmB.matchMedia });
        assert.strictEqual(a.darkScheme()(), true);
        assert.strictEqual(b.darkScheme()(), false);
    });
});

describe("createMedia() — SSR default", () => {
    beforeEach(() => __resetForTests());

    test("ssrDefault: true, no matchMedia → media() returns true", () => {
        const a = createMedia({ ssrDefault: true });
        assert.strictEqual(a.media("(any)")(), true);
    });

    test("ssrDefault: false, no matchMedia → media() returns false", () => {
        const a = createMedia({ ssrDefault: false });
        assert.strictEqual(a.media("(any)")(), false);
    });

    test("per-request pattern: fresh instance per request gets fresh cache", () => {
        // Simulate 3 requests with different SSR defaults. This is exactly
        // the pattern that was fundamentally broken in v1.0 with the
        // module-global cache.
        const results = [];
        for (const req of [{ ua: "mobile" }, { ua: "desktop" }, { ua: "mobile" }]) {
            const inst = createMedia({ ssrDefault: req.ua === "mobile" });
            results.push(inst.media("(max-width: 600px)")());
        }
        assert.deepStrictEqual(results, [true, false, true]);
    });
});
