# lite-i18n + lite-media — revised roadmaps, brief sessions

Both roadmaps read against the published tarballs. Both packages are ahead of
their own baselines. And the torture tooling is three packages, not one.

---

## 0. Tooling correction — Leak and GCProfiler are not in lite-profiler

`@zakkster/lite-profiler@1.5.0` (published 2026-07-31) exports:

```
Profiler · TimelineRecorder · FrameHistogram · FrameClass
encodeCapture · decodeCapture · encodeTimelineCapture · downloadCapture · LITECAP
exportChromeTrace · FrameBudget · budgetMs · isOverBudget · MeterHud
SUMMARY_SCHEMA · DEFAULT_TOLERANCES · summarize · summarizeCapture · diffCaptures
```

No `Leak`, no `GCProfiler`. A brief written as
`import { GCProfiler } from '@zakkster/lite-profiler'` fails at import, which is
exactly the class of error the pipeline's read-the-llms.txt habit exists to
prevent — so it is worth being precise before either roadmap depends on it.

Three packages, three jobs:

| Package | Version | Answers |
| --- | --- | --- |
| `@zakkster/lite-gc-profiler` | **1.14.1** | *Does this operation allocate?* |
| `@zakkster/lite-leak` | **1.8.0** | *Was this object released when its owner died?* |
| `@zakkster/lite-profiler` | **1.5.0** | *Where did the frame time go?* |

**lite-gc-profiler 1.14.1** — subpath exports `.`, `./register`,
`./test-helpers`, `./explain`. Surface: `measureOps`, `assertOps`, `checkNoGc`,
`measureGc`, `measureFrames`, `measureOpsAsync`, `withGcGate`, `compareOps`,
`assertCompareOps`, `captureFingerprint`, `aggregateWorkerReports`,
`checkAggregateReport`, `assertAggregateReport`, `GcProfiler.forceSettle()`, and
the rule keys `maxArrayBuffersGrowth`, `stabilize`, `allowInconclusive`. Plus an
`./explain` entry — `explainReport`, `explainDiff`, `gateBadge`,
`startExplainSampling` — and an `INCONCLUSIVE.md` triage doc.

**lite-leak 1.8.0** — and this one is not a heap-diff tool, which changes how
both roadmaps should use it. From its own llms.txt: it *"wraps lite-cleanup's FR
primitive with owner-tree attribution and auto-untrack via lite-signal's
`onCleanup`"*, with a pluggable kernel architecture. Surface:
`createLeakTracker(options)` with `onLeak` / `onFinding` / `onWarning` /
`onError` callbacks, `track` / `untrack`, `diffSnapshots`, `groupFindings`,
`createDefaultKernels`, `KernelConflictError`.

So the question it answers is ownership, not volume: *this listener was tracked
to that owner, the owner is gone, the listener wasn't untracked.* That is
precisely the shape of both packages' leak risk — a `MediaQueryList` listener
outliving its component, a sentinel element outliving its container, a dictionary
outliving the locale that replaced it. Neither roadmap currently uses it that
way; both reference `lite-leakforge` specimens instead, which is a different
tool for a different question.

**One reconciliation while here:** lite-profiler shipping `TimelineRecorder` and
`exportChromeTrace` means the timeline and exporter sessions from the ecosystem
roadmap have landed. The `MeterHud` + `diffCaptures` + `FrameBudget` surface is
now the frame-time instrument both demos can use.

---

# Part A — lite-i18n

## A.0 Reconciliation

| Roadmap says | Verified |
| --- | --- |
| "Baseline: v1.0.0 — 99 tests, 3.1 KB min+gz core, 0.6 KB format entry" | **1.1.2**, published 2026-07-20. llms.txt now says ~3.5 KB core + ~0.76 KB Format. |
| v1.1 — select + selectordinal | **shipped.** `select` 24 hits, `selectordinal` 7, `ordinal` 22, `_ordinalRules` 3 in `I18n.js` (799 lines). |
| v1.2 — `/lint` entry | open — `extractSlots` 0, `checkParity` 0, and `exports` has no `./lint` subpath. |
| v1.3 — `tRich` | open — 0 hits. |
| v1.4 — `resolveLocale` | open — 0 hits. |
| peer `lite-signal ^1.4.0` | held. `dependencies: {}`. |

So the roadmap's own release table is one row stale, and the size budget line
("still under 4 KB") should be re-checked against the shipped 3.5 KB rather than
the 3.1 KB baseline — v1.1 spent ~400 B of the 400–600 B it budgeted, which is
the estimate landing accurately and worth recording.

