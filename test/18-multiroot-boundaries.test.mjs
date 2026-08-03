import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createMedia, __browserEngineForTests } from "../Media.js";

// ===========================================================================
// v1.4.0 QA pass -- boundary gaps the reviewer/planner did not pin with a test.
// Self-contained (no cross-import of another test file's mocks), same style
// as test/16 and test/17: a realm/DOM mock drives the REAL browser engine.
// ===========================================================================

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

function makeRealm() {
    const Sheet = makeSheetClass();
    const win = { CSSStyleSheet: Sheet, getComputedStyle: computedFor };
    const doc = {
        nodeType: 9,
        defaultView: win,
        ownerDocument: null,
        adoptedStyleSheets: [],
        createElement(_tag) { return makeSentinel(doc); },
    };
    return { win: win, doc: doc, Sheet: Sheet };
}

function makeShadowRoot(doc) {
    return { nodeType: 11, host: null, ownerDocument: doc, adoptedStyleSheets: [] };
}

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
function containerRules(sheet) { return sheet.rules.slice(1); }
function hasContainerRule(sheet, query) {
    for (let i = 0; i < sheet.rules.length; i += 1) {
        if (sheet.rules[i].indexOf("@container " + query) >= 0) return true;
    }
    return false;
}

// ===========================================================================
// 1. containerStyle() through a shadow root -- style() delegates to
//    containerMedia(); confirm the delegation ALSO lands in the correct root,
//    not just the size-query path test/16 already covers.
// ===========================================================================
describe("containerStyle() through a shadow root", () => {
    let realm;
    beforeEach(() => { constructions = 0; realm = makeRealm(); installEnv(realm); });
    afterEach(() => restoreEnv());

    test("style() rule lands in the shadow root's sheet, NOT the document", () => {
        const m = createMedia();
        const doc = globalThis.document;
        const shadow = makeShadowRoot(doc);
        const host = makeElement(shadow, doc);
        const sig = m.containerStyle(host, "--theme", "dark");
        assert.strictEqual(typeof sig, "function");
        // Control: this is exactly the failure mode of the pre-1.4.0 engine --
        // if containerStyle's delegation ever bypassed the per-root resolution
        // (e.g. by constructing its own sheet path instead of routing through
        // containerMedia), the document would hold the sheet instead.
        assert.strictEqual(doc.adoptedStyleSheets.length, 0, "document NOT touched");
        assert.strictEqual(shadow.adoptedStyleSheets.length, 1, "sheet in the shadow root");
        const sheet = shadow.adoptedStyleSheets[0];
        assert.ok(baseRuleOf(sheet).indexOf("--lm-v:off") >= 0, "base rule present");
        assert.ok(hasContainerRule(sheet, "style(--theme: dark)"), "style() @container rule present");
        assert.strictEqual(host.children.length, 1, "sentinel appended to host");
    });
});

// ===========================================================================
// 2. Two elements in the SAME shadow root sharing one query.
// ===========================================================================
describe("two elements, same shadow root, same query", () => {
    let realm;
    beforeEach(() => { constructions = 0; realm = makeRealm(); installEnv(realm); });
    afterEach(() => restoreEnv());

    test("one rule inserted, two independent sentinels, both flip", () => {
        const engine = __browserEngineForTests();
        const doc = globalThis.document;
        const shadow = makeShadowRoot(doc);
        const hostA = makeElement(shadow, doc);
        const hostB = makeElement(shadow, doc);
        const query = "(min-width: 500px)";
        let lastA = null;
        let lastB = null;
        const recA = engine.watch(hostA, query, (v) => { lastA = v; });
        const recB = engine.watch(hostB, query, (v) => { lastB = v; });

        assert.strictEqual(constructions, 1, "one sheet for the one shared root");
        const sheet = shadow.adoptedStyleSheets[0];
        assert.strictEqual(containerRules(sheet).length, 1, "one @container rule for the shared query");
        assert.strictEqual(hostA.children.length, 1, "hostA has its own sentinel");
        assert.strictEqual(hostB.children.length, 1, "hostB has its own sentinel");
        assert.notStrictEqual(hostA.children[0], hostB.children[0], "sentinels are independent nodes");
        assert.strictEqual(
            hostA.children[0].__attrs["data-q"], hostB.children[0].__attrs["data-q"],
            "both sentinels reference the SAME rule id");

        // Both flip independently (the browser would flip every sentinel bearing
        // this data-q under a matching container; we simulate each sentinel's
        // own transitionrun, matching how the real engine listens per-sentinel).
        hostA.children[0].__lmv = "on";
        hostA.children[0].__fire({ type: "transitionrun", propertyName: "--lm-v" });
        hostB.children[0].__lmv = "on";
        hostB.children[0].__fire({ type: "transitionrun", propertyName: "--lm-v" });
        assert.strictEqual(lastA, true, "hostA flipped");
        assert.strictEqual(lastB, true, "hostB flipped");

        // Control: the "one rule" assertion above is only meaningful if a
        // DISTINCT query in the same root DOES grow the rule count. Without
        // this, "1 rule" could just be a coincidence of the mock.
        const hostC = makeElement(shadow, doc);
        const recC = engine.watch(hostC, "(min-width: 999px)", () => {});
        assert.strictEqual(containerRules(sheet).length, 2,
            "a distinct query in the same root DOES add a new rule");

        recA.dispose();
        recB.dispose();
        recC.dispose();
    });
});

