import { describe, expect, it } from 'vitest';
import { BOB_HEIGHT, DEFAULT_ANIMATION_DURATION, PULSE_GROWTH, animatedProperties3d, createAnimations3d, readAnimation3d } from './animate.js';
import type { Animations3d } from './animate.js';
import { createScheduler } from './scheduler.js';
import type { Scheduler } from './scheduler.js';
import type { JsonValue, Node3dKind, Scene3dTree } from './tree.js';

const ROOT = '$.app.children';

const node = (kind: Node3dKind, key: string, properties: Record<string, JsonValue>, children: Scene3dTree[] = []): Scene3dTree => ({
    kind,
    key,
    path: `${ROOT}.${key}`,
    properties,
    children
});

/** Animations on a scheduler with a fake clock: `tick(ms)` moves the clock and runs the frame that was asked for */
function fakeAnimations(): { animations: Animations3d; scheduler: Scheduler; tick(ms: number): void; requested(): number; waiting(): boolean } {
    let time = 0;
    let pending: (() => void) | undefined;
    let requests = 0;
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
        onFrame: () => undefined
    });
    return {
        animations: createAnimations3d(scheduler),
        scheduler,
        tick(ms) {
            time += ms;
            const run = pending;
            pending = undefined;
            run?.();
        },
        requested: () => requests,
        waiting: () => pending !== undefined
    };
}

const spinner = (animate: JsonValue = { name: 'spin' }, properties: Record<string, JsonValue> = {}): Scene3dTree => node('mesh', 'box', { geometry: { kind: 'box' }, animate, ...properties });

const propertyOf = (tree: readonly Scene3dTree[], name: string): JsonValue | undefined => tree[0]?.properties[name];

describe('readAnimation3d', () => {
    it('should read the name and the defaults of the 2D animate', () => {
        // Act
        const animation = readAnimation3d({ name: 'bob' });

        // Assert
        expect(animation).toEqual({ name: 'bob', duration: DEFAULT_ANIMATION_DURATION, loop: true, delay: 0 });
    });

    it('should refuse an unknown name, a 2D-only name and a value that is not an object', () => {
        // Act
        const results = [readAnimation3d({ name: 'wobble' }), readAnimation3d({ name: 'fade' }), readAnimation3d('spin'), readAnimation3d(null)];

        // Assert
        expect(results).toEqual([undefined, undefined, undefined, undefined]);
    });
});

describe('animatedProperties3d', () => {
    it('should turn spin about the y axis over the node rotation, a full turn over a cycle', () => {
        // Arrange
        const tree = node('mesh', 'box', { rotation: [10, 20, 30] });
        const animation = readAnimation3d({ name: 'spin' })!;

        // Act
        const quarter = animatedProperties3d(tree, animation, 0.25);

        // Assert
        expect(quarter).toEqual({ rotation: [10, 110, 30] });
    });

    it('should lift bob by BOB_HEIGHT at the middle of a cycle and rest at its ends, from the light default position', () => {
        // Arrange
        const animation = readAnimation3d({ name: 'bob' })!;

        // Act
        const middle = animatedProperties3d(node('mesh', 'box', { position: [1, 2, 3] }), animation, 0.5);
        const end = animatedProperties3d(node('mesh', 'box', { position: [1, 2, 3] }), animation, 0);
        const light = animatedProperties3d(node('light', 'sun', {}), animation, 0.5);

        // Assert
        expect(middle).toEqual({ position: [1, 2 + BOB_HEIGHT, 3] });
        expect(end).toEqual({ position: [1, 2, 3] });
        expect(light).toEqual({ position: [5, 10 + BOB_HEIGHT, 5] });
    });

    it('should grow pulse by PULSE_GROWTH of the node scale at the middle of a cycle', () => {
        // Arrange
        const animation = readAnimation3d({ name: 'pulse' })!;

        // Act
        const middle = animatedProperties3d(node('mesh', 'box', { scale: [2, 1, 1] }), animation, 0.5);

        // Assert
        expect(middle.scale).toEqual([2 * (1 + PULSE_GROWTH), 1 + PULSE_GROWTH, 1 + PULSE_GROWTH]);
    });
});

