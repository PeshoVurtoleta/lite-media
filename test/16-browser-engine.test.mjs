import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { effect } from "@zakkster/lite-signal";
import { createMedia, __browserEngineForTests } from "../Media.js";

// ===========================================================================
// Realm / DOM mock harness -- browserless exercise of the browser engine.
// ===========================================================================
// detectDefaultContainerEngine() gates on globalThis.document (an object with
// createElement), globalThis.CSSStyleSheet (a function), and "adoptedStyleSheets"
// in document. We install those in beforeEach and restore in afterEach, so a
// scoped createMedia() with no engine resolves to the real makeBrowserContainer-
// Engine. __browserEngineForTests() returns a fresh engine directly for the
// watch/dispose-level assertions that need the disposer (there is no public
// container-dispose API -- the same @internal-seam pattern as __flipForTests).

// One shared counter: every constructed sheet bumps it, so "one sheet per root"
// is a single number to assert.
let constructions = 0;

function makeSheetClass() {
    return class Sheet {
        constructor() {
            constructions += 1;
            this.rules = [];
            this.cssRules = this.rules; // SAME array: insertRule reads cssRules.length
        }
        replaceSync(t) { this.rules.length = 0; this.rules.push(t); }
        insertRule(r, i) { this.rules.splice(i, 0, r); return i; }
    };
}

// Cached per node so a verdict read allocates nothing (the 0-B tier depends on
// this). container-type resolves to inline-size so warnIfNoQueryContainer stays
// silent; --lm-v reads the node's live verdict.
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
        nodeType: 1,
        ownerDocument: doc,
        className: "",
        parentNode: null,
        __attrs: {},
        __lmv: "off",
        __listeners: listeners,
        setAttribute(k, v) { this.__attrs[k] = v; },
        addEventListener(type, h) { listeners.push({ type: type, h: h }); },
        removeEventListener(type, h) {
            for (let i = 0; i < listeners.length; i += 1) {
                if (listeners[i].type === type && listeners[i].h === h) {
                    listeners.splice(i, 1);
                    return;
                }
            }
        },
        __fire(evt) {
            const copy = listeners.slice();
            for (let i = 0; i < copy.length; i += 1) {
                if (copy[i].type === evt.type) copy[i].h(evt);
            }
        },
    };
}

// A realm: its own window (with its own CSSStyleSheet ctor + getComputedStyle)
// and document. The hostile variant's adoptedStyleSheets setter throws unless
// every adopted member is instanceof this realm's Sheet -- the cross-realm guard.
function makeRealm(hostile) {
    const Sheet = makeSheetClass();
    const win = { CSSStyleSheet: Sheet, getComputedStyle: computedFor };
    const doc = {
        nodeType: 9,
        defaultView: win,
        ownerDocument: null,
        createElement(_tag) { return makeSentinel(doc); },
    };
    installAdopted(doc, Sheet, hostile);
    return { win: win, doc: doc, Sheet: Sheet };
}

function installAdopted(node, Sheet, hostile) {
    if (!hostile) { node.adoptedStyleSheets = []; return; }
    let backing = [];
    Object.defineProperty(node, "adoptedStyleSheets", {
        configurable: true,
        get() { return backing; },
        set(v) {
            for (let i = 0; i < v.length; i += 1) {
                if (!(v[i] instanceof Sheet)) {
                    throw new TypeError("wrong-realm sheet adopted");
                }
            }
            backing = v;
        },
    });
}

function makeShadowRoot(doc, Sheet, hostile) {
    const root = { nodeType: 11, host: null, ownerDocument: doc };
    installAdopted(root, Sheet, hostile);
    return root;
}

// An element whose getRootNode() returns __root (document or shadow root).
function makeElement(root, doc) {
    return {
        nodeType: 1,
        ownerDocument: doc,
        parentElement: null,
        children: [],
        __root: root,
        getRootNode() { return this.__root; },
        appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
        removeChild(c) {
            const i = this.children.indexOf(c);
            if (i >= 0) this.children.splice(i, 1);
            c.parentNode = null;
            return c;
        },
    };
}