// ===========================================================================
// 3. Two elements in DIFFERENT shadow roots, same query string.
// ===========================================================================
describe("two elements, different shadow roots, same query", () => {
    let realm;
    beforeEach(() => { constructions = 0; realm = makeRealm(); installEnv(realm); });
    afterEach(() => restoreEnv());

    test("rule replicated into each root's sheet, no bleed into an uninvolved root", () => {
        const engine = __browserEngineForTests();
        const doc = globalThis.document;
        const s1 = makeShadowRoot(doc);
        const s2 = makeShadowRoot(doc);
        const s3 = makeShadowRoot(doc); // uninvolved -- the no-bleed control
        const h1 = makeElement(s1, doc);
        const h2 = makeElement(s2, doc);
        const h3 = makeElement(s3, doc);
        const query = "(min-width: 650px)";

        engine.watch(h1, query, () => {});
        engine.watch(h2, query, () => {});
        engine.watch(h3, "(min-width: 111px)", () => {}); // different query entirely

        assert.strictEqual(
            h1.children[0].__attrs["data-q"], h2.children[0].__attrs["data-q"],
            "same query -> same global id across roots");
        assert.ok(hasContainerRule(s1.adoptedStyleSheets[0], query), "rule present in root 1's sheet");
        assert.ok(hasContainerRule(s2.adoptedStyleSheets[0], query), "rule present in root 2's sheet");
        assert.strictEqual(
            hasContainerRule(s3.adoptedStyleSheets[0], query), false,
            "no bleed: root 3 never watched this query and must not carry its rule");
    });
});

// ===========================================================================
// 4. Light-DOM regression + no duplicate document sheet when mixed with
//    shadow-root usage on the SAME engine instance.
// ===========================================================================
describe("light-DOM regression under mixed multi-root usage", () => {
    let realm;
    beforeEach(() => { constructions = 0; realm = makeRealm(); installEnv(realm); });
    afterEach(() => restoreEnv());

    test("getRootNode() -> document still works and the document sheet is built exactly once", () => {
        const engine = __browserEngineForTests();
        const doc = globalThis.document;

        // Shadow-root usage FIRST, so the document sheet does not exist yet.
        const shadow = makeShadowRoot(doc);
        engine.watch(makeElement(shadow, doc), "(min-width: 200px)", () => {});
        assert.strictEqual(constructions, 1, "only the shadow root's sheet so far");
        assert.strictEqual(doc.adoptedStyleSheets.length, 0, "document sheet not built yet");

        // A light-DOM element whose getRootNode() resolves to the document.
        const lightEl = makeElement(doc, doc);
        engine.watch(lightEl, "(min-width: 300px)", () => {});
        assert.strictEqual(constructions, 2, "document sheet built exactly once, on first light-DOM use");
        assert.strictEqual(doc.adoptedStyleSheets.length, 1, "document adopted its own sheet");

        // A second light-DOM element (same or different query) must reuse it --
        // NOT build a second document sheet.
        const lightEl2 = makeElement(doc, doc);
        engine.watch(lightEl2, "(min-width: 300px)", () => {});
        assert.strictEqual(constructions, 2, "no second document sheet on re-watch");
        assert.strictEqual(doc.adoptedStyleSheets.length, 1, "document still holds exactly one sheet");

        // Control: the flat count above is only meaningful if a genuinely NEW
        // root still grows it -- proving `constructions` isn't just stuck.
        const shadow2 = makeShadowRoot(doc);
        engine.watch(makeElement(shadow2, doc), "(min-width: 400px)", () => {});
        assert.strictEqual(constructions, 3, "a genuinely new root still grows the sheet count");
    });
});

