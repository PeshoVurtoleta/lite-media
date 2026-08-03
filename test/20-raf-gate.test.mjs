import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { effect, onCleanup, dispose } from "@zakkster/lite-signal";
import { createMedia } from "../Media.js";

// ---------------------------------------------------------------------------
// 1.5.0 -- reduced-motion rAF gate (Option A ecosystem recipe under test)
// ---------------------------------------------------------------------------
// This file PROVES the recipe lite-media 1.5.0 documents for consumers that are
// already in the lite-signal graph: gate a requestAnimationFrame loop on
// reducedMotion() via a single effect. Media.js is unchanged -- the recipe uses
// only the shipped surface (createMedia().reducedMotion() + effect + onCleanup +
// dispose). raf/cancel are INJECTED counters (a fake scheduler), never
// globalThis-patched: a global patch would hide the SSR / no-rAF fail-closed path
// this recipe is meant to document.

const Q_RM = "(prefers-reduced-motion: reduce)";

// A multi-query matchMedia mock with a live-flippable verdict per query.
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
        const e = ensure(q);
        if (e.matches === m) return;
        e.matches = m;
        for (const h of e.listeners) h({ matches: m });
    }
    function setInitial(q, m) { ensure(q).matches = m; }
    return { matchMedia, flip, setInitial };
}

// A single-slot fake rAF scheduler. The recipe schedules exactly one frame at a
// time (the loop reschedules itself), so one pending slot is faithful. Counters
// are plain integers -- zero allocation per raf/cancel/tick.
function makeScheduler() {
    let rafCount = 0;
    let cancelCount = 0;
    let nextId = 0;
    let pendingId = -1;
    let pendingCb = null;
    return {
        raf(cb) { rafCount += 1; nextId += 1; pendingId = nextId; pendingCb = cb; return nextId; },
        cancel(id) { cancelCount += 1; if (id === pendingId) { pendingId = -1; pendingCb = null; } },
        tick() { const cb = pendingCb; pendingId = -1; pendingCb = null; if (cb) cb(); },
        pending() { return pendingCb !== null; },
        rafs() { return rafCount; },
        cancels() { return cancelCount; },
    };
}

// The recipe, verbatim, as a local helper. `reducedMotion` is the memoized
// MediaSignal read INSIDE the effect body (so the dependency is tracked); `raf`
// and `cancel` are injected. Returns the effect dispose handle plus a frame
// counter and the current pending-frame id (for assertions).
function makeGate(reducedMotion, sched, onFrame) {
    let id = 0;
    let frames = 0;
    function loop() { frames += 1; if (onFrame) onFrame(); id = sched.raf(loop); }
    const stop = effect(() => {
        if (reducedMotion()) { sched.cancel(id); return; }
        id = sched.raf(loop);
        onCleanup(() => sched.cancel(id));
    });
    return { stop, frames: () => frames };
}

