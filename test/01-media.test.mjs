import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { effect } from "@zakkster/lite-signal";
import {
    media, configure, stats, __resetForTests,
    reducedMotion, darkScheme, hoverCapable, coarsePointer,
    forcedColors, moreContrast, reducedData, reducedTransparency,
} from "../Media.js";

// ---------------------------------------------------------------------------
// makeMock — reusable MQL factory
// ---------------------------------------------------------------------------
// Simulates the DOM's MediaQueryList: one entry per query, `flip()` mutates
// and dispatches to registered `change` listeners. `setInitial()` primes the
// value before a signal materializes (models the case where the CSS matches
// at page load).

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
            addEventListener(type, h) {
                if (type === "change") e.listeners.add(h);
            },
            removeEventListener(type, h) {
                if (type === "change") e.listeners.delete(h);
            },
        };
    }
    function flip(q, m) {
        const e = registry.get(q);
        if (e !== undefined) {
            e.matches = m;
            for (const h of e.listeners) h({ matches: m });
        }
    }
    function setInitial(q, m) { ensure(q).matches = m; }
    return { matchMedia, flip, setInitial, registry };
}

// ---------------------------------------------------------------------------
// media()
// ---------------------------------------------------------------------------

describe("media()", () => {
    beforeEach(() => __resetForTests());

    test("memoizes by query string — same string returns same signal", () => {
        const mock = makeMock();
        configure({ matchMedia: mock.matchMedia });
        const a = media("(max-width: 600px)");
        const b = media("(max-width: 600px)");
        assert.strictEqual(a, b);
    });

    test("distinct queries yield distinct signals", () => {
        const mock = makeMock();
        configure({ matchMedia: mock.matchMedia });
        const a = media("(max-width: 600px)");
        const b = media("(max-width: 800px)");
        assert.notStrictEqual(a, b);
    });

    test("reflects initial matchMedia state", () => {
        const mock = makeMock();
        mock.setInitial("(max-width: 600px)", true);
        configure({ matchMedia: mock.matchMedia });
        const s = media("(max-width: 600px)");
        assert.strictEqual(s(), true);
    });

    test("updates on change event", () => {
        const mock = makeMock();
        configure({ matchMedia: mock.matchMedia });
        const s = media("(max-width: 600px)");
        assert.strictEqual(s(), false);
        mock.flip("(max-width: 600px)", true);
        assert.strictEqual(s(), true);
        mock.flip("(max-width: 600px)", false);
        assert.strictEqual(s(), false);
    });

    test("drives lite-signal effects; Object.is dedupe skips redundant flips", () => {
        const mock = makeMock();
        configure({ matchMedia: mock.matchMedia });
        const s = media("(max-width: 600px)");
        let last = null;
        let runs = 0;
        const stop = effect(() => { last = s(); runs++; });
        assert.strictEqual(last, false);
        assert.strictEqual(runs, 1); // initial run

        mock.flip("(max-width: 600px)", true);
        assert.strictEqual(last, true);
        assert.strictEqual(runs, 2);

        // Redundant flip — same value dispatched twice. lite-signal drops it via
        // Object.is; effect must NOT re-run.
        mock.flip("(max-width: 600px)", true);
        assert.strictEqual(runs, 2);

        stop();
    });

    test("peek() reads without subscribing", () => {
        const mock = makeMock();
        configure({ matchMedia: mock.matchMedia });
        const s = media("(any)");
        assert.strictEqual(s.peek(), false);
        mock.flip("(any)", true);
        assert.strictEqual(s.peek(), true);
    });
});

// ---------------------------------------------------------------------------
// stats()
// ---------------------------------------------------------------------------

describe("stats()", () => {
    beforeEach(() => __resetForTests());

    test("watched increments per unique query, not per call", () => {
        const mock = makeMock();
        configure({ matchMedia: mock.matchMedia });
        assert.strictEqual(stats().watched, 0);
        media("(max-width: 600px)");
        assert.strictEqual(stats().watched, 1);
        media("(max-width: 600px)"); // cache hit
        assert.strictEqual(stats().watched, 1);
        media("(max-width: 800px)");
        assert.strictEqual(stats().watched, 2);
    });

    test("locked flips true on first materialization", () => {
        const mock = makeMock();
        configure({ matchMedia: mock.matchMedia });
        assert.strictEqual(stats().locked, false);
        media("(any)");
        assert.strictEqual(stats().locked, true);
    });

    test("configured tracks matchMedia and ssrDefault independently", () => {
        assert.strictEqual(stats().configured, false);
        const mock = makeMock();
        configure({ matchMedia: mock.matchMedia });
        assert.strictEqual(stats().configured, true);
        __resetForTests();
        assert.strictEqual(stats().configured, false);
        configure({ ssrDefault: false });
        assert.strictEqual(stats().configured, true);
    });
});

// ---------------------------------------------------------------------------
// Preference shortcuts
// ---------------------------------------------------------------------------

describe("preference shortcuts", () => {
    beforeEach(() => __resetForTests());

    // The table is the contract: any drift between a shortcut and the canonical
    // query string is a bug detectable here.
    const EXPECTED = [
        ["reducedMotion",       reducedMotion,       "(prefers-reduced-motion: reduce)"],
        ["darkScheme",          darkScheme,          "(prefers-color-scheme: dark)"],
        ["hoverCapable",        hoverCapable,        "(hover: hover)"],
        ["coarsePointer",       coarsePointer,       "(pointer: coarse)"],
        ["forcedColors",        forcedColors,        "(forced-colors: active)"],
        ["moreContrast",        moreContrast,        "(prefers-contrast: more)"],
        ["reducedData",         reducedData,         "(prefers-reduced-data: reduce)"],
        ["reducedTransparency", reducedTransparency, "(prefers-reduced-transparency: reduce)"],
    ];

    test("each shortcut resolves to its canonical query and shares the cache", () => {
        const mock = makeMock();
        configure({ matchMedia: mock.matchMedia });

        for (const [name, fn, q] of EXPECTED) {
            const s = fn();
            assert.strictEqual(typeof s, "function", `${name}: signal is callable`);
            assert.strictEqual(mock.registry.has(q), true, `${name}: cache key created`);
            // Shared cache with media()
            assert.strictEqual(s, media(q), `${name}: shares media() cache`);
        }
        assert.strictEqual(stats().watched, EXPECTED.length);
    });

    test("hoisted signal + effect: reduced-motion gate", () => {
        const mock = makeMock();
        mock.setInitial("(prefers-reduced-motion: reduce)", false);
        configure({ matchMedia: mock.matchMedia });

        const rm = reducedMotion();
        let animationsPlayed = 0;
        const stop = effect(() => { if (!rm()) animationsPlayed++; });
        assert.strictEqual(animationsPlayed, 1);

        mock.flip("(prefers-reduced-motion: reduce)", true);
        assert.strictEqual(animationsPlayed, 1); // gate closed

        mock.flip("(prefers-reduced-motion: reduce)", false);
        assert.strictEqual(animationsPlayed, 2); // gate re-opened

        stop();
    });

    test("second call to shortcut returns same signal instance (memoized)", () => {
        const mock = makeMock();
        configure({ matchMedia: mock.matchMedia });
        assert.strictEqual(darkScheme(), darkScheme());
    });
});