// ===========================================================================
// 5. Idempotent dispose (double-dispose safe) on the multi-root path.
// ===========================================================================
describe("idempotent dispose on the multi-root path", () => {
    let realm;
    beforeEach(() => { constructions = 0; realm = makeRealm(); installEnv(realm); });
    afterEach(() => restoreEnv());

    test("a second dispose() call is a safe no-op", () => {
        const engine = __browserEngineForTests();
        const doc = globalThis.document;
        const shadow = makeShadowRoot(doc);
        const host = makeElement(shadow, doc);
        const rec = engine.watch(host, "(min-width: 700px)", () => {});
        const sentinel = host.children[0];

        rec.dispose();
        assert.strictEqual(sentinel.parentNode, null, "sentinel detached after first dispose");
        assert.strictEqual(host.children.length, 0);
        assert.strictEqual(sentinel.__listeners.length, 0, "listener detached after first dispose");

        assert.doesNotThrow(() => rec.dispose(), "second dispose() must not throw");
        assert.strictEqual(host.children.length, 0, "still detached after the second dispose");
        assert.strictEqual(sentinel.__listeners.length, 0, "still no listeners after the second dispose");

        // Control: proves the `sentinel.parentNode !== null` guard inside
        // dispose() is load-bearing. An unconditional second removeChild call --
        // exactly what a missing-guard dispose() would attempt -- throws here,
        // because parentNode is already null (mirrors a real DOM NotFoundError
        // / null-deref on a double removeChild).
        assert.throws(() => { sentinel.parentNode.removeChild(sentinel); }, TypeError);
    });
});

// ===========================================================================
// 6. Non-goal (documented, not invented): an element that MOVES roots after
//    being watched. containerMedia()/containerStyle() memoize per (el, query)
//    in a WeakMap keyed by the element and resolve the root ONCE, on first
//    watch (getRootState() memoizes per-root state in a WeakMap the engine
//    owns, and the disposer/sentinel are bound to the ORIGINAL root's sheet).
//    Nothing in Media.js re-resolves the root on a later call -- a re-parented
//    element keeps its existing sentinel + signal wired to the root it was
//    FIRST watched under. This package makes no claim about behavior after a
//    host element is moved to a different root (e.g. adoptNode / re-appended
//    into a different shadow root) -- untested, and deliberately not asserted
//    here so as not to invent a contract; see QA report for the recommendation
//    to record this explicitly in CHANGELOG/README non-goals.
// ===========================================================================

