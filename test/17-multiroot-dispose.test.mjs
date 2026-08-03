import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { __browserEngineForTests } from "../Media.js";

// ===========================================================================
// Interleaved create/dispose across the document + >=4 shadow roots.
// ===========================================================================
// Contract proven here:
//   - each root's sheet ends with exactly its ever-seen rules (RETAINED on
//     dispose, per the roots-bounds invariant),
//   - no cross-root bleed (a root's sheet never carries another root's query),
//   - every sentinel is removed from its host and every listener detached,
//   - --lm-v is registered exactly once across all roots.
// The mock is inlined (self-contained, like test/04's makeMockEngine) so this
// file never cross-imports another test file's describe() blocks.

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
let mainRealm;

function installEnv() {
    savedDocument = globalThis.document;
    savedCSSStyleSheet = globalThis.CSSStyleSheet;
    savedGetComputedStyle = globalThis.getComputedStyle;
    savedCSS = globalThis.CSS;
    registerCalls = [];
    mainRealm = makeRealm();
    globalThis.document = mainRealm.doc;
    globalThis.CSSStyleSheet = mainRealm.Sheet;
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

function containerRules(sheet) {
    const out = [];
    for (let i = 1; i < sheet.rules.length; i += 1) out.push(sheet.rules[i]);
    return out;
}
function ruleMatchesQuery(rule, query) { return rule.indexOf("@container " + query) >= 0; }

describe("browser engine -- interleaved multi-root create/dispose", () => {
    beforeEach(() => { constructions = 0; installEnv(); });
    afterEach(() => restoreEnv());

    test("retained per-root sheets, no bleed, every sentinel + listener cleaned", () => {
        const engine = __browserEngineForTests();
        const doc = mainRealm.doc;
        const s1 = makeShadowRoot(doc);
        const s2 = makeShadowRoot(doc);
        const s3 = makeShadowRoot(doc);
        const s4 = makeShadowRoot(doc);
        // Each root's query vocabulary. Overlap across roots is deliberate (shared
        // global ids); a query absent from a root must never appear in its sheet.
        const rootDefs = [
            { root: doc, queries: ["(min-width: 100px)", "(min-width: 200px)"] },
            { root: s1, queries: ["(min-width: 100px)"] },
            { root: s2, queries: ["(min-width: 300px)", "(min-width: 400px)"] },
            { root: s3, queries: ["(min-width: 200px)"] },
            { root: s4, queries: ["(min-width: 500px)"] },
        ];

        const all = [];   // every watcher created, for the final cleanup audit
        const window = []; // sliding window for interleaving dispose with create

        function watchOn(root, query) {
            const host = makeElement(root, doc);
            const rec = engine.watch(host, query, () => {});
            all.push({ host: host, sentinel: host.children[0], dispose: rec.dispose });
            window.push(all[all.length - 1]);
        }

        // Interleave: several cycles, disposing an older watcher between creates.
        for (let cycle = 0; cycle < 3; cycle += 1) {
            for (let r = 0; r < rootDefs.length; r += 1) {
                const def = rootDefs[r];
                for (let q = 0; q < def.queries.length; q += 1) {
                    watchOn(def.root, def.queries[q]);
                    if (window.length >= 3) {
                        const old = window.shift();
                        old.dispose();
                    }
                }
            }
        }
        while (window.length > 0) window.shift().dispose();

        // (1) Exactly one sheet per root, --lm-v registered once.
        assert.strictEqual(constructions, rootDefs.length, "one sheet per root");
        assert.strictEqual(registerCalls.length, 1, "--lm-v registered exactly once");

        // (2) Retained rules, no cross-root bleed.
        for (let r = 0; r < rootDefs.length; r += 1) {
            const def = rootDefs[r];
            const sheet = def.root.adoptedStyleSheets[0];
            const distinct = [];
            for (let q = 0; q < def.queries.length; q += 1) {
                if (distinct.indexOf(def.queries[q]) < 0) distinct.push(def.queries[q]);
            }
            const rules = containerRules(sheet);
            assert.strictEqual(rules.length, distinct.length,
                "root keeps exactly its ever-seen @container rules (retained)");
            for (let q = 0; q < distinct.length; q += 1) {
                let found = false;
                for (let k = 0; k < rules.length; k += 1) {
                    if (ruleMatchesQuery(rules[k], distinct[q])) { found = true; break; }
                }
                assert.ok(found, "root's own query present after dispose");
            }
            // No bleed: every rule maps to one of this root's own queries.
            for (let k = 0; k < rules.length; k += 1) {
                let owned = false;
                for (let q = 0; q < distinct.length; q += 1) {
                    if (ruleMatchesQuery(rules[k], distinct[q])) { owned = true; break; }
                }
                assert.ok(owned, "no cross-root rule bleed: " + rules[k]);
            }
        }

        // (3) Every sentinel removed from its host, every listener detached.
        for (let i = 0; i < all.length; i += 1) {
            const w = all[i];
            assert.strictEqual(w.sentinel.parentNode, null, "sentinel detached from host");
            assert.strictEqual(w.host.children.length, 0, "host has no sentinel left");
            assert.strictEqual(w.sentinel.__listeners.length, 0, "listener detached");
        }
    });

    test("re-watch after full dispose reuses the retained sheet (no rebuild)", () => {
        const engine = __browserEngineForTests();
        const doc = mainRealm.doc;
        const shadow = makeShadowRoot(doc);

        const h1 = makeElement(shadow, doc);
        const w1 = engine.watch(h1, "(min-width: 400px)", () => {});
        w1.dispose();
        assert.strictEqual(constructions, 1);
        const rulesAfterFirst = containerRules(shadow.adoptedStyleSheets[0]).length;

        // The last watcher disposed, but the sheet + its rule are retained.
        const h2 = makeElement(shadow, doc);
        const w2 = engine.watch(h2, "(min-width: 400px)", () => {});
        assert.strictEqual(constructions, 1, "no new sheet built on re-watch");
        assert.strictEqual(shadow.adoptedStyleSheets.length, 1, "no duplicate adoption");
        assert.strictEqual(
            containerRules(shadow.adoptedStyleSheets[0]).length, rulesAfterFirst,
            "rule not re-inserted (id already seen for this root)");
        w2.dispose();
        assert.strictEqual(h2.children.length, 0);
    });
});
