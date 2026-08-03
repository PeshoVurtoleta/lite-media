import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { effect } from "@zakkster/lite-signal";
import {
    createMedia, configure, media, __resetForTests,
    reducedMotion, darkScheme, hoverCapable, coarsePointer,
    forcedColors, moreContrast, reducedData, reducedTransparency,
    standaloneDisplay, highDynamicRange,
} from "../Media.js";

// ---------------------------------------------------------------------------
// LM-01 -- the final two of the ten curated preference signals
// ---------------------------------------------------------------------------
// standaloneDisplay() => (display-mode: standalone)
// highDynamicRange()  => (dynamic-range: high)
// Same lazy-memoized, media()-delegating shape as the other eight.

function makeMock() {
    const registry = new Map();
    function ensure(q) {
        let e = registry.get(q);
        if (e === undefined) { e = { matches: false, listeners: new Set() }; registry.set(q, e); }
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
        if (e !== undefined) { e.matches = m; for (const h of e.listeners) h({ matches: m }); }
    }
    function setInitial(q, m) { ensure(q).matches = m; }
    return { matchMedia, flip, setInitial, registry };
}

const Q_STANDALONE = "(display-mode: standalone)";
const Q_HDR = "(dynamic-range: high)";

describe("LM-01 -- standaloneDisplay() & highDynamicRange()", () => {
    beforeEach(() => __resetForTests());

    test("map to the correct queries and reflect initial state", () => {
        const mock = makeMock();
        mock.setInitial(Q_STANDALONE, true);
        mock.setInitial(Q_HDR, true);
        configure({ matchMedia: mock.matchMedia });
        assert.equal(standaloneDisplay()(), true);
        assert.equal(highDynamicRange()(), true);
    });

    test("default to false when unmatched", () => {
        const mock = makeMock();
        configure({ matchMedia: mock.matchMedia });
        assert.equal(standaloneDisplay()(), false);
        assert.equal(highDynamicRange()(), false);
    });

    test("are reactive", () => {
        const mock = makeMock();
        configure({ matchMedia: mock.matchMedia });
        const seen = [];
        effect(() => { seen.push(standaloneDisplay()()); });
        mock.flip(Q_STANDALONE, true);
        mock.flip(Q_STANDALONE, false);
        assert.deepEqual(seen, [false, true, false]);
    });

    test("are lazily memoized -- same signal on repeat call", () => {
        const mock = makeMock();
        configure({ matchMedia: mock.matchMedia });
        assert.ok(Object.is(standaloneDisplay(), standaloneDisplay()));
        assert.ok(Object.is(highDynamicRange(), highDynamicRange()));
        // and === the direct media() signal for the same query
        assert.ok(Object.is(standaloneDisplay(), media(Q_STANDALONE)));
        assert.ok(Object.is(highDynamicRange(), media(Q_HDR)));
    });

    test("scoped instance exposes the same two methods", () => {
        const mock = makeMock();
        mock.setInitial(Q_HDR, true);
        const m = createMedia({ matchMedia: mock.matchMedia });
        assert.equal(m.standaloneDisplay()(), false);
        assert.equal(m.highDynamicRange()(), true);
        assert.ok(Object.is(m.highDynamicRange(), m.media(Q_HDR)));
    });

    test("all ten preference signals are exported and callable", () => {
        const mock = makeMock();
        configure({ matchMedia: mock.matchMedia });
        const ten = [
            reducedMotion, darkScheme, hoverCapable, coarsePointer,
            forcedColors, moreContrast, reducedData, reducedTransparency,
            standaloneDisplay, highDynamicRange,
        ];
        assert.equal(ten.length, 10);
        for (const pref of ten) {
            assert.equal(typeof pref, "function");
            assert.equal(typeof pref()(), "boolean");
        }
    });
});
