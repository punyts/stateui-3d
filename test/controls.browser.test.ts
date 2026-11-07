import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WHEEL_IDLE } from '../src/gesture.ts';
import { KEY_ROTATE_STEP, KEY_ZOOM_STEP } from '../src/controls.ts';
import type { CameraMove } from '../src/controls.ts';
import { createScene3d } from '../src/scene3d.ts';
import type { Scene3d } from '../src/scene3d.ts';
import type { JsonValue, Scene3dTree } from '../src/tree.ts';
import { draw, front, node, pixels } from './pixels.ts';

/** The host is 120 by 80 CSS pixels: a pointer move of 20 pixels turns the camera by a quarter turn (2 pi per height) */
const WIDTH = 120;
const HEIGHT = 80;

const red = (): Scene3dTree => node('mesh', 'box', { geometry: { kind: 'box' }, material: { color: '#ff0000' } });
/** A green marker beside the box, so a turn of the camera moves something on screen */
const marker = (): Scene3dTree => node('mesh', 'marker', { position: [1.5, 0, 0], geometry: { kind: 'box', width: 0.5, height: 0.5, depth: 0.5 }, material: { color: '#00ff00' } });
const sun = (): Scene3dTree => node('light', 'sun', { kind: 'ambient', intensity: 1 });
const settings = (controls: JsonValue): { background: string; environment: string; controls: JsonValue } => ({ background: '#0000ff', environment: 'none', controls });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The picture as RGB bytes, read in the task of the frame (the drawing buffer is not kept after it) */
function picture(host: HTMLElement): Picture {
    const { data } = pixels(host);
    return new Picture(data);
}

/** A picture of the canvas, every pixel as RGBA */
class Picture {
    constructor(readonly data: Uint8Array) {}

    /** The share of pixels that differ by more than 32 in a channel from another picture */
    differenceTo(other: Picture): number {
        let differing = 0;
        const count = this.data.length / 4;
        for (let at = 0; at < this.data.length; at += 4) {
            for (let channel = 0; channel < 3; channel += 1) {
                if (Math.abs((this.data[at + channel] ?? 0) - (other.data[at + channel] ?? 0)) > 32) {
                    differing += 1;
                    break;
                }
            }
        }
        return differing / count;
    }
}

/** True when fewer than 1% of the pixels differ by more than 32 in a channel (software rendering noise at the edges) */
const same = (a: Picture, b: Picture): boolean => a.differenceTo(b) < 0.01;

/** Waits for the frame the scene asked for and reads it */
async function shown(scene: Scene3d, host: HTMLElement): Promise<Picture> {
    await scene.drawn();
    return picture(host);
}

/** Dispatches a mouse pointer event on the canvas at a point in CSS pixels of the host */
function pointer(host: HTMLElement, type: string, x: number, y: number): void {
    const canvas = host.querySelector('canvas') as HTMLCanvasElement;
    const box = canvas.getBoundingClientRect();
    const buttons = type === 'pointerup' ? 0 : 1;
    canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, composed: true, cancelable: true, clientX: box.left + x, clientY: box.top + y, pointerId: 1, button: 0, buttons, pointerType: 'mouse', isPrimary: true }));
}

function wheel(host: HTMLElement, deltaY: number): void {
    const canvas = host.querySelector('canvas') as HTMLCanvasElement;
    const box = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: box.left + WIDTH / 2, clientY: box.top + HEIGHT / 2, deltaY, deltaMode: 0 }));
}

function key(target: EventTarget, type: 'keydown' | 'keyup', name: string, code: string): KeyboardEvent {
    const event = new KeyboardEvent(type, { key: name, code, bubbles: true, cancelable: true, composed: true });
    target.dispatchEvent(event);
    return event;
}

const length = (v: readonly number[]): number => Math.hypot(...v);