describe("1.5.0 -- reduced-motion rAF gate recipe", () => {
    let mock;
    let m;
    let sched;
    beforeEach(() => {
        mock = makeMock();
        m = createMedia({ matchMedia: mock.matchMedia });
        sched = makeScheduler();
    });

    test("reduced-motion OFF at creation schedules exactly one frame", () => {
        const rm = m.reducedMotion();
        const g = makeGate(rm, sched);
        assert.equal(sched.rafs(), 1, "one frame scheduled on start");
        assert.equal(sched.cancels(), 0, "nothing cancelled");
        assert.ok(sched.pending(), "a frame is in flight");
        g.stop();
    });

    test("reduced-motion ON at creation schedules NO frame (fail-closed to still)", () => {
        mock.setInitial(Q_RM, true);
        const rm = m.reducedMotion();
        const g = makeGate(rm, sched);
        assert.equal(sched.rafs(), 0, "no frame scheduled while reduced-motion is on");
        assert.ok(!sched.pending(), "no frame in flight");
        g.stop();
    });

    test("loop advances only while a frame is pending (self-rescheduling)", () => {
        const rm = m.reducedMotion();
        const g = makeGate(rm, sched);
        assert.equal(g.frames(), 0);
        sched.tick();
        assert.equal(g.frames(), 1, "one tick runs one frame");
        sched.tick();
        assert.equal(g.frames(), 2, "loop rescheduled itself");
        g.stop();
    });

    test("flip ON parks the loop: cancel fires, no further raf, ticks are inert", () => {
        const rm = m.reducedMotion();
        const g = makeGate(rm, sched);
        const rafsBefore = sched.rafs();
        mock.flip(Q_RM, true); // park
        assert.ok(sched.cancels() >= 1, "parking cancelled the in-flight frame");
        assert.equal(sched.rafs(), rafsBefore, "parking scheduled no new frame");
        assert.ok(!sched.pending(), "no orphaned frame callback while parked");
        const framesBefore = g.frames();
        for (let i = 0; i < 1000; i += 1) sched.tick();
        assert.equal(g.frames(), framesBefore, "0 frames run while parked");
        g.stop();
    });

    test("flip OFF after a park resumes the loop", () => {
        const rm = m.reducedMotion();
        const g = makeGate(rm, sched);
        mock.flip(Q_RM, true);  // park
        const rafsParked = sched.rafs();
        mock.flip(Q_RM, false); // resume
        assert.equal(sched.rafs(), rafsParked + 1, "resume scheduled one new frame");
        assert.ok(sched.pending(), "a frame is in flight again");
        const before = g.frames();
        sched.tick();
        assert.equal(g.frames(), before + 1, "the resumed loop advances");
        g.stop();
    });

    test("full OFF->ON->OFF->ON->OFF transition sequence", () => {
        const rm = m.reducedMotion();
        const g = makeGate(rm, sched);
        assert.equal(sched.rafs(), 1);      // OFF at start -> 1
        mock.flip(Q_RM, true);              // park
        assert.equal(sched.rafs(), 1);      // no new frame
        mock.flip(Q_RM, false);             // resume -> 2
        assert.equal(sched.rafs(), 2);
        mock.flip(Q_RM, true);              // park
        assert.equal(sched.rafs(), 2);
        mock.flip(Q_RM, false);             // resume -> 3
        assert.equal(sched.rafs(), 3);
        g.stop();
    });

    test("dispose() tears the loop down: onCleanup cancels, no orphaned frame", () => {
        const rm = m.reducedMotion();
        const g = makeGate(rm, sched);
        assert.ok(sched.pending(), "frame in flight before dispose");
        const cancelsBefore = sched.cancels();
        g.stop(); // dispose the effect -> onCleanup fires
        assert.equal(sched.cancels(), cancelsBefore + 1, "onCleanup cancelled the in-flight frame");
        assert.ok(!sched.pending(), "no orphaned frame callback after dispose");
        // A flip after dispose must not resurrect the loop.
        const rafsAfter = sched.rafs();
        mock.flip(Q_RM, true);
        mock.flip(Q_RM, false);
        assert.equal(sched.rafs(), rafsAfter, "a disposed gate schedules no frames");
        dispose(rm);
    });

    test("dispose while parked is safe (no throw, no orphaned frame)", () => {
        mock.setInitial(Q_RM, true);
        const rm = m.reducedMotion();
        const g = makeGate(rm, sched);
        assert.ok(!sched.pending());
        g.stop(); // reduced branch registered no onCleanup; must still be safe
        assert.ok(!sched.pending(), "still nothing pending after disposing a parked gate");
        dispose(rm);
    });

    test("duplicate reduced-motion events do not re-park or re-schedule", () => {
        const rm = m.reducedMotion();
        const g = makeGate(rm, sched);
        mock.flip(Q_RM, true);           // real park
        const cancels = sched.cancels();
        const rafs = sched.rafs();
        for (let i = 0; i < 100; i += 1) mock.flip(Q_RM, true); // all duplicates (no-op)
        assert.equal(sched.cancels(), cancels, "duplicate ON events cancel nothing new");
        assert.equal(sched.rafs(), rafs, "duplicate ON events schedule nothing");
        g.stop();
    });
});
