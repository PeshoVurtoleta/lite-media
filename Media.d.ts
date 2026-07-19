/**
 * @zakkster/lite-media v1.1.0 — TypeScript declarations.
 *
 * The returned signal type is deliberately narrowed to hide `.set`/`.update`
 * from callers. At runtime the object is lite-signal's `Signal<boolean>`, so
 * a JS consumer or a TS cast can still write — see the README's "Read-only
 * by convention" note for why you should not.
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
 * IMPORTANT — sync-flip window: `onChange` MUST NOT be invoked during the
 * `watch()` call itself. lite-media wires the signal reference AFTER `watch`
 * returns; any sync `onChange` inside `watch` will land against an
 * `undefined` signal binding and be silently dropped. Fold sync state into
 * `initial` and only call `onChange` for transitions that happen after
 * `watch` has returned.
 *
 * The default browser engine implements this via an injected `@container`
 * rule + zero-size sentinel + `transitionrun` on a registered `<custom-ident>`
 * CSS property. The default Node engine returns `{ initial: false, dispose:
 * noop }` — an inert always-false signal.
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
     * (including `undefined`) is a no-op — does not un-set a previous value.
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
 * `configure()` method — options are creation-only.
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
    reducedMotion(): MediaSignal;
    darkScheme(): MediaSignal;
    hoverCapable(): MediaSignal;
    coarsePointer(): MediaSignal;
    forcedColors(): MediaSignal;
    moreContrast(): MediaSignal;
    reducedData(): MediaSignal;
    reducedTransparency(): MediaSignal;
    stats(): Stats;
}

/**
 * Snapshot of instance state.
 */
export interface Stats {
    /** Number of memoized `media()` signals in the cache. */
    watched: number;
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
 * Options are creation-only. Scoped instances never lock — there's no
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
 * default instance. Same query string ⇒ same signal instance.
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
 * The container is the user's responsibility: the element must have
 * `container-type` set (`inline-size`, `size`, or `normal`), and the query
 * string must come from a bounded static set (see README).
 *
 * @throws {TypeError} if `el` is null / primitive or `query` is not a string
 */
export function containerMedia(el: Element | object, query: string): MediaSignal;

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

/** Cheap live snapshot of the default instance's state. */
export function stats(): Stats;

/**
 * @internal — test-only escape hatch. NOT part of the semver contract.
 * Resets all default-instance state including the container engine slot.
 */
export function __resetForTests(): void;