## A.1 The governing law holds — measure it, then lock it

The stated invariant is *"compile at defineMessages, allocate nothing on read
except the returned string."* Measured over 200k calls after a forced settle,
on the shipped 1.1.2:

```
static (no slots)      heap  0.0 B/call    arrayBuffers 0.00 B/call
select        (v1.1)   heap  0.0 B/call    arrayBuffers 0.00 B/call
slot interpolation     heap  3.5 B/call    arrayBuffers 0.00 B/call
plural                 heap  6.8 B/call    arrayBuffers 0.00 B/call
selectordinal (v1.1)   heap  6.8 B/call    arrayBuffers 0.00 B/call
```

Every number is consistent with the law: the only allocation is the returned
string, and where the return is an interned literal there is no allocation at
all. **Static and `select` are both exactly 0.0 B/call** — which confirms the
roadmap's own prediction that `select` would be *cheaper* than plural, since it
returns a pre-existing variant with no `#` substitution. That prediction was
made before the feature was built and it came out right.

This changes what the torture session is for. There is no bug to hunt here. The
job is to **freeze these five numbers as regression baselines** before v1.2, v1.3
and v1.4 add surface — because `tRich` in particular is documented as *not*
zero-GC, and the risk is that its arrival quietly moves `t()`.

===============================================================================
# I-T — lite-i18n v1.1.3 — lock the invariant, then stress it
===============================================================================

```markdown
---
package: "@zakkster/lite-i18n"
version_target: 1.1.3
status: planned
devPeers: ["@zakkster/lite-gc-profiler ^1.14.1", "@zakkster/lite-leak ^1.8.0"]
blocks: [I1, I2, I3]
---

# lite-i18n — the law is true today; make it stay true

PURPOSE
  The zero-GC invariant measures clean on 1.1.2. Three feature releases are
  queued behind it, one of which (`tRich`) is explicitly not zero-GC. Freeze the
  numbers now so a regression is a failed gate rather than a discovery.

TASKS
  - devDeps on `@zakkster/lite-gc-profiler` and `@zakkster/lite-leak`.
  - **Baseline table, committed.** `assertOps` on all five message shapes —
    static, slot, plural, select, selectordinal — with the measured B/call above
    as the committed ceiling, plus `maxArrayBuffersGrowth: 0` and
    `stabilize: 'deep'`. Use `captureFingerprint` so the numbers carry machine
    provenance, and `assertCompareOps` against the baseline rather than an
    eyeballed diff.
  - **The monomorphism invariant needs its own assertion.** The second law is a
    monomorphic `(params, locale, getRules) => string` entry shape, and nothing
    currently checks it. Compile a dict containing all five shapes, call every
    entry through one call site in a loop, and assert throughput does not
    degrade the way a megamorphic site would — the guard is that the *call site*
    stays monomorphic, which is invisible to a per-shape benchmark.
  - **Leak tracking on the right objects.** `createLeakTracker` with `onLeak`,
    tracking compiled dictionaries against the locale that owns them.
    `loadLocale` replacing a locale should release the previous dict; a tracked
    dict whose owner is gone and which was never untracked is the finding. This
    is the ownership question lite-leak answers, and it is the one real leak
    shape this package has.
  - **State the measurement's scope.** These numbers are Node's view of JS heap
    and ArrayBuffers. String interning, and whether V8 hands back a shared
    literal, is engine behaviour — the 0.0 B/call rows are true and are not a
    promise about every engine.

TORTURE TIERS
  - **Compile storm.** 10k `defineMessages` calls with generated dicts —
    deeply nested namespaces, 200-key flat dicts, every ICU form, and dicts that
    differ only in one variant. Assert compile is the only allocating phase and
    that `stats()` (if present) tracks key count honestly.
  - **Locale churn.** 4096 `loadLocale` / `locale.set` cycles across five
    locales with concurrent reads in flight, asserting the race-safety the 1.0.0
    notes claim, plus zero retained dicts per the leak tracker.
  - **Fail-loud fuzz.** Generated templates that must throw at define time:
    unbalanced braces, missing `other`, unknown ICU function, `select` with a
    numeric selector, nested plural (a standing non-goal — assert it throws
    rather than silently half-working), quoted-string escapes at every boundary.
    Every case pinned; "throws a TypeError from deep inside the parser" is not a
    pinned answer, a named SyntaxError is.
  - **Read-path adversarial params.** Missing slot, extra slot, `null`,
    `undefined`, a param object with a `toString` that throws, a prototype-
    polluted params object (the 1.0.0 notes claim prototype-chain-safe slot
    reads — assert it), `count` as a string, `count` as NaN, negative and
    fractional counts through every plural category.
  - **Fallback-chain depth.** A five-deep chain with a key present only at the
    root, and a missing-key policy per tier, asserting no allocation per miss.

ASSERTIONS
  - Five committed B/call ceilings hold; a deliberately-allocating control
    variant fails the gate.
  - `maxArrayBuffersGrowth: 0` across every tier.
  - No compiled dict is retained after its locale is replaced.
  - Every fail-loud case throws a named error at define time.
  - The existing 99+ tests green; size re-measured and corrected in
    README/llms/package.json per the standard gate.

NON-GOALS
  No features. If a tier finds a bug it gets its own patch — instrumenting and
  fixing in one diff means the gate's first run proves nothing.

DONE WHEN
  the five numbers are committed ceilings, the monomorphic call site has an
  assertion, and locale churn provably retains nothing
```