// ===========================================================================
// 7. Fail-closed boundary matrix beyond what test/16 already covers: cases
//    where resolveRoot()/getRootState() must degrade to stuck-false, never
//    throw, distinguishing the "no DOM touched" inert-stub path (state.doc
//    === null) from the "DOM touched, sheet null" path (a real doc/root that
//    simply cannot be styled).
// ===========================================================================
describe("fail-closed: no styleable root at all (state.doc === null, no DOM touch)", () => {
    let realm;
    beforeEach(() => { constructions = 0; realm = makeRealm(); installEnv(realm); });
    afterEach(() => restoreEnv());

    test("el with no getRootNode() and no ownerDocument -> stuck false, no DOM touch", () => {
        const engine = __browserEngineForTests();
        const el = { nodeType: 1, parentElement: null, children: [],
            appendChild(c) { this.children.push(c); return c; } };
        let result;
        assert.doesNotThrow(() => { result = engine.watch(el, "(min-width: 400px)", () => {}); });
        assert.strictEqual(result.initial, false, "stuck-false verdict");
        assert.strictEqual(el.children.length, 0, "no sentinel appended -- inert stub");
        assert.doesNotThrow(() => result.dispose());
    });

    test("el.getRootNode() returns null -> stuck false, no DOM touch", () => {
        const engine = __browserEngineForTests();
        const el = { nodeType: 1, children: [],
            getRootNode() { return null; },
            appendChild(c) { this.children.push(c); return c; } };
        let result;
        assert.doesNotThrow(() => { result = engine.watch(el, "(min-width: 400px)", () => {}); });
        assert.strictEqual(result.initial, false);
        assert.strictEqual(el.children.length, 0);
    });

    test("el.getRootNode() returns a primitive -> stuck false, no DOM touch", () => {
        const engine = __browserEngineForTests();
        const el = { nodeType: 1, children: [],
            getRootNode() { return 42; },
            appendChild(c) { this.children.push(c); return c; } };
        let result;
        assert.doesNotThrow(() => { result = engine.watch(el, "(min-width: 400px)", () => {}); });
        assert.strictEqual(result.initial, false);
        assert.strictEqual(el.children.length, 0);
    });

    test("el.getRootNode() returns a foreign object with no nodeType/ownerDocument -> stuck false", () => {
        const engine = __browserEngineForTests();
        const foreignRoot = { someUnrelatedField: true }; // not a Document, not a ShadowRoot
        const el = { nodeType: 1, children: [],
            getRootNode() { return foreignRoot; },
            appendChild(c) { this.children.push(c); return c; } };
        let result;
        assert.doesNotThrow(() => { result = engine.watch(el, "(min-width: 400px)", () => {}); });
        assert.strictEqual(result.initial, false);
        assert.strictEqual(el.children.length, 0, "no DOM touched for an unstyleable foreign root");
    });

    // Control: contrast with a genuinely styleable root (same describe-block
    // realm), proving the four cases above are actually exercising the
    // fail-closed path and not merely a broken mock that never appends.
    test("control: a genuinely styleable root DOES get a sentinel", () => {
        const engine = __browserEngineForTests();
        const doc = globalThis.document;
        const el = makeElement(doc, doc);
        const result = engine.watch(el, "(min-width: 400px)", () => {});
        assert.strictEqual(el.children.length, 1, "a real root DOES receive a sentinel");
        result.dispose();
    });
});

