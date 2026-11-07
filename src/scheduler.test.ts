import { describe, expect, it } from 'vitest';
import { DEFAULT_EASINGS, createScheduler, cubicBezier, durationToken, easingToken, isReducedMotion, parseCubicBezier, parseDuration, parseEasing } from './scheduler.js';
import type { Scheduler, SchedulerHost } from './scheduler.js';

/** A scheduler on a fake clock: `tick(ms)` moves the clock and runs the frame that was asked for */
function fakeScheduler(onFrame: SchedulerHost['onFrame'] = () => undefined): { scheduler: Scheduler; tick(ms: number): void; requested(): number; frames: Set<string>[] } {
    let time = 1000;
    let pending: (() => void) | undefined;
    let requests = 0;
    const frames: Set<string>[] = [];
    const scheduler = createScheduler({
        now: () => time,
        requestFrame(callback) {
            requests += 1;
            pending = callback;
            return requests;
        },
        cancelFrame() {
            pending = undefined;
        },
        onFrame(changed) {
            frames.push(new Set(changed));
            onFrame(changed);
        }
    });
    return {
        scheduler,
        tick(ms) {
            time += ms;
            const run = pending;
            pending = undefined;
            run?.();
        },
        requested: () => requests,
        frames
    };
}

const linear = { duration: 100, easing: cubicBezier(0, 0, 1, 1) };

describe('parseDuration', () => {
    it.each([
        ['200ms', 200],
        ['0.2s', 200],
        ['1.5s', 1500],
        [' 100ms ', 100],
        ['0ms', 0],
        ['0s', 0],
        ['0', 0],
        ['250', 250]
    ])('should read %s as %s milliseconds', (text, ms) => {
        expect(parseDuration(text)).toBe(ms);
    });

    it.each([['-1ms'], ['fast'], ['1min'], [''], ['ms']])('should not read %s', (text) => {
        expect(parseDuration(text)).toBeUndefined();
    });

    it('should count 0ms, 0s and 0 as reduced motion, and a missing or non-zero base as full motion', () => {
        for (const value of ['0ms', '0s', '0']) expect(isReducedMotion(() => value)).toBe(true);
        expect(isReducedMotion(() => '200ms')).toBe(false);
        expect(isReducedMotion(() => undefined)).toBe(false);
    });
});

describe('cubic-bezier easing', () => {
    it('should read cubic-bezier() and the CSS keywords, and refuse an x outside 0 to 1', () => {
        expect(parseCubicBezier('cubic-bezier(0.4, 0, 0.2, 1)')).toEqual([0.4, 0, 0.2, 1]);
        expect(parseCubicBezier('cubic-bezier(0.4,0,1,1)')).toEqual([0.4, 0, 1, 1]);
        expect(parseCubicBezier('linear')).toEqual([0, 0, 1, 1]);
        expect(parseCubicBezier('cubic-bezier(1.2, 0, 0.2, 1)')).toBeUndefined();
        expect(parseCubicBezier('cubic-bezier(0.4, 0, 0.2)')).toBeUndefined();
        expect(parseCubicBezier('steps(4)')).toBeUndefined();
    });

    it('should give a linear tween for a linear curve', () => {
        const easing = cubicBezier(0, 0, 1, 1);

        for (const t of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) expect(easing(t)).toBeCloseTo(t, 6);
    });

    it.each(Object.entries(DEFAULT_EASINGS))('should make the shipped %s curve monotonic, from 0 and ending at 1', (_, text) => {
        const easing = parseEasing(text)!;
        let last = easing(0);

        expect(last).toBe(0);
        for (let step = 1; step <= 100; step += 1) {
            const value = easing(step / 100);
            expect(value).toBeGreaterThanOrEqual(last - 1e-9);
            last = value;
        }
        expect(easing(1)).toBe(1);
    });

    it('should solve the curve for x: ease-in is slow at first, ease-out fast', () => {
        expect(parseEasing('ease-in')!(0.25)).toBeLessThan(0.25);
        expect(parseEasing('ease-out')!(0.25)).toBeGreaterThan(0.25);
        // The standard curve at half time, as the browser computes cubic-bezier(0.4, 0, 0.2, 1)
        expect(parseEasing(DEFAULT_EASINGS.standard)!(0.5)).toBeCloseTo(0.7752, 3);
    });

    it('should read the motion tokens from the theme, and fall back to the shipped ones', () => {
        const theme: Record<string, string> = { '--ui-motion-duration-slow': '1s', '--ui-motion-easing-enter': 'linear' };
        const read = (name: string): string | undefined => theme[name];

        expect(durationToken('slow', read)).toBe(1000);
        expect(durationToken('base', read)).toBe(200);
        expect(durationToken('medium', read)).toBeUndefined();
        expect(easingToken('enter', read)!(0.3)).toBeCloseTo(0.3, 6);
        expect(easingToken('exit', read)!(0.5)).toBeCloseTo(parseEasing(DEFAULT_EASINGS.exit)!(0.5), 9);
        expect(easingToken('bounce', read)).toBeUndefined();
    });
});

