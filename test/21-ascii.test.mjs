import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// 21-ascii -- a mechanical gate for the source-only ASCII Law.
// ---------------------------------------------------------------------------
// The Law: source is ASCII-only, with exactly two allowed exceptions --
//   U+00D7 (MULTIPLICATION SIGN) and U+00B5 (MICRO SIGN).
// This gate scans the real source/test/bench tree at test time and fails on
// any other non-ASCII codepoint, printing an actionable file:line:col U+XXXX.
// Docs (README/CHANGELOG/llms.txt) are OUTSIDE this Law and are not scanned.

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Allowed non-ASCII codepoints per the Law.
const ALLOW_X = 0x00d7; // multiplication sign
const ALLOW_MU = 0x00b5; // micro sign

/**
 * Pure. Scan `text` for non-ASCII codepoints that are not in the allowed set.
 * Returns an array of findings; empty means clean.
 *
 * line/col are 1-based. col counts by JS string index (UTF-16 code unit)
 * within the line -- i.e. the column of a char equals its 0-based string
 * index inside the line, plus one. An astral codepoint (surrogate pair)
 * occupies two code units and advances col by two.
 */
function scanAscii(text, file) {
    const findings = [];
    let line = 1;
    let col = 1;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === "\n") {
            line += 1;
            col = 1;
            continue;
        }
        const cp = text.codePointAt(i);
        if (cp > 0x7f && cp !== ALLOW_X && cp !== ALLOW_MU) {
            findings.push({
                file,
                line,
                col,
                cp: "U+" + cp.toString(16).toUpperCase().padStart(4, "0"),
            });
        }
        if (cp > 0xffff) {
            // astral: skip the trailing low surrogate.
            i += 1;
            col += 2;
        } else {
            col += 1;
        }
    }
    return findings;
}

// Build the scan set at test time. Fixed source entries by name; then every
// `.mjs` in test/ and bench/ selected by EXTENSION (so torture.mjs and this
// very file are in the set). demo/** and all .md/.txt/.html are excluded by
// construction -- they are never added.
function mjsIn(rel) {
    return readdirSync(join(ROOT, rel))
        .filter((n) => n.endsWith(".mjs"))
        .map((n) => rel + "/" + n)
        .sort();
}

const SCAN_SET = ["Media.js", "Media.d.ts", ...mjsIn("test"), ...mjsIn("bench")];

test("source tree is ASCII-only (U+00D7 and U+00B5 excepted)", () => {
    const all = [];
    for (const rel of SCAN_SET) {
        const text = readFileSync(join(ROOT, rel), "utf8");
        for (const f of scanAscii(text, rel)) all.push(f);
    }
    const msg = all
        .map((f) => f.file + ":" + f.line + ":" + f.col + " " + f.cp)
        .join("\n");
    assert.equal(all.length, 0, "non-ASCII in source:\n" + msg);
});

test("failing control: an em-dash is caught with exact location", () => {
    // The runtime string below contains U+2014 (EM DASH) at string index 13.
    // Written as a \u escape so THIS source file stays ASCII-clean (it is in
    // SCAN_SET); scanAscii sees the decoded string, which does carry U+2014.
    const findings = scanAscii('const s = "em\u2014dash";', "control");
    assert.equal(findings.length, 1, "expected exactly one finding");
    assert.equal(findings[0].cp, "U+2014");
    assert.equal(findings[0].line, 1);
    assert.equal(findings[0].col, 14); // index 13 + 1
});

test("exceptions honored: U+00D7 and U+00B5 produce zero findings", () => {
    // \u escapes for the same reason: keep this file ASCII while the decoded
    // string carries the two allowed exceptions.
    const findings = scanAscii('const a = "3\u00d74"; const b = "5 \u00b5s";', "control");
    assert.equal(findings.length, 0);
});

test("neighbors of exceptions are still flagged (guards range-widening)", () => {
    // The allow-list check is an exact !==, not a range. Prove a codepoint
    // immediately adjacent (on either side) to each exception still trips
    // the gate. \u escapes for the same reason as above.
    const acute = scanAscii("x\u00b4y", "control"); // U+00B4, just below U+00B5 (mu)
    assert.equal(acute.length, 1);
    assert.equal(acute[0].cp, "U+00B4");

    const pilcrow = scanAscii("x\u00b6y", "control"); // U+00B6, just above U+00B5 (mu)
    assert.equal(pilcrow.length, 1);
    assert.equal(pilcrow[0].cp, "U+00B6");

    const oDiaeresis = scanAscii("x\u00d6y", "control"); // U+00D6, just below U+00D7 (x)
    assert.equal(oDiaeresis.length, 1);
    assert.equal(oDiaeresis[0].cp, "U+00D6");

    const oStroke = scanAscii("x\u00d8y", "control"); // U+00D8, just above U+00D7 (x)
    assert.equal(oStroke.length, 1);
    assert.equal(oStroke[0].cp, "U+00D8");
});

export { scanAscii };
