import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { effect } from "@zakkster/lite-signal";
import {
    createMedia, configure, darkScheme,
    __resetForTests, __pageshowForTests, __browserEngineForTests,
} from "../Media.js";

// ===========================================================================
// v1.4.1 -- bfcache / pageshow lifecycle. A page restored from the back/forward
// cache does NOT re-fire matchMedia `change` or container `transitionrun`, so a
// signal can sit stale against a verdict that changed while the page was frozen.
// The resync path re-reads every mql.matches (Engine A) and every live sentinel
// verdict (Engine B) on a persisted pageshow and re-pushes the fresh boolean.
// Self-contained mocks, same style as test/16-18: no cross-import.
// ===========================================================================

// A matchMedia mock whose state can be mutated SILENTLY -- i.e. WITHOUT firing a
// `change` event. That silent mutation is exactly what a bfcache freeze does:
// the OS/viewport verdict moves while the page is suspended, and no event is
// delivered until (and unless) something re-reads it.
function makeMM() {
    const state = new Map();
    const mm = (q) => ({
        get matches() { return state.get(q) === true; },
        addEventListener() {},
        removeEventListener() {},
    });
    return { mm, set(q, v) { state.set(q, v); } };
}

// ---------------------------------------------------------------------------
// Engine A -- the default module-level instance, driven through the real
// __pageshowForTests seam (which runs the exact gated listener body).
// ---------------------------------------------------------------------------
describe("Engine A bfcache: default instance via __pageshowForTests", () => {
    beforeEach(() => __resetForTests());
    afterEach(() => __resetForTests());

    test("a stale verdict snaps to correct on a persisted pageshow", () => {
        const { mm, set } = makeMM();
        configure({ matchMedia: mm });
        const Q = "(prefers-color-scheme: dark)";
        set(Q, false);
        const sig = darkScheme();
        assert.strictEqual(sig.peek(), false, "initial verdict");

        // Verdict flips while the page is frozen -- no `change` event delivered.
        set(Q, true);
        assert.strictEqual(sig.peek(), false, "still stale before restore");

        // An ORDINARY navigation pageshow must NOT resync (nothing went stale).
        __pageshowForTests(false);
        assert.strictEqual(sig.peek(), false, "non-persisted pageshow is a no-op");

        // A bfcache restore re-pins the fresh verdict.
        __pageshowForTests(true);
        assert.strictEqual(sig.peek(), true, "persisted pageshow re-pins the fresh verdict");
    });
});

// ---------------------------------------------------------------------------
// Engine A -- exact effect-run accounting on restore.
// ---------------------------------------------------------------------------
describe("Engine A bfcache: unchanged restore fires 0 runs, mutated fires 1", () => {
    test("run counts are exact", () => {
        const { mm, set } = makeMM();
        const m = createMedia({ matchMedia: mm });
        const Q = "(min-width: 600px)";
        set(Q, false);
        const sig = m.media(Q);
        let runs = 0;
        effect(() => { runs += 1; sig(); });
        const base = runs; // 1 on creation

        // Unchanged state: resync re-pushes the SAME value, sig.set dedups it.
        m._resync();
        assert.strictEqual(runs, base, "unchanged restore fires exactly 0 downstream runs");

        // Now the verdict genuinely changed while frozen.
        set(Q, true);
        m._resync();
        assert.strictEqual(runs, base + 1, "mutated restore fires exactly 1 downstream run");
        assert.strictEqual(sig.peek(), true);

        // A second unchanged resync is again a no-op.
        m._resync();
        assert.strictEqual(runs, base + 1, "a follow-up unchanged restore fires 0 more runs");
    });
});

// ---------------------------------------------------------------------------
// Instance isolation -- A's restore must never touch B.
// ---------------------------------------------------------------------------
describe("bfcache: instance A resync leaves instance B untouched", () => {
    test("A's resync does not move B's verdict or run count", () => {
        const A = makeMM();
        const B = makeMM();
        const mA = createMedia({ matchMedia: A.mm });
        const mB = createMedia({ matchMedia: B.mm });
        const Q = "(min-width: 700px)";
        A.set(Q, false);
        B.set(Q, false);
        const sA = mA.media(Q);
        const sB = mB.media(Q);
        let runsB = 0;
        effect(() => { runsB += 1; sB(); });
        const baseB = runsB;

        // Only A's underlying state changes while frozen.
        A.set(Q, true);
        mA._resync();

        assert.strictEqual(sA.peek(), true, "A picked up its own change");
        assert.strictEqual(sB.peek(), false, "B's verdict untouched by A's resync");
        assert.strictEqual(runsB, baseB, "B's effect run count unchanged by A's resync (delta 0)");
    });
});