describe('orbit and pan controls of the 3D renderer in Chromium (G3.8b)', () => {
    let host: HTMLElement;
    let scene: Scene3d;
    let moves: CameraMove[];

    beforeEach(() => {
        host = document.createElement('div');
        host.style.width = `${WIDTH}px`;
        host.style.height = `${HEIGHT}px`;
        document.body.append(host);
        moves = [];
        scene = createScene3d(host, { onCamera: (move) => moves.push(move) });
    });

    afterEach(() => {
        scene.dispose();
        host.remove();
    });

    it('should turn the camera on every move of a pointer drag with no write, then write position and target once on release', async () => {
        // Arrange
        await draw(scene, [front(), red(), marker(), sun()], settings('orbit'));
        const before = picture(host);

        // Act
        pointer(host, 'pointerdown', 60, 40);
        const pictures: Picture[] = [];
        for (const x of [65, 70, 75]) {
            pointer(host, 'pointermove', x, 40);
            pictures.push(await shown(scene, host));
        }
        const duringGesture = moves.length;
        pointer(host, 'pointerup', 75, 40);
        await scene.drawn();

        // Assert: each move drew another picture; one write, a quarter turn (15 pixels of 80 is 3/16 of a turn) on the sphere of radius 5
        const all = [before, ...pictures];
        for (const [index, item] of all.entries()) if (index > 0) expect(same(item, all[index - 1] as Picture), `picture ${index}`).toBe(false);
        expect(duringGesture).toBe(0);
        expect(moves).toHaveLength(1);
        const [move] = moves;
        expect(move?.path).toBe('$.app.children.eye');
        expect(move?.target).toEqual([0, 0, 0]);
        expect(length(move?.position ?? [])).toBeCloseTo(5, 4);
        expect(Math.abs(Math.atan2(move?.position[0] ?? 0, move?.position[2] ?? 0))).toBeCloseTo((2 * Math.PI * 15) / HEIGHT, 3);
    });

    it('should keep the view after the release, and draw the same picture once the written camera comes back from state', async () => {
        // Arrange
        await draw(scene, [front(), red(), marker(), sun()], settings('orbit'));
        pointer(host, 'pointerdown', 60, 40);
        pointer(host, 'pointermove', 70, 40);
        pointer(host, 'pointerup', 70, 40);
        const released = await shown(scene, host);

        // Act: the feeder writes what it was told, and updates with it
        const move = moves[0] as CameraMove;
        await draw(scene, [front({ position: [...move.position], target: [...move.target] }), red(), marker(), sun()], settings('orbit'));
        const fromState = picture(host);

        // Assert
        expect(same(fromState, released)).toBe(true);
        expect(moves).toHaveLength(1);
    });

    it('should write nothing for a press with no move', async () => {
        // Arrange
        await draw(scene, [front(), red(), sun()], settings('orbit'));

        // Act
        pointer(host, 'pointerdown', 60, 40);
        pointer(host, 'pointerup', 60, 40);
        await scene.drawn();

        // Assert
        expect(moves).toEqual([]);
    });

    it(`should zoom with the wheel and write once, ${WHEEL_IDLE} ms after the last turn`, async () => {
        // Arrange
        await draw(scene, [front(), red(), sun()], settings('orbit'));
        const before = picture(host);

        // Act
        wheel(host, -100);
        await sleep(80);
        wheel(host, -100);
        await sleep(80);
        wheel(host, -100);
        const zoomed = await shown(scene, host);
        await sleep(WHEEL_IDLE - 60);
        const beforeIdle = moves.length;
        await sleep(160);

        // Assert
        expect(same(zoomed, before)).toBe(false);
        expect(beforeIdle).toBe(0);
        expect(moves).toHaveLength(1);
        expect(length(moves[0]?.position ?? [])).toBeLessThan(5);
        expect(moves[0]?.target).toEqual([0, 0, 0]);
    });

    it('should make the host focusable and turn and zoom with the keys, a step per press, written when the key is released', async () => {
        // Arrange
        await draw(scene, [front(), red(), marker(), sun()], settings('orbit'));
        const before = picture(host);

        // Act
        const tabIndex = host.getAttribute('tabindex');
        const left = key(host, 'keydown', 'ArrowLeft', 'ArrowLeft');
        const turned = await shown(scene, host);
        const whileHeld = moves.length;
        key(host, 'keyup', 'ArrowLeft', 'ArrowLeft');
        key(host, 'keydown', '+', 'Equal');
        await scene.drawn();
        key(host, 'keyup', '=', 'Equal');

        // Assert
        expect(tabIndex).toBe('0');
        expect(left.defaultPrevented).toBe(true);
        expect(same(turned, before)).toBe(false);
        expect(whileHeld).toBe(0);
        expect(moves).toHaveLength(2);
        const [turn, zoom] = moves;
        expect(length(turn?.position ?? [])).toBeCloseTo(5, 4);
        expect(Math.abs(Math.atan2(turn?.position[0] ?? 0, turn?.position[2] ?? 0))).toBeCloseTo(KEY_ROTATE_STEP, 4);
        expect(length(zoom?.position ?? [])).toBeCloseTo(5 * KEY_ZOOM_STEP, 4);
    });

    it('should pan with the pointer and the keys in pan, moving the target with the camera', async () => {
        // Arrange
        await draw(scene, [front(), red(), sun()], settings('pan'));

        // Act
        pointer(host, 'pointerdown', 60, 40);
        pointer(host, 'pointermove', 80, 40);
        pointer(host, 'pointerup', 80, 40);
        key(host, 'keydown', 'ArrowUp', 'ArrowUp');
        key(host, 'keyup', 'ArrowUp', 'ArrowUp');
        const zoomKey = key(host, 'keydown', '+', 'Equal');
        key(host, 'keyup', '+', 'Equal');
        wheel(host, -100);
        await sleep(WHEEL_IDLE + 60);

        // Assert: the pointer pan moved along x and the key along y; + and the wheel do nothing in pan
        expect(moves).toHaveLength(2);
        const [drag, up] = moves;
        expect(Math.abs(drag?.target[0] ?? 0)).toBeGreaterThan(0.1);
        expect(drag?.position[0]).toBeCloseTo(drag?.target[0] ?? NaN, 6);
        expect(drag?.position[2]).toBeCloseTo(5, 6);
        expect(Math.abs((up?.target[1] ?? 0) - (drag?.target[1] ?? 0))).toBeGreaterThan(0.1);
        expect(zoomKey.defaultPrevented).toBe(false);
    });

    it('should put the camera back on Escape during a drag and write nothing', async () => {
        // Arrange
        await draw(scene, [front(), red(), marker(), sun()], settings('orbit'));
        const before = picture(host);

        // Act
        pointer(host, 'pointerdown', 60, 40);
        pointer(host, 'pointermove', 70, 40);
        const moved = await shown(scene, host);
        const escape = key(document.body, 'keydown', 'Escape', 'Escape');
        const restored = await shown(scene, host);
        pointer(host, 'pointermove', 78, 40);
        pointer(host, 'pointerup', 78, 40);
        const after = await shown(scene, host);

        // Assert
        expect(same(moved, before)).toBe(false);
        expect(escape.defaultPrevented).toBe(true);
        expect(same(restored, before)).toBe(true);
        expect(same(after, before)).toBe(true);
        expect(moves).toEqual([]);
    });

    it('should apply a camera written by state during a gesture when the gesture ends, and write nothing', async () => {
        // Arrange: the picture of the camera state will write
        await draw(scene, [front({ position: [0, 0, 8] }), red(), marker(), sun()], settings('orbit'));
        const written = picture(host);
        await draw(scene, [front(), red(), marker(), sun()], settings('orbit'));

        // Act
        pointer(host, 'pointerdown', 60, 40);
        pointer(host, 'pointermove', 70, 40);
        const moved = await shown(scene, host);
        await draw(scene, [front({ position: [0, 0, 8] }), red(), marker(), sun()], settings('orbit'));
        const duringGesture = picture(host);
        pointer(host, 'pointerup', 70, 40);
        const ended = await shown(scene, host);

        // Assert
        expect(same(duringGesture, moved)).toBe(true);
        expect(same(ended, written)).toBe(true);
        expect(moves).toEqual([]);
    });

    it('should take no pointer, wheel or key input and write nothing with controls none', async () => {
        // Arrange
        await draw(scene, [front(), red(), marker(), sun()], settings('none'));
        const before = picture(host);

        // Act
        pointer(host, 'pointerdown', 60, 40);
        pointer(host, 'pointermove', 75, 40);
        pointer(host, 'pointerup', 75, 40);
        wheel(host, -100);
        const arrow = key(host, 'keydown', 'ArrowLeft', 'ArrowLeft');
        key(host, 'keyup', 'ArrowLeft', 'ArrowLeft');
        await sleep(WHEEL_IDLE + 60);
        scene.restyle();
        const after = await shown(scene, host);

        // Assert
        expect(host.hasAttribute('tabindex')).toBe(false);
        expect(arrow.defaultPrevented).toBe(false);
        expect(same(after, before)).toBe(true);
        expect(moves).toEqual([]);
    });

    it('should stop taking input when controls go back to none, and give the camera back to the tree', async () => {
        // Arrange
        await draw(scene, [front(), red(), marker(), sun()], settings('orbit'));
        const tree = picture(host);
        key(host, 'keydown', 'ArrowLeft', 'ArrowLeft');
        key(host, 'keyup', 'ArrowLeft', 'ArrowLeft');

        // Act
        await draw(scene, [front(), red(), marker(), sun()], settings('none'));
        const none = picture(host);
        key(host, 'keydown', 'ArrowLeft', 'ArrowLeft');
        key(host, 'keyup', 'ArrowLeft', 'ArrowLeft');

        // Assert
        expect(same(none, tree)).toBe(true);
        expect(moves).toHaveLength(1);
        expect(host.hasAttribute('tabindex')).toBe(false);
    });

    it('should move the default camera of a scene with no camera node and write nothing', async () => {
        // Arrange
        await draw(scene, [red(), marker(), sun()], settings('orbit'));
        const before = picture(host);

        // Act
        pointer(host, 'pointerdown', 60, 40);
        pointer(host, 'pointermove', 70, 40);
        pointer(host, 'pointerup', 70, 40);
        const after = await shown(scene, host);
        await draw(scene, [red(), marker(), sun()], settings('orbit'));
        const kept = picture(host);

        // Assert
        expect(same(after, before)).toBe(false);
        expect(same(kept, after)).toBe(true);
        expect(moves).toEqual([]);
    });
});
