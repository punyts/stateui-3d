/**
 * The motion scheduler of a scene (G1.8 of the graphics epic 1): one animation-frame loop per renderer that runs the
 * tweens of `transition` (and, from G1.8b, the frame tasks of `animate`), and is idle (no frame asked for) when nothing
 * moves. It has no DOM of its own: the frame and the clock come from its host, so tests drive it with a fake clock.
 * The parsers here read the theme's motion tokens: durations in `ms` and `s` and easings as `cubic-bezier(...)`.
 *
 * A copy of `src/shared/drawing/scheduler.ts` of `@punyts/stateui-components` (G3.9 of the graphics epic 3): this
 * package depends on no StateUI package, so it cannot import it. Change both together: `scheduler.test.ts` is the same
 * in both, and the same fixture file, `test/fixtures/scheduler.fixture.json` in both repositories, is asserted by
 * `test/scheduler.fixture.test.ts` on each side, so the two give the same values.
 */

/** An easing: progress in time (0 to 1) to progress in value (0 to 1 at the ends) */
export type Easing = (t: number) => number;

/** How long a tween runs and how it eases */
export interface Timing {
    /** Milliseconds; 0 or less jumps */
    readonly duration: number;
    readonly easing: Easing;
}

/** A tweened value: a number, or a list of numbers of a fixed length (a colour as `[r, g, b, a]`) */
export type TweenValue = number | readonly number[];

/** The shipped `motion.duration.*` tokens (`tokens.default.json`), used when the theme gives none */
export const DEFAULT_DURATIONS: Readonly<Record<string, number>> = { fast: 100, base: 200, slow: 400 };

/** The shipped `motion.easing.*` tokens, used when the theme gives none */
export const DEFAULT_EASINGS: Readonly<Record<string, string>> = {
    standard: 'cubic-bezier(0.4, 0, 0.2, 1)',
    enter: 'cubic-bezier(0, 0, 0.2, 1)',
    exit: 'cubic-bezier(0.4, 0, 1, 1)'
};

/** The CSS easing keywords as the curves CSS defines for them */
const KEYWORDS: Readonly<Record<string, readonly [number, number, number, number]>> = {
    linear: [0, 0, 1, 1],
    ease: [0.25, 0.1, 0.25, 1],
    'ease-in': [0.42, 0, 1, 1],
    'ease-out': [0, 0, 0.58, 1],
    'ease-in-out': [0.42, 0, 0.58, 1]
};

const DURATION = /^(\d*\.?\d+(?:e[+-]?\d+)?)(ms|s)?$/i;
const BEZIER = /^cubic-bezier\(\s*([^,()]+),\s*([^,()]+),\s*([^,()]+),\s*([^,()]+)\)$/i;

/**
 * A CSS duration in milliseconds: `200ms`, `0.2s`, and a bare number as milliseconds (`0`); undefined for anything
 * else (a negative or unknown unit). `0ms`, `0s` and `0` are all 0, which is what reduced motion is
 */
export function parseDuration(text: string | undefined): number | undefined {
    if (text === undefined) return undefined;
    const match = DURATION.exec(text.trim());
    if (match === null) return undefined;
    const value = Number(match[1]);
    if (!Number.isFinite(value)) return undefined;
    return match[2]?.toLowerCase() === 's' ? value * 1000 : value;
}

/** The four numbers of `cubic-bezier(x1, y1, x2, y2)` (or of a CSS easing keyword); undefined when it is not one or an x is outside 0 to 1 */
export function parseCubicBezier(text: string | undefined): readonly [number, number, number, number] | undefined {
    if (text === undefined) return undefined;
    const trimmed = text.trim().toLowerCase();
    if (Object.hasOwn(KEYWORDS, trimmed)) return KEYWORDS[trimmed];
    const match = BEZIER.exec(trimmed);
    if (match === null) return undefined;
    const values = match.slice(1, 5).map((part) => (part.trim() === '' ? Number.NaN : Number(part)));
    if (!values.every(Number.isFinite)) return undefined;
    const [x1, y1, x2, y2] = values as [number, number, number, number];
    if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) return undefined;
    return [x1, y1, x2, y2];
}