// ---------------------------------------------------------------------------
// SSR / no-DOM -- the resync path must never throw off-DOM.
// ---------------------------------------------------------------------------
describe("bfcache: SSR / no-DOM resync never throws", () => {
    test("ssrDefault instance resync + pageshow are safe no-ops", () => {
        const m = createMedia({ ssrDefault: false });
        const s = m.media("(min-width: 300px)"); // ssrDefault path: no mql, none tracked
        assert.doesNotThrow(() => m._resync());
        assert.doesNotThrow(() => m._pageshow(true));
        assert.doesNotThrow(() => m._pageshow(false));
        assert.strictEqual(s.peek(), false, "ssrDefault verdict unchanged");
    });

    test("a throwing mql.matches getter is fail-closed per entry, never aborts the loop", () => {
        const state = new Map();
        let armed = false; // becomes hostile only AFTER both signals are created
        const mm = (q) => ({
            get matches() {
                if (armed && q === "(bad)") throw new Error("hostile matches getter");
                return state.get(q) === true;
            },
            addEventListener() {}, removeEventListener() {},
        });
        const m = createMedia({ matchMedia: mm });
        state.set("(good)", false);
        const good = m.media("(good)");
        m.media("(bad)"); // reads fine at creation; its getter turns hostile below
        armed = true;
        state.set("(good)", true); // silent change

        // The throwing entry must not abort resync of the good one, nor throw out.
        assert.doesNotThrow(() => m._resync());
        assert.strictEqual(good.peek(), true, "the good signal still resynced past the throwing one");
    });
});

// ---------------------------------------------------------------------------
// The real listener: attaches at most once per instance, gates on persisted.
// ---------------------------------------------------------------------------
describe("bfcache: pageshow listener attaches once, gates on persisted", () => {
    let saved;
    let hadIt;
    beforeEach(() => { hadIt = "addEventListener" in globalThis; saved = globalThis.addEventListener; });
    afterEach(() => { if (hadIt) globalThis.addEventListener = saved; else delete globalThis.addEventListener; });

    test("one listener across many cold calls; only persisted fires resync", () => {
        const handlers = [];
        globalThis.addEventListener = (type, h) => { if (type === "pageshow") handlers.push(h); };
        const { mm, set } = makeMM();
        const m = createMedia({ matchMedia: mm });
        const Q1 = "(min-width: 100px)";
        const Q2 = "(min-width: 200px)";
        set(Q1, false);
        set(Q2, false);
        const s1 = m.media(Q1);
        const s2 = m.media(Q2);
        m.media(Q1); // cache hit -- must NOT add another listener
        assert.strictEqual(handlers.length, 1, "exactly one pageshow listener for the instance");

        set(Q1, true);
        set(Q2, true);
        handlers[0]({ persisted: false }); // ordinary pageshow through the REAL handler
        assert.strictEqual(s1.peek(), false, "non-persisted pageshow no-op (real listener)");

        handlers[0]({ persisted: true }); // bfcache restore through the REAL handler
        assert.strictEqual(s1.peek(), true, "persisted pageshow resynced s1");
        assert.strictEqual(s2.peek(), true, "persisted pageshow resynced s2");

        // A malformed event object must be a safe no-op, not a throw.
        assert.doesNotThrow(() => handlers[0](undefined));
        assert.doesNotThrow(() => handlers[0]({}));
    });
});

