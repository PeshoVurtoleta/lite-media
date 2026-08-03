/**
 * @zakkster/lite-media -- benchmark suite
 *
 * Machine-stamped, warm-up-then-measure, multi-run with IQR spread flag.
 * Prints a spec-style table + machine-readable JSON summary. The JSON
 * summary is the source of truth for README headline numbers.
 *
 * Usage: node --expose-gc bench/bench.mjs
 *        node --expose-gc bench/bench.mjs --json   (JSON only, for CI)
 */

import os from "node:os";
import process from "node:process";
import { signal, effect } from "@zakkster/lite-signal";
import {
    createMedia, media, configure, reducedMotion, __resetForTests,
} from "../Media.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const JSON_ONLY = process.argv.includes("--json");
const HAS_GC = typeof globalThis.gc === "function";

function machineStamp() {
    return {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: os.cpus()[0].model,
        cores: os.cpus().length,
        totalMemMB: Math.round(os.totalmem() / (1024 * 1024)),
        ts: new Date().toISOString(),
    };
}

function tryGC() { if (HAS_GC) globalThis.gc(); }

// Median + IQR-style spread from N samples.
function summarize(samples) {
    const s = [...samples].sort((a, b) => a - b);
    const n = s.length;
    const med = s[Math.floor(n / 2)];
    const q1 = s[Math.floor(n / 4)];
    const q3 = s[Math.floor((n * 3) / 4)];
    const spread = ((q3 - q1) / med) * 100;
    return { median: med, min: s[0], max: s[n - 1], q1, q3, spreadPct: spread };
}

/**
 * Time N iterations of `fn`. Runs `warm` warm-up iterations first (not
 * counted). Repeats `runs` times to compute a median.
 */
function bench(name, fn, iterations, { warm = 3, runs = 7 } = {}) {
    // Warm-up (GC between runs -- cache-miss scenarios need node-pool recycling)
    for (let w = 0; w < warm; w++) { fn(iterations); tryGC(); }
    const samples = [];
    for (let r = 0; r < runs; r++) {
        tryGC();
        const t0 = performance.now();
        fn(iterations);
        const t1 = performance.now();
        samples.push(t1 - t0);
        tryGC();
    }
    const stats = summarize(samples);
    const opsPerSec = (iterations * 1000) / stats.median;
    const nsPerOp = (stats.median * 1e6) / iterations;
    return { name, iterations, ...stats, opsPerSec, nsPerOp };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

function scenarioCacheHit() {
    __resetForTests();
    const mm = makeMockMM();
    configure({ matchMedia: mm.matchMedia });
    media("(hot)"); // materialize
    return bench("media() cache hit", (n) => {
        for (let i = 0; i < n; i++) media("(hot)");
    }, 1_000_000);
}

function scenarioCacheMiss() {
    // Cold materialization single-shot: lite-signal's node pool array is
    // monotonic (never shrinks), so we can't do warm-up + repeated runs
    // without exceeding the 1024 cap. We do one pass, timed, at the end
    // of the benchmark run, and derive ns/creation from that.
    __resetForTests();
    const mm = makeMockMM();
    configure({ matchMedia: mm.matchMedia });
    const N = 500;
    const queries = new Array(N);
    for (let i = 0; i < N; i++) queries[i] = "(cold-" + i + ")";
    tryGC();
    const t0 = performance.now();
    for (let i = 0; i < N; i++) media(queries[i]);
    const t1 = performance.now();
    const ms = t1 - t0;
    return {
        name: "media() cache miss (cold materialize)",
        iterations: N,
        median: ms, min: ms, max: ms, q1: ms, q3: ms, spreadPct: 0,
        opsPerSec: (N * 1000) / ms,
        nsPerOp: (ms * 1e6) / N,
        note: "single-shot (lite-signal node pool is monotonic)",
    };
}

function scenarioSignalRead() {
    __resetForTests();
    const mm = makeMockMM();
    configure({ matchMedia: mm.matchMedia });
    const s = media("(read)");
    let acc = false; // sink to prevent DCE
    const result = bench("Signal read (call-style)", (n) => {
        let a = acc;
        for (let i = 0; i < n; i++) a = s();
        acc = a;
    }, 1_000_000);
    // sink acc so V8 can't dead-code the reads
    if (acc && !acc) console.log("unreachable");
    return result;
}

function scenarioEventThroughput() {
    __resetForTests();
    const mm = makeMockMM();
    configure({ matchMedia: mm.matchMedia });
    const s = media("(x)");
    // One subscriber. Measures browser-event -> set -> effect chain.
    let runs = 0;
    const stop = effect(() => { s(); runs++; });
    const baseline = runs;
    const result = bench("change event -> sig.set -> effect (1 subscriber)", (n) => {
        for (let i = 0; i < n; i++) mm.flip("(x)", (i & 1) === 1);
    }, 100_000);
    stop();
    return result;
}

function scenarioFanoutTo100() {
    __resetForTests();
    const mm = makeMockMM();
    configure({ matchMedia: mm.matchMedia });
    const s = media("(x)");
    const N_SUB = 100;
    const stops = [];
    let runs = 0;
    for (let i = 0; i < N_SUB; i++) stops.push(effect(() => { s(); runs++; }));
    const result = bench(`fanout to ${N_SUB} subscribers`, (n) => {
        for (let i = 0; i < n; i++) mm.flip("(x)", (i & 1) === 1);
    }, 10_000);
    for (const stop of stops) stop();
    // Include effective per-subscriber cost:
    result.nsPerSubscriber = result.nsPerOp / N_SUB;
    return result;
}

function scenarioPreferenceShortcut() {
    __resetForTests();
    const mm = makeMockMM();
    configure({ matchMedia: mm.matchMedia });
    reducedMotion(); // materialize
    return bench("preference shortcut cache hit", (n) => {
        for (let i = 0; i < n; i++) reducedMotion();
    }, 1_000_000);
}

function scenarioCreateMedia() {
    return bench("createMedia() instance creation", (n) => {
        for (let i = 0; i < n; i++) createMedia({ ssrDefault: false });
    }, 100_000);
}

function scenarioCreateMediaMaterialize() {
    // Same single-shot pattern as scenarioCacheMiss -- see comment there.
    const N = 50;
    tryGC();
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
        const inst = createMedia({ ssrDefault: false });
        inst.media("(a)");
        inst.media("(b)");
        inst.media("(c)");
        inst.media("(d)");
        inst.media("(e)");
    }
    const t1 = performance.now();
    const ms = t1 - t0;
    const perInst = ms / N;
    return {
        name: "createMedia() + 5 signals",
        iterations: N,
        median: ms, min: ms, max: ms, q1: ms, q3: ms, spreadPct: 0,
        opsPerSec: (N * 1000) / ms,
        nsPerOp: perInst * 1e6,
        note: "single-shot (creates 5 signals per iteration)",
    };
}

