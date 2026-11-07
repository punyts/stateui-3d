import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { createScene3d } from '../src/scene3d.ts';
import type { Scene3d } from '../src/scene3d.ts';
import type { Scene3dIssue } from '../src/scene.ts';
import type { JsonValue, Scene3dSettings, Scene3dTree } from '../src/tree.ts';
import { draw, front, node } from './pixels.ts';

// G3.9b of the graphics epic 3: `animate` (`spin`, `bob`, `pulse`) and the animation clips of a GLB `model`

/** The fixture `test/fixtures/box-clips.glb`: the unit box of `box.glb` with the clips `slide` (x 0 to 1) and `lift` (y 0 to 1), 1 s each */
const CLIPS_FIXTURE = Uint8Array.from(atob(inject('clipsFixture')), (c) => c.charCodeAt(0)).buffer;
const SETTINGS: Scene3dSettings = { background: '#0000ff', environment: 'none' };
const CHAIR = '$.app.children.chair';
const BOX = '$.app.children.box';

const ref = (id: string): JsonValue => ({ id, name: `${id}.glb`, size: CLIPS_FIXTURE.byteLength, type: 'model/gltf-binary' });
const light = (): Scene3dTree => node('light', 'sun', { kind: 'ambient', intensity: 1 });
const box = (properties: Record<string, JsonValue> = {}): Scene3dTree => node('mesh', 'box', { geometry: { kind: 'box' }, material: { color: '#ff0000' }, ...properties });
const chair = (properties: Record<string, JsonValue> = {}): Scene3dTree => node('model', 'chair', { src: ref('chair'), ...properties });

const nextFrame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The width (x extent) of a node's bounds: 1 for the unit box at rest, more while `spin` has it turned */
function widthOf(scene: Scene3d, path: string): number {
    const bounds = scene.boundsOf(path);
    if (bounds === undefined) throw new Error(`${path} draws nothing`);
    return bounds.max[0] - bounds.min[0];
}

/** The centre of a node's bounds */
function centreOf(scene: Scene3d, path: string): number[] {
    const bounds = scene.boundsOf(path);
    if (bounds === undefined) throw new Error(`${path} draws nothing`);
    return bounds.min.map((min, axis) => (min + bounds.max[axis]!) / 2);
}

/** Waits until a model has loaded */
async function loaded(scene: Scene3d): Promise<void> {
    for (let i = 0; i < 200 && scene.info().models.loaded === 0; i += 1) await sleep(10);
    await scene.drawn();
}