## A.2 The feature ladder — unchanged, three notes

**I1 → v1.2 `/lint`.** Ship as written. The four checks (`extractSlots`,
`checkParity`, `checkCoverage`, `checkPluralCompleteness`) are well chosen and
`checkPluralCompleteness` via `Intl.PluralRules().resolvedOptions()
.pluralCategories` is the one that catches real bugs. One addition: **run `/lint`
against the package's own test fixtures in CI**, so the linter is dogfooded by
the suite that also proves it. Zero runtime bytes, and `exports` gains a `./lint`
subpath — confirm it stays out of the `.` graph with an import-graph assertion,
not just by intent.

**I2 → v1.3 `tRich`.** The decision gate is right and should be treated as
binding: prototype against a real consumer first, and if neither REFORGE nor the
Vikings paytable needs it this quarter, run the bench track instead. Two
additions when it does land: the honesty that `tRich` is not zero-GC belongs in
an **asserted** test, not only in prose — measure its per-call allocation and
commit that number too, so "not zero-GC" has a magnitude. And I-T's five
ceilings must be re-run to prove `t()` did not move.

**I3 → v1.4 `resolveLocale` + TMS converters.** Unchanged. BCP 47 prefix
matching without RFC 4647 lookup tables is the correct scope call.

**Bench track.** The `paraglide-js` comparison is the interesting one, as the
roadmap says — it is the compile-time competitor, so it is the only entry that
tests the actual thesis rather than the implementation. Keep it.

**Ordering.** The roadmap flags 1.3-vs-bench as "the one genuinely open call."
It still is. I-T slots in front of both regardless, because it is the thing that
makes either safe to land.

---

# Part B — lite-media

## B.0 Reconciliation

| Roadmap says | Verified |
| --- | --- |
| v1.0.0 — `media()` + ten preference signals | **shipped**, but see LM-01 |
| v1.1.0 — `containerMedia()` engine B | **shipped** — `containerMedia`, `transitionrun` (6), `allow-discrete` (2), `CSS.registerProperty` (2), `adoptedStyleSheets` (2) all present |
| Published | **1.1.1**, 2026-07-19, `Media.js` 464 lines, `dependencies: {}`, peer `lite-signal ^1.3.0` |
| v1.2.0 — `breakpoints()` + style queries | open — `breakpoints` 0 hits |
| v1.3.0 — shadow DOM, bfcache | open — `shadowRoot` 0, `bfcache` 0, `pagehide` 0 |

The roadmap is written as a design document for a package that now exists. Its
architecture section should be re-read as documentation rather than plan — the
sentinel, the shared constructed sheet and the `transitionrun` primary path all
shipped as specified, which is a good outcome for a design that detailed.

## B.1 Three gaps between the spec and the tarball

**LM-01 (S3). Eight of the ten curated preference signals shipped.** Exported:
`reducedMotion`, `darkScheme`, `hoverCapable`, `coarsePointer`, `forcedColors`,
`moreContrast`, `reducedData`, `reducedTransparency`. The v1.0.0 spec also lists
**`standaloneDisplay`** and **`highDynamicRange`**; neither is exported. Two
one-line additions, but the README and the roadmap both promise ten.