// ---------------------------------------------------------------------------
// Mock helper
// ---------------------------------------------------------------------------

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
    };
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

function fmtOps(v) {
    if (v >= 1e9) return (v / 1e9).toFixed(2) + " B ops/s";
    if (v >= 1e6) return (v / 1e6).toFixed(2) + " M ops/s";
    if (v >= 1e3) return (v / 1e3).toFixed(2) + " K ops/s";
    return v.toFixed(1) + " ops/s";
}

function fmtNs(v) {
    if (v < 1000) return v.toFixed(1) + " ns";
    if (v < 1_000_000) return (v / 1000).toFixed(2) + " µs";
    return (v / 1_000_000).toFixed(2) + " ms";
}

function printTable(results) {
    const rows = [];
    rows.push(["Scenario", "N", "ns / op", "ops / sec", "spread"]);
    for (const r of results) {
        rows.push([
            r.name,
            r.iterations.toLocaleString(),
            fmtNs(r.nsPerOp),
            fmtOps(r.opsPerSec),
            r.spreadPct.toFixed(1) + " %",
        ]);
    }
    // Column widths
    const widths = rows[0].map((_, colIdx) =>
        Math.max(...rows.map((row) => String(row[colIdx]).length))
    );
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const line = row.map((cell, j) => String(cell).padEnd(widths[j])).join("  ");
        console.log("  " + line);
        if (i === 0) console.log("  " + widths.map((w) => "-".repeat(w)).join("  "));
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const machine = machineStamp();
if (!JSON_ONLY) {
    console.log("@zakkster/lite-media -- benchmark v1");
    console.log(`  machine   ${machine.node} - ${machine.platform}/${machine.arch}`);
    console.log(`  cpu       ${machine.cpu} - ${machine.cores} cores`);
    console.log(`  gc hint   ${HAS_GC ? "yes (--expose-gc)" : "no"}`);
    console.log(`  ts        ${machine.ts}`);
    console.log("");
}

const results = [];
// Steady-state scenarios first (they materialize 1 signal each).
results.push(scenarioCacheHit());
results.push(scenarioSignalRead());
results.push(scenarioPreferenceShortcut());
results.push(scenarioEventThroughput());
results.push(scenarioFanoutTo100());        // + 100 effects
results.push(scenarioCreateMedia());        // 0 signals
// Heavy-allocation scenarios last, single-shot, monotonic pool.
results.push(scenarioCacheMiss());
results.push(scenarioCreateMediaMaterialize());

if (JSON_ONLY) {
    console.log(JSON.stringify({ machine, results }, null, 2));
} else {
    printTable(results);
    console.log("");
    // Headline numbers for the README
    const cacheHit = results.find((r) => r.name === "media() cache hit");
    const sigRead = results.find((r) => r.name === "Signal read (call-style)");
    const evt = results.find((r) => r.name.startsWith("change event"));
    const fanout = results.find((r) => r.name.startsWith("fanout to"));
    console.log("headline");
    console.log(`  media() cache hit         ${fmtOps(cacheHit.opsPerSec)}  (${fmtNs(cacheHit.nsPerOp)} per read)`);
    console.log(`  Signal read (call-style)  ${fmtOps(sigRead.opsPerSec)}  (${fmtNs(sigRead.nsPerOp)} per read)`);
    console.log(`  event -> set -> effect      ${fmtOps(evt.opsPerSec)}  (${fmtNs(evt.nsPerOp)} per flip)`);
    console.log(`  fanout to 100 subscribers ${fmtNs(fanout.nsPerOp)} per flip  (${fmtNs(fanout.nsPerSubscriber)} per subscriber)`);
}
