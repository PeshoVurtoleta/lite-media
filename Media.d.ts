/**
 * @zakkster/lite-media — TypeScript declarations.
 *
 * The returned signal type is deliberately narrowed to hide `.set`/`.update`
 * from callers. At runtime the object is lite-signal's `Signal<boolean>`, so
 * a JS consumer or a TS cast can still write — see the README's "Read-only
 * by convention" note for why you should not.
 */

/**
 * A read-only reactive boolean returned by `media()` and every preference
 * shortcut. Structural subtype of lite-signal's `Signal<boolean>`.
 */
export interface MediaSignal {
    /** Tracked read. Registers a dependency on the current observer. */
    (): boolean;
    /** Untracked read. Same value, no dependency registration. */
    peek(): boolean;
    /** Subscribe to changes. Returns an idempotent dispose function. */
    subscribe(fn: (value: boolean) => void): () => void;
}

/**
 * The MediaQueryList shape lite-media relies on. Any object that fulfils this
 * contract is a valid mock. In production this is the DOM's `MediaQueryList`.
 * A factory that returns an object missing `addEventListener` will cause
 * `media()` to throw `TypeError` — the shape check is intentional, so that
 * shorthand mocks (`() => ({ matches: true })`) fail fast at the call site.
 */
export interface MockMediaQueryList {
    matches: boolean;
    addEventListener(
        type: "change",
        handler: (event: { matches: boolean }) => void
    ): void;
}

/**
 * Configure options for lite-media. Must be applied before the first
 * successful `media()` call.
 */
export interface ConfigureOptions {
    /**
     * Factory function returning a `MediaQueryList`-shaped object. Used for
     * test mocks and SSR shims. Called with a query string; no `this` context
     * is supplied — bind if your factory needs one.
     *
     * When unset, lite-media reads from `globalThis.matchMedia` at first use.
     * A non-function value throws `TypeError` at configure time.
     */
    matchMedia?: (query: string) => MockMediaQueryList;
    /**
     * Value returned by media signals when no `matchMedia` is resolvable.
     * When unset, off-DOM materialization throws (honest SSR: crash loud
     * rather than silently return `false`).
     *
     * Process-wide constant — memoization means per-request values are
     * fundamentally incompatible with this v1.0.0 module. See README "SSR
     * & testing" for the intended pattern.
     */
    ssrDefault?: boolean;
}

/**
 * Snapshot of internal state — cheap, allocation-light. Intended for demos,
 * perf overlays, and test assertions.
 */
export interface Stats {
    /** Number of memoized signals in the cache. */
    watched: number;
    /**
     * Whether `configure()` has explicitly set matchMedia or ssrDefault.
     * Does NOT count the fallback to native `globalThis.matchMedia`.
     */
    configured: boolean;
    /** Whether a successful materialization has happened (lock engaged). */
    locked: boolean;
}

/**
 * Configure lite-media's matchMedia factory and/or SSR default. Ignored when
 * called with `null`, `undefined`, or a non-object.
 *
 * @throws {Error} if called after a successful materialization
 * @throws {TypeError} if `matchMedia` is present but not a function
 */
export function configure(options: ConfigureOptions | null | undefined): void;

/**
 * Return the memoized reactive boolean signal for a CSS media query.
 *
 * Same query string ⇒ same signal instance, shared across all callers.
 * One browser event flips one signal, and lite-signal's Object.is equality
 * ensures redundant events cost nothing downstream.
 *
 * Query strings must come from a bounded static set — the cache has no
 * eviction. See README "Memoization contract" for the precondition.
 *
 * @throws {Error} if no matchMedia is available and no `ssrDefault` was configured
 * @throws {TypeError} if the configured factory returns a non-MQL-shaped object
 */
export function media(query: string): MediaSignal;

// Curated preference shortcuts — each returns the memoized signal for a
// well-known query. First call materializes; subsequent calls hit the cache.

/** `(prefers-reduced-motion: reduce)` — user requests reduced motion. */
export function reducedMotion(): MediaSignal;
/** `(prefers-color-scheme: dark)` — user prefers dark UI. */
export function darkScheme(): MediaSignal;
/** `(hover: hover)` — primary input supports true hover. */
export function hoverCapable(): MediaSignal;
/** `(pointer: coarse)` — primary input is coarse (touch, stylus). */
export function coarsePointer(): MediaSignal;
/** `(forced-colors: active)` — OS forced-colors / high-contrast mode is on. */
export function forcedColors(): MediaSignal;
/** `(prefers-contrast: more)` — user requests higher contrast. */
export function moreContrast(): MediaSignal;
/** `(prefers-reduced-data: reduce)` — user opted into data-saver mode. */
export function reducedData(): MediaSignal;
/** `(prefers-reduced-transparency: reduce)` — user requests reduced transparency. */
export function reducedTransparency(): MediaSignal;

/** Cheap live snapshot of module state. */
export function stats(): Stats;

/**
 * @internal — test-only escape hatch. NOT part of the semver contract; the
 * name and prefix should make that unmistakable.
 */
export function __resetForTests(): void;
