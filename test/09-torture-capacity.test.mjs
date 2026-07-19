import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { media, configure, __resetForTests } from "../Media.js";

// This file exists SOLELY to verify lite-signal's node-budget overflow
// surfaces as a named CapacityError (not silent corruption). It is in its
// own file because the test intentionally exhausts the budget, poisoning
// the subprocess for anything else.

function makeMockMM() {
    return {
        matchMedia() { return { matches: false, addEventListener() {} }; },
    };
}

describe("torture · capacity — overflow surfaces cleanly", () => {
    test("creating past lite-signal's node cap throws a named CapacityError", () => {
        __resetForTests();
        configure({ matchMedia: makeMockMM().matchMedia });
        assert.throws(() => {
            // Push well past 1024 — will throw at ~1024, not silently corrupt.
            for (let i = 0; i < 2000; i++) media(`(overflow: ${i}px)`);
        }, (err) => {
            // Message should mention capacity in some form. We don't hard-
            // code the exact lite-signal wording to avoid a brittle coupling,
            // but the error type must be clearly diagnostic.
            const msg = String(err && err.message);
            const name = String(err && err.name);
            return /capacity/i.test(msg) || /capacity/i.test(name);
        });
    });
});
