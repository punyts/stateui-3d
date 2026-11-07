import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CameraMove } from '../src/controls.ts';
import { createScene3d } from '../src/scene3d.ts';
import type { Scene3d, Scene3dOptions } from '../src/scene3d.ts';
import type { JsonValue, Scene3dSettings, Scene3dTree } from '../src/tree.ts';
import { draw, expectColor, front, node, pixelAt } from './pixels.ts';

/** The host is 120 by 80 CSS pixels; the camera at z = 5 sees about 7 by 4.7 units */
const WIDTH = 120;
const HEIGHT = 80;
const RED = [255, 0, 0];
const BLUE = [0, 0, 255];
const SETTINGS: Scene3dSettings = { background: '#0000ff', environment: 'none' };
/** The tests' theme: `standard` is linear, so the box is half way at half the time */
const LINEAR: Scene3dOptions['readToken'] = (name) => (name === '--ui-motion-easing-standard' ? 'linear' : undefined);

const light = (): Scene3dTree => node('light', 'sun', { kind: 'ambient', intensity: 1 });
const box = (x: number, transition: JsonValue = { duration: 1000 }): Scene3dTree =>
    node('mesh', 'box', { position: [x, 0, 0], geometry: { kind: 'box' }, material: { color: '#ff0000' }, transition });

/** Where a box at x stands on screen, as a fraction of the width (7 units across at the box's depth) */
const screenX = (x: number): number => 0.5 + x / 7;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const nextFrame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));

function pointer(host: HTMLElement, type: string, x: number, y: number): void {
    const canvas = host.querySelector('canvas') as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const buttons = type === 'pointerup' ? 0 : 1;
    canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, composed: true, cancelable: true, clientX: rect.left + x, clientY: rect.top + y, pointerId: 1, button: 0, buttons, pointerType: 'mouse', isPrimary: true }));
}