describe('createAnimations3d', () => {
    it('should play spin frame by frame with a fake clock, from the resting values in the first frame', () => {
        // Arrange
        const { animations, tick } = fakeAnimations();

        // Act
        const first = animations.follow([spinner()]);
        tick(0);
        const start = animations.decorate([spinner()]);
        tick(250);
        const quarter = animations.decorate([spinner()]);

        // Assert
        expect(propertyOf(first, 'rotation')).toBeUndefined();
        expect(propertyOf(start, 'rotation')).toEqual([0, 0, 0]);
        expect(propertyOf(quarter, 'rotation')).toEqual([0, 90, 0]);
        expect(animations.playing).toBe(1);
    });

    it('should ask for no frame when no node animates, and stop asking when the animate goes', () => {
        // Arrange
        const { animations, tick, requested, waiting } = fakeAnimations();

        // Act
        animations.follow([node('mesh', 'box', { geometry: { kind: 'box' } })]);
        const atRest = requested();
        animations.follow([spinner()]);
        tick(16);
        animations.follow([node('mesh', 'box', { geometry: { kind: 'box' } })]);
        tick(16);

        // Assert
        expect(atRest).toBe(0);
        expect(waiting()).toBe(false);
        expect(animations.playing).toBe(0);
    });

    it('should stop asking for frames after one cycle with loop false, and rest', () => {
        // Arrange
        const { animations, tick, waiting } = fakeAnimations();
        const once = spinner({ name: 'spin', duration: 100, loop: false });

        // Act
        animations.follow([once]);
        tick(0);
        tick(50);
        const during = animations.decorate([once]);
        tick(60);

        // Assert
        expect(propertyOf(during, 'rotation')).toEqual([0, 180, 0]);
        expect(propertyOf(animations.decorate([once]), 'rotation')).toBeUndefined();
        expect(waiting()).toBe(false);
    });

    it('should rest with reduced motion and ask for no frame, and start from the beginning when it is turned off', () => {
        // Arrange
        const { animations, scheduler, tick, waiting } = fakeAnimations();
        animations.follow([spinner()]);
        tick(0);
        tick(300);

        // Act
        scheduler.setReduced(true);
        const reduced = animations.follow([spinner()]);
        const frameWhileReduced = waiting();
        scheduler.setReduced(false);
        animations.restart();
        tick(1000);
        const restarted = animations.decorate([spinner()]);
        tick(100);

        // Assert
        expect(propertyOf(reduced, 'rotation')).toBeUndefined();
        expect(frameWhileReduced).toBe(false);
        expect(propertyOf(restarted, 'rotation')).toEqual([0, 0, 0]);
        expect(propertyOf(animations.decorate([spinner()]), 'rotation')).toEqual([0, 36, 0]);
    });

    it('should not play the animate of a camera, a hidden node or a repeat3d copy, and play the repeat own animate', () => {
        // Arrange
        const { animations, tick } = fakeAnimations();
        const copy: Scene3dTree = { kind: 'mesh', key: 'r1', path: `${ROOT}.shelf.rows.r1`, properties: { animate: { name: 'spin' } }, children: [] };
        const tree = [
            node('camera', 'eye', { animate: { name: 'bob' } }),
            node('mesh', 'gone', { hidden: true, animate: { name: 'spin' } }),
            node('repeat3d', 'shelf', { animate: { name: 'pulse' } }, [copy])
        ];

        // Act
        animations.follow(tree);
        tick(0);
        tick(500);
        const drawn = animations.decorate(tree);

        // Assert
        expect(drawn[0]).toBe(tree[0]);
        expect(drawn[1]).toBe(tree[1]);
        expect(drawn[2]?.properties.scale).toEqual([1 + PULSE_GROWTH, 1 + PULSE_GROWTH, 1 + PULSE_GROWTH]);
        expect(drawn[2]?.children[0]).toBe(copy);
        expect(animations.playing).toBe(1);
    });

    it('should play an animate inside a group, giving new objects only along its path', () => {
        // Arrange
        const { animations, tick } = fakeAnimations();
        const still = node('mesh', 'still', {});
        const inner: Scene3dTree = { kind: 'mesh', key: 'inner', path: `${ROOT}.rack.children.inner`, properties: { animate: { name: 'bob', duration: 1000 } }, children: [] };
        const tree = [still, node('group3d', 'rack', {}, [inner])];

        // Act
        animations.follow(tree);
        tick(0);
        tick(500);
        const drawn = animations.decorate(tree);

        // Assert
        expect(drawn[0]).toBe(still);
        expect(drawn[1]?.children[0]?.properties.position).toEqual([0, BOB_HEIGHT, 0]);
    });
});