**LM-02 (S2). The `container-type: normal` dev warning never shipped.**
`container-type` appears **zero** times in `Media.js`. The roadmap calls this out
by name — *"the classic silent-mismatch footgun"* — and lists it as a v1.1.0
deliverable. Without it, a caller who forgets `container-type` on the watched
element gets a `containerMedia` signal that ispermanently `false` with no
diagnostic, which is the exact failure the warning was designed to catch. This
is the highest-value gap in either package: the footgun was identified,
scheduled, and then not built.

**LM-03 (S3). No container-path test seam.** `__resetForTests` is exported;
`_flip(cq, bool)` from §4.2 is not. So the media path is mockable via
`configure({ matchMedia })` and the container path is not mockable at all. The
roadmap's conformance suite — verdict agreement against a CSS-side probe class —
needs either a real browser or that seam, and the `strategy: 'resize'` fallback
(1 hit in source) is the other half of it. Confirm whether the fallback is
complete or stubbed before v1.2 depends on it.

===============================================================================
# M-T — lite-media v1.1.2 — the footgun warning, plus the harness
===============================================================================

```markdown
---
package: "@zakkster/lite-media"
version_target: 1.1.2
status: planned
findings: [LM-01, LM-02, LM-03]
devPeers: ["@zakkster/lite-gc-profiler ^1.14.1", "@zakkster/lite-leak ^1.8.0"]
blocks: [M1]
---

# lite-media — ship the warning that was specified, then build the harness

PURPOSE
  Engine B shipped as designed. The dev warning that catches its single most
  likely misuse did not. And the container path has no test seam, which is why
  the conformance suite in §7 cannot exist yet.

TASKS
  - **LM-02, the warning.** On `containerMedia` init, read the watched element's
    computed `container-type`; if it resolves to `normal` and no `name` was
    passed, warn once, naming the element and the fix. Dev-only — gate it so a
    production build drops it, and assert the production path emits nothing.
    The roadmap's own reasoning stands: **warn, never mutate.** Setting
    `container-type` changes sizing semantics and that is the user's call.
  - **LM-01.** Add `standaloneDisplay` (`(display-mode: standalone)`) and
    `highDynamicRange` (`(dynamic-range: high)`), matching the lazy-memoized
    shape of the other eight. Ten signals, as documented.
  - **LM-03, the seam.** Export `_flip(cq, bool)` test-only, and confirm the
    `strategy: 'resize'` fallback is complete rather than stubbed — it is both
    the documented escape hatch for engines where `allow-discrete` misbehaves
    *and* the jsdom shim target the conformance suite needs.
  - Then the harness below.

TORTURE TIERS
  - **Duplicate-event storm** (WebKit #279012). The roadmap already specifies
    this and the assertion shape is right: a flip that re-fires must produce
    exactly one effect run, because `sig.set` with an equal value is a no-op.
    Drive 10k duplicate `transitionrun` events and assert the effect-run counter.
  - **Attach/detach churn.** 4096 `containerMedia` create/dispose cycles.
    After each: sentinel removed from the DOM, CSS rules removed from the
    constructed sheet, listener detached, `--lmN` name released. **This is the
    lite-leak tier** — `track` the sentinel and the listener against the
    watcher; a disposed watcher whose sentinel was never untracked is the
    finding, reported through `onLeak` with owner attribution. That is the
    `mql-orphan` specimen the roadmap wants, expressed in the tool that answers
    ownership questions.
  - **1k simultaneous containers.** Assert the shared sheet holds 2k rules
    without quadratic insert cost, that `CSS.registerProperty` is called once
    per name, and that `stats()` reports honestly.
  - **Dispose during transition.** Dispose a watcher between `transitionrun`
    firing and the handler reading `getPropertyValue`. The handler must not
    write to a disposed signal or throw.
  - **Media-path GC barrier.** 100 `media()` signals, mock MQL, 10k flips:
    `checkNoGc` at `maxMajor: 0` plus `maxArrayBuffersGrowth: 0`. The roadmap
    predicts zero steady-state allocation on this path; commit the number.
  - **Container-path allocation accounting.** Scripted width oscillation across
    a breakpoint 1k times. The documented model is *one short string per verdict
    flip, nothing per resize frame* — assert exactly that: allocation
    proportional to flip count, flat against frame count. **This is the
    package's central performance claim** and it is currently prose.
  - **SSR / no-window.** `media()` returns the `ssrDefault`;
    `containerMedia` off-DOM behaves per the §4.1 decision — which is still
    listed as undecided ("leaning throw-always"). Decide it in this session and
    pin it; an undecided branch is a branch nobody tested.
  - **Registry bounds.** The module-level `Map<string, Signal>` is documented as
    bounded because "the vocabulary of query strings in an app is small and
    static." Assert what happens when it isn't — 10k distinct generated query
    strings — and either document the invariant as a contract with a test, or
    bound the map. An unbounded module-level cache is the same shape as
    lite-router's `queryParam` memo, which chose "documented invariant + test."

ASSERTIONS
  - The `container-type: normal` warning fires exactly once per offending
    element, names the element, and is absent from production builds.
  - Ten preference signals exported and lazily memoized.
  - Duplicate-event storm: exactly one effect run.
  - 4096 attach/detach cycles leak no sentinel, rule, listener or property name
    — verified through `onLeak`, not through a heap curve.
  - Media path: 0 B/flip. Container path: allocation tracks flip count, not
    frame count. Both committed as numbers.
  - Dispose-during-transition is safe.
  - Every gate ships a control that fails it.

DONE WHEN
  the specified warning exists, ten signals ship, the container path is mockable,
  and the "cost scales with answers, not motion" claim is a test
```

