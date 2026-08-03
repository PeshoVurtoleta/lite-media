/**
 * @zakkster/lite-media v1.5.0 -- TypeScript declarations.
 *
 * v1.4.0 makes Engine B multi-root (shadow DOM + cross-realm iframe). This is a
 * transparent correctness release: NO public signature changed -- containerMedia()
 * and containerStyle() are identical, and a container element inside a shadow root
 * or a foreign realm now materializes against that root's own sheet instead of
 * sitting stuck-false.
 *
 * v1.4.1 adds a bfcache / `pageshow` lifecycle audit: each instance re-pins its
 * signals when the page is restored from the back/forward cache (persisted
 * pageshow). Also a transparent release -- NO public signature changed; the only
 * new surface is the internal __pageshowForTests seam.
 *
 * The returned signal type is deliberately narrowed to hide `.set`/`.update`
 * from callers. At runtime the object is lite-signal's `Signal<boolean>` (or,
 * for `breakpoints()`, a `Computed<string>`), so a JS consumer or a TS cast
 * can still write -- see the README's "Read-only by convention" note for why
 * you should not.
 */

/**
 * A read-only reactive boolean returned by `media()`, `containerMedia()`,
 * and every preference shortcut. Structural subtype of lite-signal's
 * `Signal<boolean>`.
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
 * A read-only reactive string returned by `breakpoints()`: the name of the
 * active band. Structural subtype of lite-signal's `Computed<string>`. The
 * value is one of the map's own keys, returned by reference, so an unchanged
 * band is `===`-stable and notifies downstream exactly once per real change.
 *
 * `Name` narrows to the union of the map's keys when the map is a literal.
 */
export interface BandSignal<Name extends string = string> {
    /** Tracked read. Registers a dependency on the current observer. */
    (): Name;
    /** Untracked read. Same value, no dependency registration. */
    peek(): Name;
    /** Subscribe to band changes. Returns an idempotent dispose function. */
    subscribe(fn: (value: Name) => void): () => void;
}

/**
 * A breakpoint map: band name to its `min-width` threshold in CSS pixels. The
 * smallest-threshold entry is the mobile-first floor (returned whenever nothing
 * larger matches). Values must be finite and non-negative or `breakpoints()`
 * throws `TypeError` at compile time.
 */
export type BreakpointMap = Record<string, number>;

/**
 * The MediaQueryList shape lite-media relies on. Any object that fulfils this
 * contract is a valid mock. In production this is the DOM's `MediaQueryList`.
 * A factory that returns an object missing `addEventListener` will cause
 * `media()` to throw `TypeError`.
 */
export interface MockMediaQueryList {
    matches: boolean;
    addEventListener(
        type: "change",
        handler: (event: { matches: boolean }) => void
    ): void;
}

/**
 * Container-engine strategy. Watches an element for verdict flips against a
 * container query. Return `initial` synchronously, then call `onChange` for
 * every subsequent verdict transition.
 *
 * IMPORTANT -- sync-flip window: `onChange` MUST NOT be invoked during the
 * `watch()` call itself. lite-media wires the signal reference AFTER `watch`
 * returns; any sync `onChange` inside `watch` will land against an
 * `undefined` signal binding and be silently dropped. Fold sync state into
 * `initial` and only call `onChange` for transitions that happen after
 * `watch` has returned.
 *
 * The default browser engine implements this via an injected `@container`
 * rule + zero-size sentinel + `transitionrun` on a registered `<custom-ident>`
 * CSS property. The default Node engine returns `{ initial: false, dispose:
 * noop }` -- an inert always-false signal.
 *
 * Users can pass their own engine (test mocks, headless-render adapters) via
 * `configure({ containerEngine })` on the default instance, or via
 * `createMedia({ containerEngine })` on a scoped instance.
 */
export interface ContainerEngine {
    watch(
        el: Element | object,
        query: string,
        onChange: (matches: boolean) => void
    ): { initial: boolean; dispose: () => void };
}

/**
 * Configure options for the default lite-media instance.
 * See {@link CreateMediaOptions} for the scoped-instance variant.
 */
export interface ConfigureOptions {
    /**
     * Factory function returning a `MediaQueryList`-shaped object. Used for
     * test mocks and SSR shims. A non-function value throws `TypeError` at
     * configure time.
     */
    matchMedia?: (query: string) => MockMediaQueryList;
    /**
     * Value returned by media signals when no `matchMedia` is resolvable.
     * Process-wide constant on the default instance. Non-boolean input
     * (including `undefined`) is a no-op -- does not un-set a previous value.
     * For per-request SSR, use `createMedia({ ssrDefault })`.
     */
    ssrDefault?: boolean;
    /**
     * Container-query engine. If unset, the default engine is picked based
     * on environment: browser (adopted stylesheet + sentinel + transitionrun)
     * or Node (inert always-false).
     */
    containerEngine?: ContainerEngine | null;
}