// ---------------------------------------------------------------------------
// Engine B -- container verdicts re-pinned through the real browser engine.
// ---------------------------------------------------------------------------
function makeSheetClass() {
    return class Sheet {
        constructor() { this.rules = []; this.cssRules = this.rules; }
        replaceSync(t) { this.rules.length = 0; this.rules.push(t); }
        insertRule(r, i) { this.rules.splice(i, 0, r); return i; }
    };
}
function computedFor(node) {
    if (node.__cs !== undefined) return node.__cs;
    const cs = {
        getPropertyValue(p) {
            if (p === "container-type") return "inline-size";
            if (p === "--lm-v") return node.__lmv === undefined ? "off" : node.__lmv;
            return "";
        },
    };
    node.__cs = cs;
    return cs;
}
function makeSentinel(doc) {
    const listeners = [];
    return {
        nodeType: 1, ownerDocument: doc, className: "", parentNode: null,
        __attrs: {}, __lmv: "off", __listeners: listeners,
        setAttribute(k, v) { this.__attrs[k] = v; },
        addEventListener(t, h) { listeners.push({ t, h }); },
        removeEventListener(t, h) {
            for (let i = 0; i < listeners.length; i += 1) {
                if (listeners[i].t === t && listeners[i].h === h) { listeners.splice(i, 1); return; }
            }
        },
    };
}
function makeRealm() {
    const Sheet = makeSheetClass();
    const win = { CSSStyleSheet: Sheet, getComputedStyle: computedFor };
    const doc = {
        nodeType: 9, defaultView: win, ownerDocument: null, adoptedStyleSheets: [],
        createElement() { return makeSentinel(doc); },
    };
    return { win, doc, Sheet };
}
function makeShadowRoot(doc) { return { nodeType: 11, host: null, ownerDocument: doc, adoptedStyleSheets: [] }; }
function makeElement(root, doc) {
    return {
        nodeType: 1, ownerDocument: doc, parentElement: null, children: [], __root: root,
        getRootNode() { return this.__root; },
        appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
        removeChild(c) {
            const i = this.children.indexOf(c);
            if (i >= 0) this.children.splice(i, 1);
            c.parentNode = null; return c;
        },
    };
}
let savedDocument, savedCSSStyleSheet, savedGetComputedStyle, savedCSS;
function installEnv(realm) {
    savedDocument = globalThis.document;
    savedCSSStyleSheet = globalThis.CSSStyleSheet;
    savedGetComputedStyle = globalThis.getComputedStyle;
    savedCSS = globalThis.CSS;
    globalThis.document = realm.doc;
    globalThis.CSSStyleSheet = realm.Sheet;
    globalThis.getComputedStyle = computedFor;
    globalThis.CSS = { registerProperty() {} };
}
function restoreEnv() {
    try { globalThis.document = savedDocument; }
    finally {
        try { globalThis.CSSStyleSheet = savedCSSStyleSheet; }
        finally {
            try { globalThis.getComputedStyle = savedGetComputedStyle; }
            finally { globalThis.CSS = savedCSS; }
        }
    }
}

describe("Engine B bfcache: container verdict re-pinned on resync()", () => {
    let realm;
    beforeEach(() => { realm = makeRealm(); installEnv(realm); });
    afterEach(() => restoreEnv());

    test("engine.resync() re-reads a verdict that changed while frozen", () => {
        const engine = __browserEngineForTests();
        const doc = globalThis.document;
        const shadow = makeShadowRoot(doc);
        const host = makeElement(shadow, doc);
        let last = null;
        const rec = engine.watch(host, "(min-width: 400px)", (v) => { last = v; });
        assert.strictEqual(rec.initial, false, "initial verdict off");
        const sentinel = host.children[0];

        // Container crossed the breakpoint while the page was frozen -- no
        // transitionrun was delivered; --lm-v is now "on".
        sentinel.__lmv = "on";
        engine.resync();
        assert.strictEqual(last, true, "resync re-pins the fresh container verdict");

        // Unchanged resync re-pushes the same boolean (dedup is the signal's job).
        engine.resync();
        assert.strictEqual(last, true, "unchanged resync keeps the verdict");
    });

    test("a disposed watcher is removed from the live set -- resync never touches it", () => {
        const engine = __browserEngineForTests();
        const doc = globalThis.document;
        const shadow = makeShadowRoot(doc);
        const host = makeElement(shadow, doc);
        let last = null;
        const rec = engine.watch(host, "(min-width: 400px)", (v) => { last = v; });
        const sentinel = host.children[0];

        rec.dispose();
        sentinel.__lmv = "on"; // would have flipped it, but the watcher is gone
        assert.doesNotThrow(() => engine.resync());
        assert.strictEqual(last, null, "resync did not call a disposed watcher's onChange");
    });

    test("a throwing verdict read is fail-closed per entry, never aborts the loop", () => {
        const engine = __browserEngineForTests();
        const doc = globalThis.document;
        const shadow = makeShadowRoot(doc);
        const hostBad = makeElement(shadow, doc);
        const hostGood = makeElement(shadow, doc);
        let lastGood = null;
        engine.watch(hostBad, "(min-width: 400px)", () => {});
        engine.watch(hostGood, "(min-width: 500px)", (v) => { lastGood = v; });

        // Make the bad sentinel's computed style throw on read.
        const badSentinel = hostBad.children[0];
        badSentinel.__cs = { getPropertyValue() { throw new Error("hostile getComputedStyle"); } };
        hostGood.children[0].__lmv = "on";

        assert.doesNotThrow(() => engine.resync());
        assert.strictEqual(lastGood, true, "the good watcher resynced past the throwing one");
    });
});
