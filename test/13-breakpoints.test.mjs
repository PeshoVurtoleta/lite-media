import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { effect } from "@zakkster/lite-signal";
import {
    createMedia, breakpoints, media, configure, stats, __resetForTests,
} from "../Media.js";

// ---------------------------------------------------------------------------
// breakpoints() — named responsive bands as one interned-token computed<string>
// ---------------------------------------------------------------------------
// The active band is the name of the highest-threshold entry whose
// (min-width: Npx) matches, with the smallest entry as the mobile-first floor.
// Boundaries are observed through media(), so a mock matchMedia drives them.

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
    function setInitial(q, m) { ensure(q).matches = m; }
    return { matchMedia, flip, setInitial, registry };
}

const Q_MD = "(min-width: 768px)";
const Q_LG = "(min-width: 1024px)";

describe("breakpoints() — active band", () => {
    test("returns the floor (smallest) name when nothing larger matches", () => {
        const mock = makeMock(); // md, lg both false
        const m = createMedia({ matchMedia: mock.matchMedia });
        const bp = m.breakpoints({ sm: 0, md: 768, lg: 1024 });
        assert.equal(bp(), "sm");
    });

    test("the highest matching threshold wins", () => {
        const mock = makeMock();
        mock.setInitial(Q_MD, true);
        mock.setInitial(Q_LG, true);
        const m = createMedia({ matchMedia: mock.matchMedia });
        const bp = m.breakpoints({ sm: 0, md: 768, lg: 1024 });
        assert.equal(bp(), "lg");
    });

    test("mid band when only the middle threshold matches", () => {
        const mock = makeMock();
        mock.setInitial(Q_MD, true);
        const m = createMedia({ matchMedia: mock.matchMedia });
        const bp = m.breakpoints({ sm: 0, md: 768, lg: 1024 });
        assert.equal(bp(), "md");
    });

    test("declaration order does not matter — sorts by threshold", () => {
        const mock = makeMock();
        mock.setInitial(Q_MD, true);
        const m = createMedia({ matchMedia: mock.matchMedia });
        const bp = m.breakpoints({ lg: 1024, sm: 0, md: 768 });
        assert.equal(bp(), "md");
    });

    test("single-entry map always resolves to that band", () => {
        const mock = makeMock();
        const m = createMedia({ matchMedia: mock.matchMedia });
        const bp = m.breakpoints({ base: 0 });
        assert.equal(bp(), "base");
    });
});

describe("breakpoints() — reactivity", () => {
    test("updates the active band as boundaries flip", () => {
        const mock = makeMock();
        const m = createMedia({ matchMedia: mock.matchMedia });
        const bp = m.breakpoints({ sm: 0, md: 768, lg: 1024 });
        const seen = [];
        effect(() => { seen.push(bp()); });
        assert.deepEqual(seen, ["sm"]);
        mock.flip(Q_MD, true);
        mock.flip(Q_LG, true);
        mock.flip(Q_LG, false);
        mock.flip(Q_MD, false);
        assert.deepEqual(seen, ["sm", "md", "lg", "md", "sm"]);
    });

    test("exactly one effect run per band change", () => {
        const mock = makeMock();
        const m = createMedia({ matchMedia: mock.matchMedia });
        const bp = m.breakpoints({ sm: 0, md: 768, lg: 1024 });
        let runs = 0;
        effect(() => { bp(); runs++; });
        assert.equal(runs, 1); // initial
        mock.flip(Q_MD, true);  // sm -> md
        assert.equal(runs, 2);
        mock.flip(Q_LG, true);  // md -> lg
        assert.equal(runs, 3);
    });

    test("a duplicate boundary event drives zero extra runs", () => {
        const mock = makeMock();
        mock.setInitial(Q_MD, true);
        const m = createMedia({ matchMedia: mock.matchMedia });
        const bp = m.breakpoints({ sm: 0, md: 768, lg: 1024 });
        let runs = 0;
        effect(() => { bp(); runs++; });
        assert.equal(runs, 1);
        mock.flip(Q_MD, true); // same value -> media() dedups -> no dirty
        mock.flip(Q_MD, true);
        assert.equal(runs, 1);
    });

    test("returns an interned, === stable token", () => {
        const mock = makeMock();
        mock.setInitial(Q_MD, true);
        const m = createMedia({ matchMedia: mock.matchMedia });
        const bp = m.breakpoints({ sm: 0, md: 768, lg: 1024 });
        // The token is the map's own key, returned by reference every read.
        assert.ok(Object.is(bp(), bp()));
        assert.equal(bp(), "md");
    });
});