describe("fail-closed: root exists but cannot be fully styled (DOM touched, verdict stuck false)", () => {
    beforeEach(() => { constructions = 0; });
    afterEach(() => restoreEnv());

    test("foreign document with no defaultView -> sheet null, sentinel still appended, stuck false", () => {
        // installEnv() makes `realm.doc` the GLOBAL document (globalThis.document).
        // `detachedDoc` is a DIFFERENT document object (e.g. a cross-realm iframe
        // document with no defaultView) that the watched element resolves to via
        // getRootNode(). Load-bearing distinction (Media.js:249-257): the
        // "global CSSStyleSheet fallback" is allowed ONLY when the resolved root's
        // own document === globalThis.document -- never for a foreign document --
        // so this must fail closed even though a global CSSStyleSheet ctor exists.
        const realm = makeRealm();
        installEnv(realm);
        const detachedDoc = {
            nodeType: 9, defaultView: null, ownerDocument: null,
            adoptedStyleSheets: [],
            createElement(_t) { return makeSentinel(detachedDoc); },
        };
        assert.notStrictEqual(detachedDoc, globalThis.document, "sanity: a genuinely foreign document");
        const engine = __browserEngineForTests();
        const el = makeElement(detachedDoc, detachedDoc);
        let result;
        assert.doesNotThrow(() => { result = engine.watch(el, "(min-width: 400px)", () => {}); });
        assert.strictEqual(result.initial, false, "no styleable realm -> stuck false");
        assert.strictEqual(detachedDoc.adoptedStyleSheets.length, 0, "no sheet adopted");
        assert.strictEqual(el.children.length, 1, "sentinel STILL appended (doc exists, just unstyled)");

        // Control: the SAME foreign document object, but WITH a defaultView
        // carrying its own CSSStyleSheet ctor, DOES get styled -- proving the
        // missing defaultView (not something else about the mock) caused the
        // fail-closed path above.
        const frame = makeRealm();
        const el2 = makeElement(frame.doc, frame.doc);
        engine.watch(el2, "(min-width: 400px)", () => {});
        assert.strictEqual(frame.doc.adoptedStyleSheets.length, 1,
            "control: a foreign doc WITH its own defaultView.CSSStyleSheet gets styled");
    });

    test("root has no adoptedStyleSheets support -> sheet null, sentinel appended, stuck false", () => {
        const realm = makeRealm();
        installEnv(realm);
        delete realm.doc.adoptedStyleSheets; // "adoptedStyleSheets" in root === false
        const engine = __browserEngineForTests();
        const el = makeElement(realm.doc, realm.doc);
        let result;
        assert.doesNotThrow(() => { result = engine.watch(el, "(min-width: 400px)", () => {}); });
        assert.strictEqual(result.initial, false);
        assert.strictEqual(constructions, 0, "no sheet constructed -- adoption support absent");
        assert.strictEqual(el.children.length, 1, "sentinel still appended");
    });

    test("throwing sheet construction -> sheet null, no throw to caller, sentinel appended", () => {
        const realm = makeRealm();
        class ThrowingSheet {
            constructor() { throw new Error("construct failed"); }
        }
        realm.win.CSSStyleSheet = ThrowingSheet;
        installEnv({ doc: realm.doc, Sheet: ThrowingSheet });
        globalThis.CSSStyleSheet = ThrowingSheet;
        const engine = __browserEngineForTests();
        const el = makeElement(realm.doc, realm.doc);
        let result;
        assert.doesNotThrow(() => { result = engine.watch(el, "(min-width: 400px)", () => {}); });
        assert.strictEqual(result.initial, false);
        assert.strictEqual(realm.doc.adoptedStyleSheets.length, 0, "nothing adopted");
        assert.strictEqual(el.children.length, 1, "sentinel still appended");

        // Control: the SAME realm shape with a non-throwing ctor DOES build +
        // adopt a sheet, proving the throw above is what caused the fail-closed
        // path, not some unrelated mock defect.
        const goodRealm = makeRealm();
        installEnv(goodRealm);
        const goodEngine = __browserEngineForTests();
        const goodEl = makeElement(goodRealm.doc, goodRealm.doc);
        goodEngine.watch(goodEl, "(min-width: 400px)", () => {});
        assert.strictEqual(goodRealm.doc.adoptedStyleSheets.length, 1, "control: sheet built + adopted");
    });

    test("throwing replaceSync -> sheet null, adoptedStyleSheets untouched, sentinel appended", () => {
        const realm = makeRealm();
        class ThrowingReplaceSheet {
            constructor() { this.rules = []; this.cssRules = this.rules; }
            replaceSync() { throw new Error("replaceSync failed"); }
            insertRule(r, i) { this.rules.splice(i, 0, r); return i; }
        }
        realm.win.CSSStyleSheet = ThrowingReplaceSheet;
        installEnv({ doc: realm.doc, Sheet: ThrowingReplaceSheet });
        globalThis.CSSStyleSheet = ThrowingReplaceSheet;
        const engine = __browserEngineForTests();
        const el = makeElement(realm.doc, realm.doc);
        let result;
        assert.doesNotThrow(() => { result = engine.watch(el, "(min-width: 400px)", () => {}); });
        assert.strictEqual(result.initial, false);
        assert.strictEqual(realm.doc.adoptedStyleSheets.length, 0,
            "adoption never runs -- the throw happens before `root.adoptedStyleSheets = ...`");
        assert.strictEqual(el.children.length, 1, "sentinel still appended");
    });

    test("throwing adoptedStyleSheets setter (non-cross-realm reason) -> sheet null, sentinel appended", () => {
        const realm = makeRealm();
        Object.defineProperty(realm.doc, "adoptedStyleSheets", {
            configurable: true,
            get() { return []; },
            set() { throw new Error("adoption rejected"); },
        });
        installEnv(realm);
        const engine = __browserEngineForTests();
        const el = makeElement(realm.doc, realm.doc);
        let result;
        assert.doesNotThrow(() => { result = engine.watch(el, "(min-width: 400px)", () => {}); });
        assert.strictEqual(result.initial, false);
        assert.strictEqual(el.children.length, 1, "sentinel still appended");
    });

    test("throwing getComputedStyle -> verdict stuck false via FALSE_READER, no throw", () => {
        const realm = makeRealm();
        installEnv(realm);
        globalThis.getComputedStyle = () => { throw new Error("getComputedStyle failed"); };
        realm.win.getComputedStyle = () => { throw new Error("getComputedStyle failed"); };
        const engine = __browserEngineForTests();
        const el = makeElement(realm.doc, realm.doc);
        let result;
        assert.doesNotThrow(() => { result = engine.watch(el, "(min-width: 400px)", () => {}); });
        assert.strictEqual(result.initial, false, "cold-swapped to the constant-false reader");
        assert.strictEqual(el.children.length, 1, "sentinel still appended -- the rule/sheet ARE fine");
        assert.strictEqual(realm.doc.adoptedStyleSheets.length, 1, "sheet still adopted normally");
        assert.doesNotThrow(() => result.dispose());
    });
});