describe('createScheduler', () => {
    it('should tween a value at fixed times on the clock and end at the target', () => {
        // Arrange
        const { scheduler, tick } = fakeScheduler();

        // Act
        scheduler.tween('cx', 10, 90, linear);
        const values: unknown[] = [scheduler.valueOf('cx')];
        for (let step = 0; step < 4; step += 1) {
            tick(25);
            values.push(scheduler.valueOf('cx'));
        }

        // Assert: 0, 25, 50 and 75 ms of 100 are 10, 30, 50, 70; at 100 ms the tween has ended
        [10, 30, 50, 70].forEach((value, index) => expect(values[index]).toBeCloseTo(value, 6));
        expect(values[4]).toBeUndefined();
        expect(scheduler.idle).toBe(true);
    });

    it('should ease: the standard curve is behind linear at a quarter of the time and ahead at half', () => {
        // Arrange
        const { scheduler, tick } = fakeScheduler();

        // Act
        scheduler.tween('x', 0, 100, { duration: 100, easing: parseEasing(DEFAULT_EASINGS.standard)! });
        tick(25);
        const quarter = scheduler.valueOf('x') as number;
        tick(25);
        const half = scheduler.valueOf('x') as number;

        // Assert
        expect(quarter).toBeGreaterThan(0);
        expect(quarter).toBeLessThan(25);
        expect(half).toBeGreaterThan(50);
        expect(half).toBeLessThan(100);
    });

    it('should start a new value mid-tween from the current value, for the whole duration', () => {
        // Arrange
        const { scheduler, tick } = fakeScheduler();
        scheduler.tween('x', 0, 100, linear);
        tick(50);

        // Act: retarget at 50 (half way) to 0
        scheduler.tween('x', 100, 0, linear);
        const start = scheduler.valueOf('x');
        tick(50);

        // Assert
        expect(start).toBe(50);
        expect(scheduler.valueOf('x')).toBe(25);
    });

    it('should tween a list of numbers (a colour) part by part', () => {
        // Arrange
        const { scheduler, tick } = fakeScheduler();

        // Act
        scheduler.tween('fill', [0, 0, 0, 1], [200, 100, 50, 0], linear);
        tick(50);

        // Assert
        expect(scheduler.valueOf('fill')).toEqual([100, 50, 25, 0.5]);
    });

    it('should jump with reduced motion, a duration of 0 or values of another shape, asking for no frame', () => {
        // Arrange
        const { scheduler, requested } = fakeScheduler();

        // Act
        scheduler.tween('a', 0, 1, { ...linear, duration: 0 });
        scheduler.tween('b', 0, [1, 2], linear);
        scheduler.setReduced(true);
        scheduler.tween('c', 0, 1, linear);

        // Assert
        expect([scheduler.valueOf('a'), scheduler.valueOf('b'), scheduler.valueOf('c')]).toEqual([undefined, undefined, undefined]);
        expect(requested()).toBe(0);
        expect(scheduler.idle).toBe(true);
    });

    it('should end every running tween when motion becomes reduced, and tell the frame which ended', async () => {
        // Arrange
        const { scheduler, frames } = fakeScheduler();
        scheduler.tween('a', 0, 1, linear);
        let settled = false;
        void scheduler.settled().then(() => (settled = true));

        // Act
        const changed = scheduler.setReduced(true);
        await Promise.resolve();

        // Assert
        expect(changed).toBe(true);
        expect(scheduler.valueOf('a')).toBeUndefined();
        expect(frames).toEqual([new Set(['a'])]);
        expect(settled).toBe(true);
        expect(scheduler.setReduced(true)).toBe(false);
    });

    it('should be idle and ask for no frame with nothing moving, one frame per tick while tweening, and none after', () => {
        // Arrange
        const { scheduler, tick, requested } = fakeScheduler();

        // Act and assert
        expect(scheduler.idle).toBe(true);
        tick(16);
        expect(requested()).toBe(0);
        scheduler.tween('a', 0, 1, linear);
        scheduler.tween('b', 0, 1, linear);
        expect(requested()).toBe(1);
        for (let step = 0; step < 7; step += 1) tick(16);
        expect(requested()).toBe(7);
        tick(16);
        expect(scheduler.idle).toBe(true);
        tick(16);
        expect(requested()).toBe(7);
    });

    it('should resolve settled() once the last tween has ended', async () => {
        // Arrange
        const { scheduler, tick } = fakeScheduler();
        scheduler.tween('a', 0, 1, linear);
        let settled = false;
        void scheduler.settled().then(() => (settled = true));

        // Act
        tick(50);
        await Promise.resolve();
        const midway = settled;
        tick(50);
        await Promise.resolve();

        // Assert
        expect(midway).toBe(false);
        expect(settled).toBe(true);
    });

    it('should run frame tasks until they stop, and not while motion is reduced (for G1.8b)', () => {
        // Arrange
        const { scheduler, tick } = fakeScheduler();
        const times: number[] = [];

        // Act
        scheduler.request((now) => {
            times.push(now);
            return times.length < 3;
        });
        const remove = scheduler.request(() => true);
        scheduler.setReduced(true);
        tick(10);
        const whileReduced = times.length;
        scheduler.setReduced(false);
        for (let step = 0; step < 4; step += 1) tick(10);
        remove();
        tick(10);

        // Assert
        expect(whileReduced).toBe(0);
        expect(times).toEqual([1020, 1030, 1040]);
        expect(scheduler.idle).toBe(true);
    });

    it('should stop on dispose and resolve what waits', async () => {
        // Arrange
        const { scheduler } = fakeScheduler();
        scheduler.tween('a', 0, 1, linear);
        const settled = scheduler.settled();

        // Act
        scheduler.dispose();

        // Assert
        await expect(settled).resolves.toBeUndefined();
        expect(scheduler.idle).toBe(true);
    });
});