// --- global environment install / restore ---------------------------------
let savedDocument;
let savedCSSStyleSheet;
let savedGetComputedStyle;
let savedCSS;
let registerCalls;

function installEnv(realm) {
    savedDocument = globalThis.document;
    savedCSSStyleSheet = globalThis.CSSStyleSheet;
    savedGetComputedStyle = globalThis.getComputedStyle;
    savedCSS = globalThis.CSS;
    registerCalls = [];
    globalThis.document = realm.doc;
    globalThis.CSSStyleSheet = realm.Sheet;
    globalThis.getComputedStyle = computedFor;
    globalThis.CSS = { registerProperty(d) { registerCalls.push(d); } };
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

function baseRuleOf(sheet) { return sheet.rules[0]; }
function hasContainerRule(sheet, query) {
    for (let i = 0; i < sheet.rules.length; i += 1) {
        if (sheet.rules[i].indexOf("@container " + query) >= 0) return true;
    }
    return false;
}

// ===========================================================================
// DOCUMENT-root assertions (regression floor -- pass on the unmodified engine).
// ===========================================================================
describe("browser engine -- document root (regression floor)", () => {
    beforeEach(() => { constructions = 0; installEnv(makeRealm(false)); });
    afterEach(() => restoreEnv());

    test("adopts exactly one sheet into the document, registers --lm-v once", () => {
        const m = createMedia();
        const doc = globalThis.document;
        const el = makeElement(doc, doc);
        const sig = m.containerMedia(el, "(min-width: 400px)");
        assert.strictEqual(typeof sig, "function");
        assert.strictEqual(constructions, 1, "exactly one sheet constructed");
        assert.strictEqual(doc.adoptedStyleSheets.length, 1, "sheet adopted into document");
        assert.strictEqual(registerCalls.length, 1, "--lm-v registered exactly once");
        assert.strictEqual(registerCalls[0].name, "--lm-v");
    });

    test("sheet carries the base rule and the @container rule", () => {
        const m = createMedia();
        const doc = globalThis.document;
        const el = makeElement(doc, doc);
        m.containerMedia(el, "(min-width: 400px)");
        const sheet = doc.adoptedStyleSheets[0];
        assert.ok(baseRuleOf(sheet).indexOf("--lm-v:off") >= 0, "base rule present");
        assert.ok(hasContainerRule(sheet, "(min-width: 400px)"), "@container rule present");
    });

    test("appends a configured sentinel to the element", () => {
        const m = createMedia();
        const doc = globalThis.document;
        const el = makeElement(doc, doc);
        m.containerMedia(el, "(min-width: 400px)");
        assert.strictEqual(el.children.length, 1);
        const sentinel = el.children[0];
        assert.strictEqual(sentinel.className, "__lm-s");
        assert.strictEqual(sentinel.__attrs["data-q"], "1");
        assert.strictEqual(sentinel.parentNode, el);
    });

    test("transitionrun on the sentinel propagates a verdict flip", () => {
        const m = createMedia();
        const doc = globalThis.document;
        const el = makeElement(doc, doc);
        const sig = m.containerMedia(el, "(min-width: 400px)");
        let last = null;
        const stop = effect(() => { last = sig(); });
        assert.strictEqual(last, false, "initial verdict false");
        const sentinel = el.children[0];
        sentinel.__lmv = "on";
        sentinel.__fire({ type: "transitionrun", propertyName: "--lm-v" });
        assert.strictEqual(last, true, "flip observed");
        stop();
    });

    test("a second query reuses the same root sheet (no new construction)", () => {
        const m = createMedia();
        const doc = globalThis.document;
        const el = makeElement(doc, doc);
        m.containerMedia(el, "(min-width: 400px)");
        m.containerMedia(el, "(min-width: 800px)");
        assert.strictEqual(constructions, 1, "still one sheet for the one root");
        assert.strictEqual(doc.adoptedStyleSheets.length, 1);
        assert.strictEqual(registerCalls.length, 1, "--lm-v still registered once");
        const sheet = doc.adoptedStyleSheets[0];
        assert.ok(hasContainerRule(sheet, "(min-width: 400px)"));
        assert.ok(hasContainerRule(sheet, "(min-width: 800px)"));
    });
});

// ===========================================================================
// SHADOW-root: the multi-root fix. Sheet lands in the shadow root, not the doc.
// ===========================================================================
describe("browser engine -- shadow root", () => {
    let realm;
    beforeEach(() => { constructions = 0; realm = makeRealm(false); installEnv(realm); });
    afterEach(() => restoreEnv());

    test("adopts the sheet into the shadow root, NOT the document", () => {
        const engine = __browserEngineForTests();
        const doc = realm.doc;
        const shadow = makeShadowRoot(doc, realm.Sheet, false);
        const host = makeElement(shadow, doc);
        const { initial } = engine.watch(host, "(min-width: 400px)", () => {});
        assert.strictEqual(initial, false);
        // Load-bearing control: the pre-1.4.0 engine adopted into the document.
        // If that regressed, `doc` would hold the sheet and `shadow` would be
        // empty -- both assertions below would fail.
        assert.strictEqual(doc.adoptedStyleSheets.length, 0, "document NOT touched");
        assert.strictEqual(shadow.adoptedStyleSheets.length, 1, "sheet in the shadow root");
        const sheet = shadow.adoptedStyleSheets[0];
        assert.ok(baseRuleOf(sheet).indexOf("--lm-v:off") >= 0, "base rule present");
        assert.ok(hasContainerRule(sheet, "(min-width: 400px)"), "@container rule present");
        assert.strictEqual(host.children.length, 1, "realm-correct sentinel on host");
    });

    test("verdict flips inside the shadow root", () => {
        const engine = __browserEngineForTests();
        const shadow = makeShadowRoot(realm.doc, realm.Sheet, false);
        const host = makeElement(shadow, realm.doc);
        let last = null;
        const { initial, dispose } =
            engine.watch(host, "(min-width: 400px)", (v) => { last = v; });
        assert.strictEqual(initial, false);
        const sentinel = host.children[0];
        sentinel.__lmv = "on";
        sentinel.__fire({ type: "transitionrun", propertyName: "--lm-v" });
        assert.strictEqual(last, true);
        dispose();
    });
});

// ===========================================================================
// CROSS-realm / iframe: the sheet is built in the ROOT's own realm.
// ===========================================================================
describe("browser engine -- cross-realm / iframe", () => {
    let mainRealm;
    beforeEach(() => { constructions = 0; mainRealm = makeRealm(false); installEnv(mainRealm); });
    afterEach(() => restoreEnv());

    test("constructs the sheet in the element's OWN realm and adopts without throwing", () => {
        const engine = __browserEngineForTests();
        const frame = makeRealm(true); // hostile foreign realm: rejects wrong-realm sheets
        const shadow = makeShadowRoot(frame.doc, frame.Sheet, true);
        const host = makeElement(shadow, frame.doc);
        // Adoption into the hostile realm succeeds ONLY because the sheet was
        // constructed with frame.Sheet (the root's realm), not the global ctor.
        assert.doesNotThrow(() => engine.watch(host, "(min-width: 400px)", () => {}));
        assert.strictEqual(shadow.adoptedStyleSheets.length, 1);
        assert.ok(shadow.adoptedStyleSheets[0] instanceof frame.Sheet,
            "sheet belongs to the frame realm");
    });

    test("control: a wrong-realm (global) sheet IS rejected by the hostile realm", () => {
        // Proves the realm accessor is load-bearing: had the engine used the
        // global CSSStyleSheet (the main realm's ctor) for a foreign root, the
        // hostile adoptedStyleSheets setter would throw exactly like this.
        const frame = makeRealm(true);
        const shadow = makeShadowRoot(frame.doc, frame.Sheet, true);
        const wrongSheet = new mainRealm.Sheet(); // main realm ctor, not the frame's
        assert.throws(() => { shadow.adoptedStyleSheets = [wrongSheet]; }, TypeError);
    });

    test("a foreign realm with no CSSStyleSheet fails closed (stuck false, no throw)", () => {
        const engine = __browserEngineForTests();
        const doc = {
            nodeType: 9, defaultView: {}, ownerDocument: null,
            adoptedStyleSheets: [], createElement() { return makeSentinel(doc); },
        };
        const shadow = { nodeType: 11, host: null, ownerDocument: doc, adoptedStyleSheets: [] };
        const host = makeElement(shadow, doc);
        let result;
        assert.doesNotThrow(() => { result = engine.watch(host, "(min-width: 400px)", () => {}); });
        assert.strictEqual(result.initial, false, "stuck-false verdict");
        assert.strictEqual(shadow.adoptedStyleSheets.length, 0, "no wrong-realm sheet adopted");
    });
});

// ===========================================================================
// Invariants across N roots: one property, one sheet per root, shared ids.
// ===========================================================================
describe("browser engine -- invariants across N roots", () => {
    let realm;
    beforeEach(() => { constructions = 0; realm = makeRealm(false); installEnv(realm); });
    afterEach(() => restoreEnv());

    test("--lm-v is registered exactly once across N distinct roots", () => {
        const engine = __browserEngineForTests();
        const doc = realm.doc;
        const N = 5;
        for (let i = 0; i < N; i += 1) {
            const shadow = makeShadowRoot(doc, realm.Sheet, false);
            const host = makeElement(shadow, doc);
            engine.watch(host, "(min-width: 400px)", () => {});
        }
        // Control: a per-root property registration would give N here. The
        // registry is global, so it must be exactly 1 no matter how many roots.
        assert.strictEqual(registerCalls.length, 1, "one --lm-v registration");
        assert.strictEqual(registerCalls[0].name, "--lm-v");
    });

    test("exactly one sheet per root, reused across queries and re-watches", () => {
        const engine = __browserEngineForTests();
        const doc = realm.doc;
        const N = 4;
        const shadows = [];
        for (let i = 0; i < N; i += 1) {
            const shadow = makeShadowRoot(doc, realm.Sheet, false);
            shadows.push(shadow);
            const host = makeElement(shadow, doc);
            engine.watch(host, "(min-width: 400px)", () => {});
        }
        assert.strictEqual(constructions, N, "one sheet per root");
        // Re-watch every root with a new query and the same query again: no new
        // sheet is built. Control: a per-watch build would grow `constructions`.
        for (let i = 0; i < N; i += 1) {
            const host2 = makeElement(shadows[i], doc);
            engine.watch(host2, "(min-width: 800px)", () => {});
            engine.watch(host2, "(min-width: 400px)", () => {});
        }
        assert.strictEqual(constructions, N, "still one sheet per root after re-watch");
        for (let i = 0; i < N; i += 1) {
            assert.strictEqual(shadows[i].adoptedStyleSheets.length, 1);
            const sheet = shadows[i].adoptedStyleSheets[0];
            assert.ok(hasContainerRule(sheet, "(min-width: 400px)"));
            assert.ok(hasContainerRule(sheet, "(min-width: 800px)"));
        }
    });

    test("the same query shares its data-q id across roots (identical selector)", () => {
        const engine = __browserEngineForTests();
        const doc = realm.doc;
        const s1 = makeShadowRoot(doc, realm.Sheet, false);
        const s2 = makeShadowRoot(doc, realm.Sheet, false);
        const h1 = makeElement(s1, doc);
        const h2 = makeElement(s2, doc);
        engine.watch(h1, "(min-width: 400px)", () => {});
        engine.watch(h2, "(min-width: 400px)", () => {});
        assert.strictEqual(
            h1.children[0].__attrs["data-q"], h2.children[0].__attrs["data-q"],
            "one stable id per query string across roots");
    });
});