/**
 * Options for creating a scoped lite-media instance via `createMedia()`.
 * Same shape as `ConfigureOptions` but the instance NEVER locks and has no
 * `configure()` method -- options are creation-only.
 */
export type CreateMediaOptions = ConfigureOptions;

/**
 * A scoped lite-media instance returned by `createMedia()`. Same surface as
 * the module-level API minus `configure()`, `__resetForTests()`, and lock
 * semantics.
 */
export interface ScopedMedia {
    media(query: string): MediaSignal;
    containerMedia(el: Element | object, query: string): MediaSignal;
    containerStyle(el: Element | object, prop: string, value: string): MediaSignal;
    breakpoints<M extends BreakpointMap>(map: M): BandSignal<keyof M & string>;
    reducedMotion(): MediaSignal;
    darkScheme(): MediaSignal;
    hoverCapable(): MediaSignal;
    coarsePointer(): MediaSignal;
    forcedColors(): MediaSignal;
    moreContrast(): MediaSignal;
    reducedData(): MediaSignal;
    reducedTransparency(): MediaSignal;
    standaloneDisplay(): MediaSignal;
    highDynamicRange(): MediaSignal;
    stats(): Stats;
    /**
     * @internal -- test-only escape hatch. NOT part of the semver contract.
     * Simulate a container verdict flip by routing `matches` through the engine
     * onChange that owns `sig`. Throws if `sig` is not a container signal of
     * this instance.
     */
    _flip(sig: MediaSignal, matches: boolean): void;
    /**
     * @internal -- test-only escape hatch. NOT part of the semver contract.
     * Run the raw bfcache resync path (v1.4.1): re-read every watched mql and
     * every live container verdict and re-push it through the signal's set.
     */
    _resync(): void;
    /**
     * @internal -- test-only escape hatch. NOT part of the semver contract.
     * Exercise the exact gated `pageshow` listener body (v1.4.1). `persisted`
     * !== true is a no-op; `persisted` === true runs `_resync()`.
     */
    _pageshow(persisted: boolean): void;
}

/**
 * Snapshot of instance state.
 */
export interface Stats {
    /** Number of memoized `media()` signals in the cache. */
    watched: number;
    /** Number of memoized `breakpoints()` band computeds. */
    bands: number;
    /**
     * Whether the instance was created with (or, for the default instance,
     * configured with) matchMedia, ssrDefault, or containerEngine.
     */
    configured: boolean;
    /**
     * Whether a successful materialization has locked the default instance.
     * Always `false` on scoped `createMedia()` instances.
     */
    locked: boolean;
}

/**
 * Create a scoped lite-media instance with its own memoization cache. This
 * is the fundamental factory; the module-level `media`, `configure`, etc.
 * delegate to a lazily-created default instance backed by this factory.
 *
 * Use `createMedia()` for:
 *   - Per-request SSR (each request creates a fresh instance with a
 *     request-specific `ssrDefault`).
 *   - Tests that need isolation without touching module state.
 *   - Multiple mount points with different matchMedia mocks.
 *
 * Options are creation-only. Scoped instances never lock -- there's no
 * `configure()` step and no lock error to worry about.
 *
 * @throws {TypeError} if `containerEngine` is malformed.
 */
export function createMedia(options?: CreateMediaOptions | null): ScopedMedia;

/**
 * Configure the default instance's matchMedia factory, SSR default, and/or
 * container engine. Must be called before the first successful `media()` /
 * `containerMedia()` / preference call.
 *
 * @throws {Error} if called after a successful materialization
 * @throws {TypeError} if `matchMedia` is present but not a function, or if
 *   `containerEngine` is malformed.
 */
export function configure(options: ConfigureOptions | null | undefined): void;

/**
 * Return the memoized reactive boolean signal for a CSS media query on the
 * default instance. Same query string => same signal instance.
 *
 * @throws {Error} if no matchMedia is available and no `ssrDefault` was configured
 * @throws {TypeError} if the configured factory returns a non-MQL-shaped object
 */
export function media(query: string): MediaSignal;

/**
 * Return the memoized reactive boolean signal for a container query, scoped
 * to an element. Cached by (element, query) pair via a WeakMap on the
 * element, so detached elements become GC-eligible with their signals.
 *
 * The container is the user's responsibility: the element (or an ancestor)
 * must establish a query container via `container-type: size | inline-size`,
 * and the query string must come from a bounded static set (see README). In
 * development builds, if neither the element nor any ancestor is a query
 * container, a one-time `console.warn` names the element and the fix; this is
 * dropped in production builds and never mutates the element.
 *
 * Off-DOM (SSR / Node without a container engine) this returns a stable
 * `false` signal and never throws -- the conservative, fail-closed verdict.
 * Unlike `media()`, `ssrDefault` does NOT apply to this path.
 *
 * @throws {TypeError} if `el` is null / primitive or `query` is not a string
 */
