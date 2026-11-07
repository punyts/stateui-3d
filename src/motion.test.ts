import { describe, expect, it } from 'vitest';
import { createMotion3d, formatRgb, timingOf } from './motion.js';
import type { Motion3d, Rgb } from './motion.js';
import { createScheduler, parseEasing } from './scheduler.js';
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

/** The theme of the tests: the `standard` curve is linear, so a tween's values are easy to name */
const THEME: Record<string, string> = { '--ui-motion-easing-standard': 'linear' };

/** `#rrggbb` as its channels; anything else names no colour */
const colorOf = (value: JsonValue): Rgb | undefined => {
    if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) return undefined;
    return [Number.parseInt(value.slice(1, 3), 16), Number.parseInt(value.slice(3, 5), 16), Number.parseInt(value.slice(5, 7), 16)];
};

/** Transitions on a scheduler with a fake clock: `tick(ms)` moves the clock and runs the frame that was asked for */
function fakeMotion(theme: Record<string, string> = THEME): { motion: Motion3d; scheduler: Scheduler; tick(ms: number): void; requested(): number } {
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
    const motion = createMotion3d({ scheduler, read: (name) => theme[name], colorOf });
    return {
        motion,
        scheduler,
        tick(ms) {
            time += ms;
            const run = pending;
            pending = undefined;
            run?.();
        },
        requested: () => requests
    };
}

const box = (properties: Record<string, JsonValue>): Scene3dTree => node('mesh', 'box', { transition: { duration: 100 }, ...properties });

/** A list of numbers close to another (the curve is solved numerically, so linear is linear to about 1e-15) */
function expectNear(actual: JsonValue | undefined, expected: readonly number[]): void {
    expect(Array.isArray(actual), JSON.stringify(actual)).toBe(true);
    expect(actual as number[]).toHaveLength(expected.length);
    expected.forEach((value, index) => expect((actual as number[])[index]).toBeCloseTo(value, 9));
}

const propertiesOf = (trees: readonly Scene3dTree[], index = 0): Readonly<Record<string, JsonValue>> => trees[index]!.properties;

describe('timingOf (G3.9)', () => {
    it('should read the duration in milliseconds or as a motion.duration token, from the theme or the shipped values', () => {
        const theme: Record<string, string> = { '--ui-motion-duration-fast': '0.5s' };
        const read = (name: string): string | undefined => theme[name];

        expect(timingOf({ duration: 250 }, read)?.duration).toBe(250);
        expect(timingOf({ duration: 'fast' }, read)?.duration).toBe(500);
        expect(timingOf({ duration: 'slow' }, read)?.duration).toBe(400);
        expect(timingOf({}, read)?.duration).toBe(200);
        expect(timingOf(undefined, read)).toBeUndefined();
        expect(timingOf('fast', read)).toBeUndefined();
    });

    it('should read the easing as the theme\'s cubic-bezier(), else the shipped curve', () => {
        const theme: Record<string, string> = { '--ui-motion-easing-enter': 'cubic-bezier(0, 0, 1, 1)' };
        const read = (name: string): string | undefined => theme[name];

        expect(timingOf({ easing: 'enter' }, read)?.easing(0.3)).toBeCloseTo(0.3, 6);
        expect(timingOf({ easing: 'exit' }, read)?.easing(0.5)).toBeCloseTo(parseEasing('cubic-bezier(0.4, 0, 1, 1)')!(0.5), 9);
        expect(timingOf({}, read)?.easing(0.5)).toBeCloseTo(parseEasing('cubic-bezier(0.4, 0, 0.2, 1)')!(0.5), 9);
    });

    it('should write a colour tween value as rgb() with whole channels', () => {
        expect(formatRgb([12.4, 300, -2])).toBe('rgb(12, 255, 0)');
    });
});

