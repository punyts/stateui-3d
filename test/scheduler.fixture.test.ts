import { describe, expect, it } from 'vitest';
import { createScheduler, isReducedMotion, parseDuration, parseEasing } from '../src/scheduler.ts';
import type { TweenValue } from '../src/scheduler.ts';
import fixture from './fixtures/scheduler.fixture.json';

/**
 * The shared fixture of the motion scheduler (G3.9 of the graphics epic 3). The scheduler is in
 * `@punyts/stateui-components` (`src/shared/drawing/scheduler.ts`) and, as a copy, in `@punyts/stateui-3d`
 * (`src/scheduler.ts`). The same `test/fixtures/scheduler.fixture.json` is committed in both repositories and this test
 * is the same on both sides (only the import of the scheduler differs), so a change to one copy that changes a value fails until the other copy
 * and the fixture change with it
 */

interface TweenCase {
    readonly easing: string;
    readonly duration: string;
    readonly from: TweenValue;
    readonly to: TweenValue;
    readonly times: readonly number[];
    readonly retarget?: { readonly at: number; readonly to: TweenValue };
    readonly values: readonly TweenValue[];
}

/** Runs a tween case on a fake clock: the tween starts at 0, and at each time the frame asked for runs */
function run(item: TweenCase): TweenValue[] {
    let time = 0;
    let pending: (() => void) | undefined;
    const scheduler = createScheduler({
        now: () => time,
        requestFrame: (callback) => {
            pending = callback;
            return 1;
        },
        cancelFrame: () => (pending = undefined),
        onFrame: () => undefined
    });
    const timing = { duration: parseDuration(item.duration)!, easing: parseEasing(item.easing)! };
    let to = item.to;
    scheduler.tween('key', item.from, to, timing);
    const values: TweenValue[] = [];
    for (const at of item.times) {
        time = at;
        const frame = pending;
        pending = undefined;
        frame?.();
        if (item.retarget !== undefined && at === item.retarget.at) {
            scheduler.tween('key', to, item.retarget.to, timing);
            to = item.retarget.to;
        }
        values.push(scheduler.valueOf('key') ?? to);
    }
    return values;
}

function expectValue(actual: TweenValue | undefined, expected: TweenValue, label: string): void {
    if (typeof expected === 'number') {
        expect(actual, label).toBeTypeOf('number');
        expect(actual as number, label).toBeCloseTo(expected, 8);
        return;
    }
    expect(Array.isArray(actual), label).toBe(true);
    const list = actual as readonly number[];
    expect(list, label).toHaveLength(expected.length);
    expected.forEach((value, index) => expect(list[index], `${label}[${index}]`).toBeCloseTo(value, 8));
}

describe('the shared scheduler fixture (G3.9)', () => {
    it.each(fixture.durations)('should read the duration "$text" as $ms', ({ text, ms }) => {
        expect(parseDuration(text) ?? null).toBe(ms);
    });

    it.each(fixture.reduced)('should take a motion.duration.base of $base as reduced: $reduced', ({ base, reduced }) => {
        expect(isReducedMotion(() => base ?? undefined)).toBe(reduced);
    });

    it.each(fixture.easings)('should ease $easing to the fixture values', ({ easing, times, values }) => {
        const curve = parseEasing(easing);

        expect(curve).toBeDefined();
        times.forEach((t, index) => expectValue(curve!(t), values[index]!, `${easing} at ${t}`));
    });

    it.each(fixture.refusedEasings)('should refuse the easing %s', (easing) => {
        expect(parseEasing(easing)).toBeUndefined();
    });

    it.each(fixture.tweens as TweenCase[])('should tween with $easing over $duration to the fixture values', (item) => {
        const values = run(item);

        item.values.forEach((value, index) => expectValue(values[index], value, `at ${item.times[index]} ms`));
    });
});