describe('transition of 3D nodes in Chromium (G3.9)', () => {
    let host: HTMLElement | undefined;
    let scene: Scene3d | undefined;

    const make = (options: Scene3dOptions = {}): Scene3d => {
        host = document.createElement('div');
        host.style.width = `${WIDTH}px`;
        host.style.height = `${HEIGHT}px`;
        document.body.append(host);
        scene = createScene3d(host, { readToken: LINEAR, ...options });
        return scene;
    };

    afterEach(() => {
        vi.restoreAllMocks();
        scene?.dispose();
        host?.remove();
        scene = undefined;
        host = undefined;
    });

    it('should move a box along its tween on screen, frame by frame, and be drawn once it reaches its target', async () => {
        // Arrange
        const scene = make();
        await draw(scene, [front(), light(), box(-1.5)], SETTINGS);
        const start = [pixelAt(host!, screenX(-1.5)), pixelAt(host!, screenX(1.5))];

        // Act: read the centre in every frame of the tween, and both ends in the frame it ends in
        const began = performance.now();
        scene.update([front(), light(), box(1.5)], SETTINGS);
        const tweens = scene.info().tweens;
        let done = false;
        let end: number[][] = [];
        const finished = scene.drawn().then(() => {
            done = true;
            end = [pixelAt(host!, screenX(-1.5)), pixelAt(host!, screenX(1.5))];
        });
        const centres: number[][] = [];
        while (!done) {
            await nextFrame();
            if (!done) centres.push(pixelAt(host!, 0.5));
        }
        await finished;
        const took = performance.now() - began;

        // Assert: red on the left, then in the middle on the way, then on the right
        expectColor(start[0]!, RED);
        expectColor(start[1]!, BLUE);
        expect(tweens).toBe(1);
        expect(centres.some((pixel) => pixel[0]! > 200 && pixel[2]! < 50), 'the box crossed the centre').toBe(true);
        expectColor(end[0]!, BLUE);
        expectColor(end[1]!, RED);
        expect(took).toBeGreaterThanOrEqual(900);
        expect(scene.info().tweens).toBe(0);
    });

    it('should jump with reduced motion, in one frame', async () => {
        // Arrange
        const scene = make({ reducedMotion: true });
        await draw(scene, [front(), light(), box(-1.5)], SETTINGS);
        const frames = vi.spyOn(window, 'requestAnimationFrame');

        // Act
        scene.update([front(), light(), box(1.5)], SETTINGS);
        let right: number[] = [];
        await scene.drawn().then(() => {
            right = pixelAt(host!, screenX(1.5));
        });

        // Assert
        expect(scene.info().tweens).toBe(0);
        expect(frames).toHaveBeenCalledTimes(1);
        expectColor(right, RED);
    });

    it('should end a running tween at its target when motion becomes reduced', async () => {
        // Arrange
        const scene = make();
        await draw(scene, [front(), light(), box(-1.5)], SETTINGS);
        scene.update([front(), light(), box(1.5, { duration: 5000 })], SETTINGS);
        await nextFrame();
        await nextFrame();
        const during = scene.info().tweens;

        // Act
        scene.setReducedMotion(true);
        let right: number[] = [];
        const drawn = scene.drawn().then(() => {
            right = pixelAt(host!, screenX(1.5));
        });
        scene.update([front(), light(), box(1.5, { duration: 5000 })], SETTINGS);
        await drawn;

        // Assert
        expect(during).toBe(1);
        expect(scene.info().tweens).toBe(0);
        expectColor(right, RED);
    });

    it('should ask for no frame at rest, and none after a tween ends', async () => {
        // Arrange
        const scene = make();
        await draw(scene, [front(), light(), box(-1.5, { duration: 100 })], SETTINGS);
        scene.update([front(), light(), box(1.5, { duration: 100 })], SETTINGS);
        await scene.drawn();
        const frames = vi.spyOn(window, 'requestAnimationFrame');

        // Act
        await sleep(250);
        scene.update([front(), light(), box(1.5, { duration: 100 })], SETTINGS);
        await scene.drawn();
        await sleep(150);

        // Assert: an update that changes nothing draws one frame and tweens nothing
        expect(frames).toHaveBeenCalledTimes(1);
        expect(scene.info().tweens).toBe(0);
    });

    it('should end the camera\'s tween at once when an orbit gesture starts, so the gesture does not fight it', async () => {
        // Arrange: the camera tweens from z = 5 to z = 10 over 5 s
        const moves: CameraMove[] = [];
        const scene = make({ onCamera: (move) => moves.push(move) });
        const camera = (z: number): Scene3dTree => front({ position: [0, 0, z], transition: { duration: 5000 } });
        const settings: Scene3dSettings = { ...SETTINGS, controls: 'orbit' };
        await draw(scene, [camera(5), light(), box(0)], settings);
        scene.update([camera(10), light(), box(0)], settings);
        await nextFrame();
        await nextFrame();
        const during = scene.info().tweens;

        // Act: a drag
        pointer(host!, 'pointerdown', 60, 40);
        const atStart = scene.info().tweens;
        // A state write of the camera during the gesture jumps (it is shown when the gesture ends)
        scene.update([camera(10), light(), box(0)], settings);
        const afterWrite = scene.info().tweens;
        pointer(host!, 'pointermove', 65, 40);
        pointer(host!, 'pointermove', 70, 40);
        pointer(host!, 'pointerup', 70, 40);
        await scene.drawn();

        // Assert: one write, from the camera's end (distance 10 from its target), not from where the tween was
        expect(during).toBe(1);
        expect(atStart).toBe(0);
        expect(afterWrite).toBe(0);
        expect(moves).toHaveLength(1);
        expect(Math.hypot(...moves[0]!.position)).toBeCloseTo(10, 3);
    });

    it('should not tween the camera a gesture wrote when it comes back as state', async () => {
        // Arrange
        const moves: CameraMove[] = [];
        const scene = make({ onCamera: (move) => moves.push(move) });
        const camera = (position: JsonValue, target: JsonValue = [0, 0, 0]): Scene3dTree => front({ position, target, transition: { duration: 5000 } });
        const settings: Scene3dSettings = { ...SETTINGS, controls: 'orbit' };
        await draw(scene, [camera([0, 0, 5]), light(), box(0)], settings);
        pointer(host!, 'pointerdown', 60, 40);
        pointer(host!, 'pointermove', 70, 40);
        pointer(host!, 'pointerup', 70, 40);
        await scene.drawn();
        const [move] = moves;

        // Act: the feeder writes it, and the state gives it back
        scene.update([camera([...move!.position], [...move!.target]), light(), box(0)], settings);
        const tweens = scene.info().tweens;
        await scene.drawn();

        // Assert
        expect(moves).toHaveLength(1);
        expect(tweens).toBe(0);
    });

    it('should tween a camera that state moves after a gesture from the view the gesture left', async () => {
        // Arrange
        const moves: CameraMove[] = [];
        const scene = make({ onCamera: (move) => moves.push(move) });
        const camera = (position: JsonValue): Scene3dTree => front({ position, transition: { duration: 5000 } });
        const settings: Scene3dSettings = { ...SETTINGS, controls: 'orbit' };
        await draw(scene, [camera([0, 0, 5]), light(), box(0)], settings);
        // A gesture whose write is not fed back: the controls hold the camera where the gesture left it
        pointer(host!, 'pointerdown', 60, 40);
        pointer(host!, 'pointermove', 80, 40);
        pointer(host!, 'pointerup', 80, 40);
        await scene.drawn();
        const left = scene.info().tweens;

        // Act: state moves the camera to the front ("reset view")
        scene.update([camera([0, 0, 6]), light(), box(0)], settings);
        await nextFrame();

        // Assert: the position tweens (from the view the gesture left; the target was the same)
        expect(left).toBe(0);
        expect(moves).toHaveLength(1);
        expect(scene.info().tweens).toBe(1);
    });
});
