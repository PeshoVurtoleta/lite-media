import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createMedia, __resetForTests } from "../Media.js";

// createMedia instance isolation torture. Each Node --test subprocess starts
// fresh; this file's max concurrent signal count is ~400.

function makeMockMM() {
    const reg = new Map();
    return {
        matchMedia(q) {
            let e = reg.get(q);
            if (e === undefined) { e = { matches: false, listeners: new Set() }; reg.set(q, e); }
            return {
                get matches() { return e.matches; },
                addEventListener(t, h) { if (t === "change") e.listeners.add(h); },
                removeEventListener(t, h) { if (t === "change") e.listeners.delete(h); },
            };
        },
        flip(q, m) {
            const e = reg.get(q);
            if (e === undefined) return;
            e.matches = m;
            for (const h of e.listeners) h({ matches: m });
        },
        registrySize() { return reg.size; },
    };
}

describe("torture · isolation — many createMedia instances", () => {
    beforeEach(() => __resetForTests());

    test("30 createMedia instances × 6 queries each — total isolation", () => {
        const N_INST = 30, N_Q = 6;
        const insts = [];
        const mms = [];
        for (let i = 0; i < N_INST; i++) {
            const mm = makeMockMM();
            mms.push(mm);
            insts.push(createMedia({ matchMedia: mm.matchMedia }));
        }
        for (let i = 0; i < N_INST; i++) {
            for (let j = 0; j < N_Q; j++) insts[i].media(`(q${j})`);
        }
        for (let i = 0; i < N_INST; i++) {
            assert.strictEqual(insts[i].stats().watched, N_Q);
            assert.strictEqual(mms[i].registrySize(), N_Q);
        }
    });

    test("50 scoped createMedia() invocations — each returns fresh", () => {
        // Each scoped() creates 4 signals; if V8 GCs between iterations they
        // don't accumulate. If it doesn't, worst-case is 200 signals — still
        // safely under lite-signal's 1024 cap.
        function scoped() {
            const mm = makeMockMM();
            const inst = createMedia({ matchMedia: mm.matchMedia });
            for (let j = 0; j < 4; j++) inst.media(`(q${j})`);
            return inst.stats().watched;
        }
        for (let i = 0; i < 50; i++) {
            assert.strictEqual(scoped(), 4);
        }
    });
});