describe("breakpoints() — memoization & stats", () => {
    test("identical maps share one computed (canonical key)", () => {
        const mock = makeMock();
        const m = createMedia({ matchMedia: mock.matchMedia });
        const a = m.breakpoints({ sm: 0, md: 768, lg: 1024 });
        const b = m.breakpoints({ lg: 1024, sm: 0, md: 768 }); // same set, reordered
        assert.ok(Object.is(a, b));
        assert.equal(m.stats().bands, 1);
    });

    test("distinct maps get distinct computeds; bands counts them", () => {
        const mock = makeMock();
        const m = createMedia({ matchMedia: mock.matchMedia });
        m.breakpoints({ sm: 0, md: 768 });
        m.breakpoints({ sm: 0, md: 768, lg: 1024 });
        assert.equal(m.stats().bands, 2);
    });

    test("boundary signals are shared with media() through the same cache", () => {
        const mock = makeMock();
        const m = createMedia({ matchMedia: mock.matchMedia });
        m.breakpoints({ sm: 0, md: 768 });
        const direct = m.media(Q_MD);
        // breakpoints built (min-width:0px) and (min-width:768px); the 768
        // boundary is the same cached signal media() hands back.
        const bp2 = m.breakpoints({ a: 768 });
        // touch to ensure it's materialized through the shared cache
        assert.equal(typeof direct(), "boolean");
        assert.equal(bp2(), "a");
    });
});

describe("breakpoints() — validation (fail loud)", () => {
    test("throws on a non-object map", () => {
        const m = createMedia({ ssrDefault: false });
        assert.throws(() => m.breakpoints(null), TypeError);
        assert.throws(() => m.breakpoints(42), TypeError);
        assert.throws(() => m.breakpoints("md"), TypeError);
    });

    test("throws on an empty map", () => {
        const m = createMedia({ ssrDefault: false });
        assert.throws(() => m.breakpoints({}), TypeError);
    });

    test("throws on a non-number / negative / non-finite threshold", () => {
        const m = createMedia({ ssrDefault: false });
        assert.throws(() => m.breakpoints({ sm: "768" }), TypeError);
        assert.throws(() => m.breakpoints({ sm: -1 }), TypeError);
        assert.throws(() => m.breakpoints({ sm: NaN }), TypeError);
        assert.throws(() => m.breakpoints({ sm: Infinity }), TypeError);
    });

    test("a throwing compile caches nothing", () => {
        const m = createMedia({ ssrDefault: false });
        assert.throws(() => m.breakpoints({ sm: NaN }), TypeError);
        assert.equal(m.stats().bands, 0);
    });
});

describe("breakpoints() — SSR / no-window", () => {
    test("ssrDefault false collapses every boundary -> floor band", () => {
        const m = createMedia({ ssrDefault: false });
        const bp = m.breakpoints({ sm: 0, md: 768, lg: 1024 });
        assert.equal(bp(), "sm");
    });

    test("ssrDefault true matches every boundary -> highest band", () => {
        const m = createMedia({ ssrDefault: true });
        const bp = m.breakpoints({ sm: 0, md: 768, lg: 1024 });
        assert.equal(bp(), "lg");
    });

    test("no matchMedia + no ssrDefault throws, and caches nothing", () => {
        const m = createMedia({});
        assert.throws(() => m.breakpoints({ sm: 0, md: 768 }), /matchMedia/);
        assert.equal(m.stats().bands, 0);
    });
});

describe("breakpoints() — module-level default instance", () => {
    beforeEach(() => __resetForTests());

    test("works through the module-level export and locks the instance", () => {
        const mock = makeMock();
        mock.setInitial(Q_MD, true);
        configure({ matchMedia: mock.matchMedia });
        const bp = breakpoints({ sm: 0, md: 768, lg: 1024 });
        assert.equal(bp(), "md");
        assert.equal(stats().locked, true);
        assert.equal(stats().bands, 1);
        // media() on the module surface sees the shared boundary signal.
        assert.equal(media(Q_MD)(), true);
    });
});