describe('animate and model clips in Chromium (G3.9b)', () => {
    let host: HTMLElement;
    let scene: Scene3d;
    let issues: Scene3dIssue[];

    const make = (reducedMotion = false): Scene3d => {
        scene = createScene3d(host, {
            reducedMotion,
            readFile: (id) => (id === 'chair' ? Promise.resolve(CLIPS_FIXTURE.slice(0)) : Promise.reject({ code: 'not_found' })),
            onIssue: (issue) => issues.push(issue)
        });
        return scene;
    };

    beforeEach(() => {
        host = document.createElement('div');
        host.style.width = '100px';
        host.style.height = '100px';
        document.body.append(host);
        issues = [];
    });

    afterEach(() => {
        vi.restoreAllMocks();
        scene?.dispose();
        host.remove();
    });

    it('should turn a box with spin over time, frame by frame, and leave the tree it was given untouched', async () => {
        // Arrange
        const scene = make();
        const tree = [front(), light(), box({ animate: { name: 'spin', duration: 1000 } })];
        const given = JSON.stringify(tree);

        // Act: drawn() resolves after the first frame, not after the animation (it loops)
        await draw(scene, tree, SETTINGS);
        const widths: number[] = [];
        for (let i = 0; i < 20; i += 1) {
            await nextFrame();
            widths.push(widthOf(scene, BOX));
        }

        // Assert: turned off its rest (the unit box is wider while turned between quarter turns), with no state given back
        expect(scene.info().animations).toBe(1);
        expect(Math.max(...widths)).toBeGreaterThan(1.1);
        expect(new Set(widths.map((width) => width.toFixed(3))).size).toBeGreaterThan(3);
        expect(JSON.stringify(tree)).toBe(given);
    });

    it('should ask for no frame at rest with no animate and no playing clip', async () => {
        // Arrange
        const scene = make();
        await draw(scene, [front(), light(), box(), chair({ animation: 'slide', playing: false })], SETTINGS);
        await loaded(scene);
        await nextFrame();
        const frames = vi.spyOn(window, 'requestAnimationFrame');

        // Act
        await sleep(100);

        // Assert
        expect(frames).not.toHaveBeenCalled();
        expect(scene.info()).toMatchObject({ animations: 0, clips: 0, tweens: 0 });
    });

    it('should stop asking for frames when the animate goes', async () => {
        // Arrange
        const scene = make();
        await draw(scene, [front(), light(), box({ animate: { name: 'bob' } })], SETTINGS);
        await nextFrame();

        // Act
        await draw(scene, [front(), light(), box()], SETTINGS);
        await nextFrame();
        await nextFrame();
        const frames = vi.spyOn(window, 'requestAnimationFrame');
        await sleep(100);

        // Assert
        expect(frames).not.toHaveBeenCalled();
        expect(centreOf(scene, BOX)[1]).toBeCloseTo(0);
    });

    it('should play the named clip of the model while playing, then stop where it is on playing false and ask for no frame', async () => {
        // Arrange
        const scene = make();
        await draw(scene, [front(), light(), chair({ animation: 'slide', playing: true })], SETTINGS);
        await loaded(scene);
        const first = centreOf(scene, CHAIR)[0]!;

        // Act: about a third of the clip, then pause
        await sleep(300);
        await nextFrame();
        const playing = { x: centreOf(scene, CHAIR)[0]!, clips: scene.info().clips };
        await draw(scene, [front(), light(), chair({ animation: 'slide', playing: false })], SETTINGS);
        await nextFrame();
        const paused = centreOf(scene, CHAIR)[0]!;
        const frames = vi.spyOn(window, 'requestAnimationFrame');
        await sleep(200);

        // Assert: the box slid along x, then kept its place
        expect(first).toBeLessThan(0.2);
        expect(playing.clips).toBe(1);
        expect(playing.x).toBeGreaterThan(first + 0.1);
        expect(paused).toBeGreaterThanOrEqual(playing.x);
        expect(centreOf(scene, CHAIR)[0]).toBe(paused);
        expect(frames).not.toHaveBeenCalled();
        expect(scene.info().clips).toBe(0);
        expect(issues).toEqual([]);
    });

    it('should report an unknown clip with the names of the clips the file has, and play nothing', async () => {
        // Arrange
        const scene = make();

        // Act
        await draw(scene, [front(), light(), chair({ animation: 'walk', playing: true })], SETTINGS);
        await loaded(scene);

        // Assert
        expect(issues).toEqual([{ kind: 'model', path: CHAIR, node: 'model', reason: 'unknown_clip: the file has no clip "walk"; its clips are "slide", "lift"' }]);
        expect(scene.info().clips).toBe(0);
        expect(centreOf(scene, CHAIR)[0]).toBeCloseTo(0);
    });

    it('should turn both off with reduced motion: animate rests, the clip shows its first frame, no frame is asked for', async () => {
        // Arrange
        const scene = make();
        await draw(scene, [front(), light(), box({ animate: { name: 'spin' } }), chair({ animation: 'lift', playing: true, position: [2, 0, 0] })], SETTINGS);
        await loaded(scene);
        await sleep(300);
        await nextFrame();
        const before = { lifted: centreOf(scene, CHAIR)[1]!, info: scene.info() };

        // Act
        scene.setReducedMotion(true);
        await scene.drawn();
        const frames = vi.spyOn(window, 'requestAnimationFrame');
        await sleep(150);

        // Assert
        expect(before.lifted).toBeGreaterThan(0.1);
        expect(before.info).toMatchObject({ animations: 1, clips: 1 });
        expect(widthOf(scene, BOX)).toBeCloseTo(1);
        expect(centreOf(scene, CHAIR)[1]).toBeCloseTo(0);
        expect(scene.info()).toMatchObject({ animations: 0, clips: 0 });
        expect(frames).not.toHaveBeenCalled();
    });

    it('should play both from their beginning when reduced motion is turned off, and play nothing when made reduced', async () => {
        // Arrange
        const scene = make(true);
        await draw(scene, [front(), light(), box({ animate: { name: 'spin' } }), chair({ animation: 'lift', playing: true, position: [2, 0, 0] })], SETTINGS);
        await loaded(scene);
        const reduced = { info: scene.info(), lifted: centreOf(scene, CHAIR)[1]! };

        // Act
        scene.setReducedMotion(false);
        await sleep(300);
        await nextFrame();

        // Assert
        expect(reduced.info).toMatchObject({ animations: 0, clips: 0 });
        expect(reduced.lifted).toBeCloseTo(0);
        expect(scene.info()).toMatchObject({ animations: 1, clips: 1 });
        expect(centreOf(scene, CHAIR)[1]).toBeGreaterThan(0.1);
    });

    it('should free the mixer with the model when the node goes, and ask for no more frames', async () => {
        // Arrange
        const scene = make();
        await draw(scene, [front(), light(), chair({ animation: 'slide', playing: true })], SETTINGS);
        await loaded(scene);
        await nextFrame();

        // Act
        await draw(scene, [front(), light()], SETTINGS);
        await nextFrame();
        await nextFrame();
        const frames = vi.spyOn(window, 'requestAnimationFrame');
        await sleep(100);

        // Assert
        expect(scene.info()).toMatchObject({ clips: 0, models: { loading: 0, loaded: 0 } });
        expect(frames).not.toHaveBeenCalled();
    });
});