/**
 * The easing of a cubic Bézier curve from (0, 0) to (1, 1) with control points (x1, y1) and (x2, y2), as CSS defines
 * `cubic-bezier()`: for a time t it finds the curve parameter whose x is t (Newton's method, then bisection) and gives
 * that parameter's y. The ends are exact: 0 at 0 and 1 at 1
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): Easing {
    const cx = 3 * x1;
    const bx = 3 * (x2 - x1) - cx;
    const ax = 1 - cx - bx;
    const cy = 3 * y1;
    const by = 3 * (y2 - y1) - cy;
    const ay = 1 - cy - by;
    const sampleX = (s: number): number => ((ax * s + bx) * s + cx) * s;
    const sampleY = (s: number): number => ((ay * s + by) * s + cy) * s;
    const slopeX = (s: number): number => (3 * ax * s + 2 * bx) * s + cx;
    const solve = (x: number): number => {
        let s = x;
        for (let step = 0; step < 8; step += 1) {
            const error = sampleX(s) - x;
            if (Math.abs(error) < 1e-10) return s;
            const slope = slopeX(s);
            if (Math.abs(slope) < 1e-6) break;
            s -= error / slope;
        }
        let low = 0;
        let high = 1;
        s = x;
        while (low < high) {
            const at = sampleX(s);
            if (Math.abs(at - x) < 1e-10) return s;
            if (x > at) low = s;
            else high = s;
            const next = (low + high) / 2;
            if (next === s) break;
            s = next;
        }
        return s;
    };
    return (t: number): number => {
        if (t <= 0) return 0;
        if (t >= 1) return 1;
        return sampleY(solve(t));
    };
}

/** The easing of a CSS easing text (`cubic-bezier(...)` or a keyword); undefined when it does not parse */
export function parseEasing(text: string | undefined): Easing | undefined {
    const curve = parseCubicBezier(text);
    return curve === undefined ? undefined : cubicBezier(...curve);
}

/** Reads a custom property of the scene's computed style (`--ui-motion-easing-standard`); undefined when unset */
export type ReadToken = (name: string) => string | undefined;

/** The custom property that says whether motion is reduced */
export const REDUCED_MOTION_PROPERTY = '--ui-motion-duration-base';

/**
 * True when motion is reduced: the theme's `motion.duration.base` (`--ui-motion-duration-base`) parses to a duration
 * of 0 (`0ms` as the shipped `reduced` overlay sets it, `0s` or `0`). A theme that gives no value is full motion
 */
export function isReducedMotion(read: ReadToken): boolean {
    return parseDuration(read(REDUCED_MOTION_PROPERTY)) === 0;
}

/** The `motion.duration.<name>` token in milliseconds, from the theme or the shipped value; undefined for an unknown name */
export function durationToken(name: string, read: ReadToken): number | undefined {
    const value = parseDuration(read(`--ui-motion-duration-${name}`));
    if (value !== undefined) return value;
    return Object.hasOwn(DEFAULT_DURATIONS, name) ? DEFAULT_DURATIONS[name] : undefined;
}

/** The `motion.easing.<name>` token, from the theme or the shipped curve; undefined for an unknown name */
export function easingToken(name: string, read: ReadToken): Easing | undefined {
    const value = parseEasing(read(`--ui-motion-easing-${name}`));
    if (value !== undefined) return value;
    return Object.hasOwn(DEFAULT_EASINGS, name) ? parseEasing(DEFAULT_EASINGS[name]) : undefined;
}

/** A value between two of the same shape at progress p (beyond 0 to 1 for an easing that overshoots) */
export function interpolate(from: TweenValue, to: TweenValue, p: number): TweenValue {
    if (typeof from === 'number' && typeof to === 'number') return from + (to - from) * p;
    if (typeof from === 'number' || typeof to === 'number' || from.length !== to.length) return to;
    return to.map((end, index) => from[index]! + (end - from[index]!) * p);
}

/**
 * A frame task (G1.8b's `animate`): runs in every frame with the scheduler's time, and asks for the next frame by
 * giving back true. Tasks do not run while motion is reduced
 */
export type FrameTask = (now: number) => boolean;

/** What a scheduler needs of its scene */
export interface SchedulerHost {
    /** Asks for a frame (the window's `requestAnimationFrame`); without it every frame request is ignored */
    requestFrame?(callback: () => void): number;
    cancelFrame?(handle: number): void;
    /** The time in milliseconds (`performance.now()` by default); tests give a clock they move */
    now?(): number;
    /**
     * Runs once per frame after the tweens moved and the tasks ran, with the keys of the tweens whose value changed in
     * this frame (those that ended included), so the renderer draws them
     */
    onFrame(changed: ReadonlySet<string>): void;
}