export function containerMedia(el: Element | object, query: string): MediaSignal;

/**
 * Return the memoized reactive boolean signal for a container STYLE query on
 * the default instance: is `prop` computed to `value` on the element's nearest
 * ancestor container? Constructs the canonical condition `style(<prop>: <value>)`
 * and delegates to {@link containerMedia}, so it shares that path's engine,
 * memoization and disposer. A raw `containerMedia(el, 'style(<prop>: <value>)')`
 * with identical spacing returns the same cached signal.
 *
 * Unlike a size query, a `style()` query resolves against any ancestor and
 * needs NO `container-type` on the element or its ancestors, so the dev-only
 * missing-container warning never fires for it. lite-media does not register
 * the queried property -- that stays the caller's responsibility.
 *
 * Off-DOM this returns a stable `false` signal and never throws, exactly like
 * `containerMedia()`.
 *
 * @throws {TypeError} if `el` is null / primitive, `prop` is not a non-empty
 *   string, or `value` is not a string
 */
export function containerStyle(el: Element | object, prop: string, value: string): MediaSignal;

/**
 * Compile a named breakpoint map into a single reactive band signal on the
 * default instance. The value is the active band: the name of the highest
 * threshold whose `(min-width: Npx)` matches, or the smallest entry as the
 * mobile-first floor. Identical maps (any key order) share one memoized
 * computed. Boundary signals are shared with `media()` through the same cache.
 *
 * With a literal map, the returned signal's value narrows to the union of the
 * map's keys, e.g. `breakpoints({ sm: 0, md: 768 })` is `BandSignal<"sm" | "md">`.
 *
 * Reads are zero-allocation; a band change notifies downstream exactly once.
 * Same lock semantics as `media()`.
 *
 * @throws {TypeError} if the map is not an object, is empty, or any value is
 *   not a finite, non-negative number
 * @throws {Error} if no matchMedia is available and no `ssrDefault` was configured
 */
export function breakpoints<M extends BreakpointMap>(map: M): BandSignal<keyof M & string>;

/** `(prefers-reduced-motion: reduce)` -- user requests reduced motion. */
export function reducedMotion(): MediaSignal;
/** `(prefers-color-scheme: dark)` -- user prefers dark UI. */
export function darkScheme(): MediaSignal;
/** `(hover: hover)` -- primary input supports true hover. */
export function hoverCapable(): MediaSignal;
/** `(pointer: coarse)` -- primary input is coarse (touch, stylus). */
export function coarsePointer(): MediaSignal;
/** `(forced-colors: active)` -- OS forced-colors / high-contrast mode is on. */
export function forcedColors(): MediaSignal;
/** `(prefers-contrast: more)` -- user requests higher contrast. */
export function moreContrast(): MediaSignal;
/** `(prefers-reduced-data: reduce)` -- user opted into data-saver mode. */
export function reducedData(): MediaSignal;
/** `(prefers-reduced-transparency: reduce)` -- user requests reduced transparency. */
export function reducedTransparency(): MediaSignal;
/** `(display-mode: standalone)` -- running as an installed / standalone PWA. */
export function standaloneDisplay(): MediaSignal;
/** `(dynamic-range: high)` -- display and browser support a high dynamic range. */
export function highDynamicRange(): MediaSignal;

/** Cheap live snapshot of the default instance's state. */
export function stats(): Stats;

/**
 * @internal -- test-only escape hatch. NOT part of the semver contract.
 * Resets all default-instance state including the container engine slot.
 */
export function __resetForTests(): void;

/**
 * @internal -- test-only escape hatch. NOT part of the semver contract.
 * Simulate a container verdict flip on the default instance by routing
 * `matches` through the engine onChange that owns `sig`. Materializes the
 * default instance if needed; throws if `sig` is not one of its container
 * signals.
 */
export function __flipForTests(sig: MediaSignal, matches: boolean): void;

/**
 * @internal -- test-only escape hatch. NOT part of the semver contract.
 * Returns a fresh browser container engine (the same factory the browser
 * environment picks), so the multi-root watch/dispose contract can be exercised
 * directly against a mock DOM. There is no public container-dispose API.
 */
export function __browserEngineForTests(): ContainerEngine;

/**
 * @internal -- test-only escape hatch. NOT part of the semver contract.
 * Synthesize a `pageshow` on the default instance with the given `persisted`
 * flag and run the exact gated listener body (v1.4.1 bfcache). `persisted` !==
 * true is a no-op; `persisted` === true re-pins every Engine A and Engine B
 * verdict, so a bfcache restore can be exercised with no real browser.
 */
export function __pageshowForTests(persisted: boolean): void;