describe('createMotion3d (G3.9)', () => {
    it('should tween a changed position on the clock and end at the new value', () => {
        // Arrange
        const { motion, tick } = fakeMotion();
        motion.apply([box({ position: [0, 0, 0] })]);

        // Act
        const first = motion.apply([box({ position: [4, -2, 10] })]);
        tick(25);
        const quarter = motion.current();
        tick(25);
        const half = motion.current();
        tick(50);
        const end = motion.current();

        // Assert
        expect(propertiesOf(first).position).toEqual([0, 0, 0]);
        expectNear(propertiesOf(quarter).position, [1, -0.5, 2.5]);
        expectNear(propertiesOf(half).position, [2, -1, 5]);
        expect(propertiesOf(end).position).toEqual([4, -2, 10]);
        expect(motion.running).toBe(0);
    });

    it('should tween rotation and scale from their defaults, and a light\'s intensity and a camera\'s target', () => {
        // Arrange
        const { motion, tick } = fakeMotion();
        const light = (properties: Record<string, JsonValue>): Scene3dTree => node('light', 'sun', { transition: { duration: 100 }, ...properties });
        const camera = (properties: Record<string, JsonValue>): Scene3dTree => node('camera', 'eye', { transition: { duration: 100 }, ...properties });
        motion.apply([box({}), light({ intensity: 1, color: '#ffffff' }), camera({ target: [0, 0, 0], rotation: [0, 0, 0] })]);

        // Act
        motion.apply([box({ rotation: [0, 90, 0], scale: [3, 3, 3] }), light({ intensity: 3, color: '#ff0000' }), camera({ target: [2, 0, 0], rotation: [0, 90, 0] })]);
        tick(50);
        const half = motion.current();

        // Assert: the light's colour and the camera's rotation are not tweened
        expectNear(propertiesOf(half, 0).rotation, [0, 45, 0]);
        expectNear(propertiesOf(half, 0).scale, [2, 2, 2]);
        expect(propertiesOf(half, 1).intensity).toBeCloseTo(2, 9);
        expect(propertiesOf(half, 1).color).toBe('#ff0000');
        expectNear(propertiesOf(half, 2).target, [1, 0, 0]);
        expect(propertiesOf(half, 2).rotation).toEqual([0, 90, 0]);
    });

    it('should tween material.color in sRGB and material.opacity, and leave the other material fields at their new values', () => {
        // Arrange
        const { motion, tick } = fakeMotion();
        motion.apply([box({ material: { color: '#ff0000', opacity: 1, roughness: 1 } })]);

        // Act
        motion.apply([box({ material: { color: '#0000ff', opacity: 0.5, roughness: 0.2 } })]);
        tick(40);
        const half = motion.current();
        tick(60);
        const end = motion.current();

        // Assert
        const material = propertiesOf(half).material as Record<string, JsonValue>;
        expect(material.color).toBe('rgb(153, 0, 102)');
        expect(material.opacity).toBeCloseTo(0.8, 9);
        expect(material.roughness).toBe(0.2);
        expect(propertiesOf(end).material).toEqual({ color: '#0000ff', opacity: 0.5, roughness: 0.2 });
    });

    it('should jump a colour that names no colour it can read', () => {
        // Arrange
        const { motion } = fakeMotion();
        motion.apply([box({ material: { color: '#ff0000' } })]);

        // Act
        const next = motion.apply([box({ material: { color: '{color.no.such}' } })]);

        // Assert
        expect(propertiesOf(next).material).toEqual({ color: '{color.no.such}' });
        expect(motion.running).toBe(0);
    });

    it('should start a new value mid-tween from where the node is, for the whole duration', () => {
        // Arrange
        const { motion, tick } = fakeMotion();
        motion.apply([box({ position: [0, 0, 0] })]);
        motion.apply([box({ position: [10, 0, 0] })]);
        tick(50);

        // Act
        const retarget = motion.apply([box({ position: [0, 0, 0] })]);
        tick(50);

        // Assert
        expectNear(propertiesOf(retarget).position, [5, 0, 0]);
        expectNear(propertiesOf(motion.current()).position, [2.5, 0, 0]);
    });

    it('should jump a node without transition, a new node, and a node that gains transition with its change', () => {
        // Arrange
        const { motion, requested } = fakeMotion();
        motion.apply([node('mesh', 'plain', { position: [0, 0, 0] }), node('mesh', 'gains', { position: [0, 0, 0] })]);

        // Act
        const next = motion.apply([
            node('mesh', 'plain', { position: [1, 0, 0] }),
            node('mesh', 'gains', { position: [1, 0, 0], transition: { duration: 100 } }),
            node('mesh', 'fresh', { position: [1, 0, 0], transition: { duration: 100 } })
        ]);

        // Assert
        expect(next.map((tree) => tree.properties.position)).toEqual([
            [1, 0, 0],
            [1, 0, 0],
            [1, 0, 0]
        ]);
        expect(motion.running).toBe(0);
        expect(requested()).toBe(0);
    });

    it('should tween the nodes of a group3d, and leave a repeat3d\'s copies to jump', () => {
        // Arrange
        const { motion, tick } = fakeMotion();
        const child = (x: number): Scene3dTree => ({ ...node('mesh', 'part', { position: [x, 0, 0], transition: { duration: 100 } }), path: `${ROOT}.rig.children.part` });
        const copy = (x: number): Scene3dTree => ({ ...node('mesh', 'a', { position: [x, 0, 0], transition: { duration: 100 } }), path: `${ROOT}.many.rows.a` });
        motion.apply([node('group3d', 'rig', {}, [child(0)]), node('repeat3d', 'many', {}, [copy(0)])]);

        // Act
        motion.apply([node('group3d', 'rig', {}, [child(2)]), node('repeat3d', 'many', {}, [copy(2)])]);
        tick(50);
        const half = motion.current();

        // Assert
        expectNear(half[0]?.children[0]?.properties.position, [1, 0, 0]);
        expect(half[1]?.children[0]?.properties.position).toEqual([2, 0, 0]);
    });

    it('should jump with reduced motion and ask for no frame', () => {
        // Arrange
        const { motion, scheduler, requested } = fakeMotion();
        scheduler.setReduced(true);
        motion.apply([box({ position: [0, 0, 0] })]);

        // Act
        const next = motion.apply([box({ position: [4, 0, 0] })]);

        // Assert
        expect(propertiesOf(next).position).toEqual([4, 0, 0]);
        expect(motion.running).toBe(0);
        expect(requested()).toBe(0);
    });

    it('should end the running tweens at their new values when motion becomes reduced', () => {
        // Arrange
        const { motion, scheduler } = fakeMotion();
        motion.apply([box({ position: [0, 0, 0] })]);
        motion.apply([box({ position: [4, 0, 0] })]);

        // Act
        scheduler.setReduced(true);

        // Assert
        expect(propertiesOf(motion.current()).position).toEqual([4, 0, 0]);
        expect(motion.running).toBe(0);
    });

    it('should jump a node that is still (the camera during a gesture)', () => {
        // Arrange
        const { motion } = fakeMotion();
        const camera = (position: JsonValue): Scene3dTree => node('camera', 'eye', { position, transition: { duration: 100 } });
        motion.apply([camera([0, 0, 5])]);

        // Act
        const next = motion.apply([camera([0, 0, 9])], (tree) => tree.kind === 'camera');

        // Assert
        expect(propertiesOf(next).position).toEqual([0, 0, 9]);
        expect(motion.running).toBe(0);
    });

    it('should finish the tweens of the nodes picked at once, and keep the others', () => {
        // Arrange
        const { motion } = fakeMotion();
        const camera = (position: JsonValue): Scene3dTree => node('camera', 'eye', { position, transition: { duration: 100 } });
        motion.apply([camera([0, 0, 5]), box({ position: [0, 0, 0] })]);
        motion.apply([camera([0, 0, 9]), box({ position: [4, 0, 0] })]);

        // Act
        const ended = motion.finish((tree) => tree.kind === 'camera');
        const again = motion.finish((tree) => tree.kind === 'camera');

        // Assert
        expect(ended).toBe(true);
        expect(again).toBe(false);
        expect(propertiesOf(motion.current(), 0).position).toEqual([0, 0, 9]);
        expect(propertiesOf(motion.current(), 1).position).toEqual([0, 0, 0]);
        expect(motion.running).toBe(1);
    });

    it('should not tween values that were settled (the camera a gesture wrote)', () => {
        // Arrange
        const { motion } = fakeMotion();
        const camera = (position: JsonValue, target: JsonValue): Scene3dTree => node('camera', 'eye', { position, target, transition: { duration: 100 } });
        motion.apply([camera([0, 0, 5], [0, 0, 0])]);

        // Act
        motion.settle(`${ROOT}.eye`, { position: [3, 0, 4], target: [0, 1, 0] });
        const next = motion.apply([camera([3, 0, 4], [0, 1, 0])]);

        // Assert
        expect(propertiesOf(next)).toMatchObject({ position: [3, 0, 4], target: [0, 1, 0] });
        expect(motion.running).toBe(0);
    });

    it('should tween from settled values when the next tree brings others (a state write after a gesture)', () => {
        // Arrange
        const { motion } = fakeMotion();
        const camera = (position: JsonValue): Scene3dTree => node('camera', 'eye', { position, transition: { duration: 100 } });
        motion.apply([camera([0, 0, 5])]);

        // Act
        motion.settle(`${ROOT}.eye`, { position: [5, 0, 0] });
        const next = motion.apply([camera([0, 0, 5])]);

        // Assert: from the settled view, not from the tree before it
        expect(propertiesOf(next).position).toEqual([5, 0, 0]);
        expect(motion.running).toBe(1);
    });

    it('should stop the tweens of a node that goes or is hidden, and ask for no frame at rest', () => {
        // Arrange
        const { motion, tick, requested } = fakeMotion();
        motion.apply([box({ position: [0, 0, 0] })]);
        motion.apply([box({ position: [4, 0, 0] })]);

        // Act
        const hidden = motion.apply([box({ position: [4, 0, 0], hidden: true })]);
        tick(16);
        const afterHidden = requested();
        motion.apply([]);
        tick(16);
        tick(16);

        // Assert
        expect(propertiesOf(hidden).position).toEqual([4, 0, 0]);
        expect(motion.running).toBe(0);
        expect(requested()).toBe(afterHidden);
    });
});
