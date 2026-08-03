import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createMedia } from "../Media.js";

// ---------------------------------------------------------------------------
// LM-02 -- the container-type: normal footgun warning
// ---------------------------------------------------------------------------
// The warning lives on the cold containerMedia() materialization path, reads
// the watched element's computed container-type via getComputedStyle, and
// warns once per element when neither it nor any ancestor establishes a query
// container. Dev-only: silent under NODE_ENV=production. Never mutates.
//
// We drive it without a real DOM by stubbing globalThis.getComputedStyle and
// passing a mock container engine, so this exercises the exact production code
// path (the check is engine-independent -- it runs before engine.watch).

// A mock element: `ct` is its computed container-type; `parent` is its
// parentElement (null at the root).
function elem(ct, parent) {
    return { __ct: ct, parentElement: parent === undefined ? null : parent };
}

// Inert engine -- the warning runs before this is touched.
function inertEngine() {
    return { watch() { return { initial: false, dispose() {} }; } };
}

let savedGCS;
let savedWarn;
let savedEnv;
let warnings;

function installGetComputedStyle() {
    globalThis.getComputedStyle = (node) => ({
        getPropertyValue(prop) {
            if (prop !== "container-type") return "";
            return (node && typeof node.__ct === "string") ? node.__ct : "normal";
        },
    });
}

describe("LM-02 -- container-type footgun warning", () => {
    beforeEach(() => {
        savedGCS = globalThis.getComputedStyle;
        savedWarn = console.warn;
        savedEnv = process.env.NODE_ENV;
        warnings = [];
        console.warn = (...args) => { warnings.push(args); };
        delete process.env.NODE_ENV; // ensure dev (not production)
        installGetComputedStyle();
    });

    afterEach(() => {
        globalThis.getComputedStyle = savedGCS;
        console.warn = savedWarn;
        if (savedEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = savedEnv;
    });

    test("warns when the element computes container-type: normal", () => {
        const m = createMedia({ containerEngine: inertEngine() });
        m.containerMedia(elem("normal"), "(min-width: 400px)");
        assert.equal(warnings.length, 1);
        const [msg, el] = warnings[0];
        assert.match(msg, /container-type is 'normal'/);
        assert.match(msg, /\(min-width: 400px\)/); // names the offending query
        assert.match(msg, /container-type: size/);  // names the fix
        assert.ok(el && el.__ct === "normal");       // passes the element itself
    });

    test("does NOT warn when the element itself is a query container", () => {
        const m = createMedia({ containerEngine: inertEngine() });
        m.containerMedia(elem("inline-size"), "(min-width: 400px)");
        m.containerMedia(elem("size"), "(min-width: 400px)");
        assert.equal(warnings.length, 0);
    });

    test("does NOT warn when an ANCESTOR establishes a query container", () => {
        const root = elem("size");
        const mid = elem("normal", root);
        const leaf = elem("normal", mid);
        const m = createMedia({ containerEngine: inertEngine() });
        m.containerMedia(leaf, "(min-width: 400px)");
        assert.equal(warnings.length, 0);
    });

    test("warns at most once per element, across different queries", () => {
        const m = createMedia({ containerEngine: inertEngine() });
        const el = elem("normal");
        m.containerMedia(el, "(min-width: 400px)");
        m.containerMedia(el, "(min-width: 800px)");
        m.containerMedia(el, "(orientation: landscape)");
        assert.equal(warnings.length, 1);
    });

    test("warns separately for distinct offending elements", () => {
        const m = createMedia({ containerEngine: inertEngine() });
        m.containerMedia(elem("normal"), "(min-width: 400px)");
        m.containerMedia(elem("normal"), "(min-width: 400px)");
        assert.equal(warnings.length, 2);
    });

    test("is silent under NODE_ENV=production", () => {
        process.env.NODE_ENV = "production";
        const m = createMedia({ containerEngine: inertEngine() });
        m.containerMedia(elem("normal"), "(min-width: 400px)");
        assert.equal(warnings.length, 0);
    });

    test("is silent off-DOM (no getComputedStyle)", () => {
        globalThis.getComputedStyle = undefined;
        const m = createMedia({ containerEngine: inertEngine() });
        m.containerMedia(elem("normal"), "(min-width: 400px)");
        assert.equal(warnings.length, 0);
    });

    test("stays silent if getComputedStyle throws (foreign/detached node)", () => {
        globalThis.getComputedStyle = () => { throw new Error("detached"); };
        const m = createMedia({ containerEngine: inertEngine() });
        m.containerMedia(elem("normal"), "(min-width: 400px)");
        assert.equal(warnings.length, 0);
    });

    test("does not mutate the watched element", () => {
        const m = createMedia({ containerEngine: inertEngine() });
        const el = elem("normal");
        const before = JSON.stringify(el.__ct);
        m.containerMedia(el, "(min-width: 400px)");
        assert.equal(JSON.stringify(el.__ct), before); // container-type untouched
    });
});