## B.2 The remaining ladder

**M1 → v1.2.0 style queries + `breakpoints()`.** Ship as written. The interned-
token computed is the right shape for zero-GC reads. One addition: the
theme-flip storm driven by `lite-hueforge deriveTheme` output is a good torture
case *and* a good demo scene — hueforge is at 1.6.0 with `deriveTheme` shipped,
so that pairing is available now rather than aspirational.

**M2 → v1.4.0 hardening.** Shadow DOM multi-root is the substantial item and the
§6 design (per-root sheet map, document-global `--lm-v` registry, interleaved
dispose torture) is already correct — shipped in v1.4.0 as **multi-root Engine B
(shadow DOM + cross-realm iframe)**: one constructed sheet per root, adopted into
that root and built in that root's own realm, one `--lm-v` across roots,
fail-closed per root, with the interleaved-dispose torture committed. The
bfcache/pageshow audit was a separate concern class and **shipped in v1.4.1**: a
persisted `pageshow` re-pins every Engine A `mql` verdict and every Engine B
sentinel verdict through the same `sig.set` a real event uses (a pinned answer per
event, not a paragraph) — 0 B on an unchanged restore, fail-closed per entry,
with bfcache-resync and Engine-B live-set retention torture committed. Note:
earlier drafts of this ladder labelled hardening as v1.3.0 — v1.3.0 in fact
shipped `containerStyle()`, so hardening is v1.4.0.

**M3 → v1.5.0 ecosystem wiring.** Unchanged, and the strongest item is the
`reducedMotion` + `watchEffect` rAF-gate recipe replacing ad-hoc checks in
lite-ambient-fx and lite-scratch-fx. ambient-fx is at 1.7.0 with
`prefers-reduced-motion` already handled internally — so this is a
*consolidation*, and worth checking whether ambient-fx should consume lite-media
or keep its own check given its zero-dependency identity. That is the same
vendor-versus-depend question ambient-fx already answered once for particles;
answer it the same way and record it.

**Watchlist.** CSSWG #6205 stays the right thing to watch, and the framing —
*"if it ships natively, engine B collapses to a feature-detected bridge and the
signal-graph surface never changes"* — is the payoff of never owning an
evaluator. Keep that sentence; it is the package's thesis in one line.

---

## Shared: what not to change

- **lite-i18n's two invariants.** They are measured true on 1.1.2 and they are
  the reason the package is worth having. The rejection ledger built from them —
  full ICU, nested plurals, runtime TMS, Fluent-class morphology — is correctly
  reasoned and each entry names why rather than just saying no.
- **lite-media's "no query parsing, ever."** *"The moment one parser branch
  exists, the correctness guarantee is gone."* That is the whole argument for the
  sentinel architecture and it should stay the first line of the scope ledger.
- **Both packages' single-peer-dep contract.** `dependencies: {}` on both,
  verified. lite-media's §4.4 reasoning for keeping lite-watch-ex as a devDep and
  a docs pointer rather than a runtime dep is exactly the right call and the same
  rule the rest of the ecosystem follows.

*Revised against `@zakkster/lite-i18n@1.1.2`, `@zakkster/lite-media@1.1.1`,
`@zakkster/lite-gc-profiler@1.14.1`, `@zakkster/lite-leak@1.8.0` and
`@zakkster/lite-profiler@1.5.0`, 2026-07-31. Copyright Zahary Shinikchiev.*
