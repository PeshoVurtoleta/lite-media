import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { media, configure, __resetForTests } from "../Media.js";

// A guard: if some test host provides `globalThis.matchMedia`, tests that
// depend on its absence aren't meaningful. Node itself does not, but
// jsdom-injecting harnesses might. Detect and skip.
const HAS_NATIVE_MATCH_MEDIA = typeof globalThis.matchMedia === "function";

describe("configure() -- input handling", () => {
    beforeEach(() => __resetForTests());

    test("null / undefined args are safe no-ops", () => {
        assert.doesNotThrow(() => configure(null));
        assert.doesNotThrow(() => configure(undefined));
    });

    test("non-object args are safe no-ops", () => {
        assert.doesNotThrow(() => configure(42));
        assert.doesNotThrow(() => configure("nope"));
        assert.doesNotThrow(() => configure(true));
    });

    test("empty object is a no-op (does not lock, does not throw)", () => {
        configure({});
        assert.doesNotThrow(() => configure({ ssrDefault: true }));
    });

    test("non-function matchMedia throws TypeError with a helpful message", () => {
        // A misspelled import (`someMisspelledImport`) is the failure mode
        // this catches -- silently dropping it would surface later as
        // "no matchMedia available," which points the developer nowhere.
        assert.throws(
            () => configure({ matchMedia: "not-a-function" }),
            (err) => err instanceof TypeError && /matchMedia.*must be a function/i.test(err.message)
        );
        assert.throws(
            () => configure({ matchMedia: 42 }),
            TypeError
        );
        assert.throws(
            () => configure({ matchMedia: null }),
            TypeError
        );
    });

    test("configure({ ssrDefault: undefined }) does NOT un-set a previous default", () => {
        configure({ ssrDefault: false });
        configure({ ssrDefault: undefined }); // must be a no-op, not a reset
        assert.strictEqual(media("(any)")(), false);
    });

    test("configure({ ssrDefault: 'truthy' }) is a no-op (non-boolean rejected quietly)", () => {
        // The public contract is boolean; anything else is ignored. This
        // matches the spirit of "later calls override only the keys they
        // set" -- a non-boolean isn't a legitimate set.
        configure({ ssrDefault: "yes" });
        if (!HAS_NATIVE_MATCH_MEDIA) {
            assert.throws(() => media("(any)"), /no matchMedia/i);
        }
    });
});

describe("configure() -- SSR default", () => {
    beforeEach(() => __resetForTests());

    test("ssrDefault: true -- signals return true when no matchMedia", () => {
        configure({ ssrDefault: true });
        assert.strictEqual(media("(any)")(), true);
    });

    test("ssrDefault: false -- signals return false when no matchMedia", () => {
        configure({ ssrDefault: false });
        assert.strictEqual(media("(any)")(), false);
    });

    test(
        "no config + no native matchMedia -> media() throws with a helpful message",
        { skip: HAS_NATIVE_MATCH_MEDIA },
        () => {
            assert.throws(
                () => media("(any)"),
                /no matchMedia|configure\(/i,
                "error should mention matchMedia and configure() so the fix is obvious"
            );
        }
    );

    test(
        "failed materialization does NOT lock -- configure() and retry works",
        { skip: HAS_NATIVE_MATCH_MEDIA },
        () => {
            // This is the specific bug the v1.0.0 review caught: a stray
            // media() on a cold path (import-time SSR, missing shim, etc.)
            // used to brick the module for the process lifetime.
            assert.throws(() => media("(any)"), /no matchMedia/i);
            assert.doesNotThrow(() => configure({ ssrDefault: false }));
            assert.strictEqual(media("(any)")(), false);
        }
    );
});

describe("configure() -- lock semantics", () => {
    beforeEach(() => __resetForTests());

    test("reconfigure after successful materialization throws", () => {
        configure({ ssrDefault: false });
        media("(any)"); // successful materialization -> lock engages
        assert.throws(
            () => configure({ ssrDefault: true }),
            /before the first successful media/i
        );
    });

    test("multiple configure() calls before lock compose (later overrides)", () => {
        configure({ ssrDefault: false });
        configure({ ssrDefault: true }); // later overrides earlier
        assert.strictEqual(media("(any)")(), true);
    });

    test("matchMedia + ssrDefault set independently; matchMedia wins when both present", () => {
        configure({
            matchMedia: () => ({ matches: true, addEventListener() {} }),
        });
        configure({ ssrDefault: false });
        // matchMedia is resolvable, so ssrDefault is irrelevant.
        assert.strictEqual(media("(any)")(), true);
    });
});

describe("configure() -- matchMedia factory contract", () => {
    beforeEach(() => __resetForTests());

    test("factory called with the query string", () => {
        const seen = [];
        configure({
            matchMedia(query) {
                seen.push(query);
                return { matches: false, addEventListener() {} };
            },
        });
        media("(hello)");
        media("(world)");
        media("(hello)"); // cache hit, factory not called again
        assert.deepStrictEqual(seen, ["(hello)", "(world)"]);
    });

    test("factory's returned MQL's `matches` sets the initial signal value", () => {
        configure({
            matchMedia: (q) => ({
                matches: q === "(yes)",
                addEventListener() {},
            }),
        });
        assert.strictEqual(media("(yes)")(), true);
        assert.strictEqual(media("(no)")(),  false);
    });

    test("factory returning object without addEventListener throws helpful TypeError", () => {
        // Shorthand mocks like `() => ({ matches: true })` are a common
        // typo-adjacent mistake. The v1.0.0 review caught that they used to
        // surface as a raw `TypeError: mql.addEventListener is not a
        // function` with no mention of lite-media. Now the error names the
        // MockMediaQueryList shape.
        configure({
            matchMedia: () => ({ matches: true }),
        });
        assert.throws(
            () => media("(any)"),
            (err) => err instanceof TypeError && /addEventListener|MockMediaQueryList/i.test(err.message)
        );
    });

    test("factory returning null throws helpful TypeError", () => {
        configure({ matchMedia: () => null });
        assert.throws(
            () => media("(any)"),
            (err) => err instanceof TypeError && /addEventListener|MockMediaQueryList/i.test(err.message)
        );
    });
});