/** One scene's motion */
export interface Scheduler {
    /** The scheduler's time in milliseconds */
    now(): number;
    /** True while motion is reduced: a tween jumps and tasks do not run */
    readonly reduced: boolean;
    /** Sets reduced motion; turning it on ends every tween at its end value. True when it changed */
    setReduced(reduced: boolean): boolean;
    /**
     * Tweens `key` from `from` to `to`. A tween of the key that is running starts from its current value instead (a new
     * value mid-tween does not jump); with reduced motion, a duration of 0 or values of another shape it jumps (the
     * key holds no value). Asks for a frame
     */
    tween(key: string, from: TweenValue, to: TweenValue, timing: Timing): void;
    /** The current value of a running tween, or undefined when the key is not tweening */
    valueOf(key: string): TweenValue | undefined;
    /** Stops a tween where it is (the caller shows the end value); nothing when it is not running */
    cancel(key: string): void;
    /** The keys of the running tweens */
    keys(): IterableIterator<string>;
    /** Adds a frame task (G1.8b) and asks for a frame; gives back a function that removes it */
    request(task: FrameTask): () => void;
    /** True when no tween runs and no task waits: no frame is asked for */
    readonly idle: boolean;
    /** Resolves once no tween runs (at once when none does, and on `dispose`); frame tasks are not waited for */
    settled(): Promise<void>;
    /** Stops: cancels the frame, drops every tween and task, and resolves what waits */
    dispose(): void;
}

interface Running {
    readonly from: TweenValue;
    readonly to: TweenValue;
    readonly start: number;
    readonly duration: number;
    readonly easing: Easing;
    value: TweenValue;
}

const sameShape = (a: TweenValue, b: TweenValue): boolean =>
    typeof a === 'number' ? typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b) : typeof b !== 'number' && a.length === b.length && [...a, ...b].every(Number.isFinite);

/**
 * Makes a scene's scheduler. It asks for a frame only while a tween runs or a task waits, so a scene at rest asks for
 * none; each frame moves every tween to the host's time (`now`), runs the tasks, then calls `onFrame` once
 */
export function createScheduler(host: SchedulerHost): Scheduler {
    const now = host.now ?? ((): number => globalThis.performance?.now() ?? Date.now());
    const tweens = new Map<string, Running>();
    const tasks = new Set<FrameTask>();
    let handle: number | undefined;
    let reduced = false;
    let disposed = false;
    let waiters: (() => void)[] = [];

    const settle = (): void => {
        if (tweens.size > 0 && !disposed) return;
        const done = waiters;
        waiters = [];
        for (const resolve of done) resolve();
    };

    const wanted = (): boolean => !disposed && (tweens.size > 0 || (tasks.size > 0 && !reduced));

    const ask = (): void => {
        if (handle !== undefined || !wanted() || host.requestFrame === undefined) return;
        handle = host.requestFrame(frame);
    };

    const frame = (): void => {
        handle = undefined;
        if (disposed) return;
        const at = now();
        const changed = new Set<string>();
        for (const [key, tween] of tweens) {
            const p = tween.duration <= 0 ? 1 : (at - tween.start) / tween.duration;
            changed.add(key);
            if (p >= 1) tweens.delete(key);
            else tween.value = interpolate(tween.from, tween.to, tween.easing(Math.max(0, p)));
        }
        if (!reduced) for (const task of [...tasks]) if (!task(at)) tasks.delete(task);
        host.onFrame(changed);
        ask();
        settle();
    };

    return {
        now,
        get reduced() {
            return reduced;
        },
        setReduced(next) {
            if (next === reduced) return false;
            reduced = next;
            if (reduced) {
                const ended = new Set(tweens.keys());
                tweens.clear();
                if (handle !== undefined) host.cancelFrame?.(handle);
                handle = undefined;
                if (ended.size > 0 && !disposed) host.onFrame(ended);
                settle();
            } else ask();
            return true;
        },
        tween(key, from, to, timing) {
            if (disposed) return;
            const running = tweens.get(key);
            const start = running?.value ?? from;
            if (reduced || !(timing.duration > 0) || !sameShape(start, to)) {
                tweens.delete(key);
                settle();
                return;
            }
            tweens.set(key, { from: start, to, start: now(), duration: timing.duration, easing: timing.easing, value: start });
            ask();
        },
        valueOf(key) {
            return tweens.get(key)?.value;
        },
        cancel(key) {
            if (!tweens.delete(key)) return;
            settle();
        },
        keys() {
            return tweens.keys();
        },
        request(task) {
            if (disposed) return () => undefined;
            tasks.add(task);
            ask();
            return () => {
                tasks.delete(task);
            };
        },
        get idle() {
            return !wanted();
        },
        settled() {
            if (tweens.size === 0 || disposed) return Promise.resolve();
            return new Promise<void>((resolve) => waiters.push(resolve));
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            if (handle !== undefined) host.cancelFrame?.(handle);
            handle = undefined;
            tweens.clear();
            tasks.clear();
            settle();
        }
    };
}
