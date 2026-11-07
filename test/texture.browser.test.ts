import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScene3d } from '../src/scene3d.ts';
import type { Scene3d } from '../src/scene3d.ts';
import type { Scene3dIssue } from '../src/scene.ts';
import { MAP_BITMAP_OPTIONS } from '../src/textures.ts';
import type { JsonValue, Scene3dSettings, Scene3dTree } from '../src/tree.ts';
import { ROOT, draw, expectColor, node, pixelAt } from './pixels.ts';

/*
 * Textures from files (G3.7c of the graphics epic 3): a mesh's `material.map` is a picture file of the app's store, read
 * with the scene's `readFile`, decoded to an `ImageBitmap` and drawn as an sRGB texture the right way up.
 */

const BLACK_BG: Scene3dSettings = { background: '#000000', environment: 'none' };
const RED = [255, 0, 0, 255];
const GREEN = [0, 255, 0, 255];
const BLUE = [0, 0, 255, 255];
/** sRGB 128 grey: drawn as 128 only when the texture is taken as sRGB (as linear it would show near 186) */
const GREY = [128, 128, 128, 255];
const MAGENTA = [255, 0, 255, 255];
const WALL = `${ROOT}.wall`;
const REPEAT = `${ROOT}.tiles`;

/** A PNG of 64 by 64 pixels in quadrants: red top-left, green top-right, blue bottom-left, sRGB 128 grey bottom-right */
async function quadrants(): Promise<ArrayBuffer> {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext('2d') as CanvasRenderingContext2D;
    for (const [colour, x, y] of [
        ['#ff0000', 0, 0],
        ['#00ff00', 32, 0],
        ['#0000ff', 0, 32],
        ['#808080', 32, 32]
    ] as const) {
        context.fillStyle = colour;
        context.fillRect(x, y, 32, 32);
    }
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((made) => resolve(made as Blob), 'image/png'));
    return blob.arrayBuffer();
}

const picture = (id: string, type = 'image/png'): JsonValue => ({ id, name: `${id}.png`, size: 100, type });

/** A camera at z = 3 looking at the origin: a 2 by 2 plane fills the middle 71% of the canvas */
const eye = (): Scene3dTree => node('camera', 'eye', { position: [0, 0, 3], target: [0, 0, 0] });
/** An ambient light of intensity 1: a surface shows its own colour exactly */
const fill = (): Scene3dTree => node('light', 'fill', { kind: 'ambient' });
const wall = (material: Record<string, JsonValue>, key = 'wall', properties: Record<string, JsonValue> = {}): Scene3dTree =>
    node('mesh', key, { geometry: { kind: 'plane', width: 2, height: 2 }, material, ...properties });

describe('mesh material.map from a picture file in Chromium (G3.7c)', () => {
    let host: HTMLElement;
    let scene: Scene3d;
    let issues: Scene3dIssue[];
    let files: Record<string, ArrayBuffer>;
    let reads: string[];

    beforeEach(async () => {
        host = document.createElement('div');
        host.style.width = '100px';
        host.style.height = '100px';
        document.body.append(host);
        issues = [];
        reads = [];
        files = { plan: await quadrants(), other: await quadrants(), text: new TextEncoder().encode('not a picture').buffer as ArrayBuffer };
        scene = createScene3d(host, {
            readFile: (id) => {
                reads.push(id);
                const data = files[id];
                return data === undefined ? Promise.reject({ code: 'not_found' }) : Promise.resolve(data.slice(0));
            },
            onIssue: (issue) => issues.push(issue)
        });
    });

    afterEach(() => {
        scene.dispose();
        host.remove();
        vi.restoreAllMocks();
    });

    it('should draw the picture the right way up and in sRGB on a plane facing the camera, through createImageBitmap and no blob: URL', async () => {
        // Arrange
        const blobUrls = vi.spyOn(URL, 'createObjectURL');
        const decode = vi.spyOn(window, 'createImageBitmap');

        // Act
        await draw(scene, [eye(), fill(), wall({ map: picture('plan') })], BLACK_BG);

        // Assert: red at the top-left of the plane, the other quadrants where the picture has them
        expectColor(pixelAt(host, 0.35, 0.35), RED);
        expectColor(pixelAt(host, 0.65, 0.35), GREEN);
        expectColor(pixelAt(host, 0.35, 0.65), BLUE);
        expectColor(pixelAt(host, 0.65, 0.65), GREY);
        expectColor(pixelAt(host, 0.03, 0.03), [0, 0, 0, 255]);
        expect(reads).toEqual(['plan']);
        expect(blobUrls).not.toHaveBeenCalled();
        expect(decode).toHaveBeenCalledTimes(1);
        expect(decode.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
        expect(decode.mock.calls[0]?.[1]).toEqual(MAP_BITMAP_OPTIONS);
        expect(issues).toEqual([]);
        expect(scene.info().maps).toEqual({ loading: 0, loaded: 1 });
    });

    it('should tint the picture with the material colour, and keep the texture when only the colour changes', async () => {
        // Act
        await draw(scene, [eye(), fill(), wall({ map: picture('plan'), color: '#ff0000' })], BLACK_BG);
        const tinted = pixelAt(host, 0.65, 0.35);
        await draw(scene, [eye(), fill(), wall({ map: picture('plan'), color: '#ffffff' })], BLACK_BG);

        // Assert: green times red is black; the same file is not read again
        expectColor(tinted, [0, 0, 0, 255]);
        expectColor(pixelAt(host, 0.65, 0.35), GREEN);
        expect(reads).toEqual(['plan']);
    });

    it('should keep drawn() waiting while the file is read, and resolve after the frame with the texture', async () => {
        // Arrange
        let finish: (data: ArrayBuffer) => void = () => undefined;
        scene.dispose();
        scene = createScene3d(host, { readFile: () => new Promise<ArrayBuffer>((resolve) => (finish = resolve)), onIssue: (issue) => issues.push(issue) });
        let done = false;

        // Act
        scene.update([eye(), fill(), wall({ map: picture('plan') })], BLACK_BG);
        const drawn = scene.drawn().then(() => {
            done = true;
            return pixelAt(host, 0.35, 0.35);
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const waited = !done && scene.info().maps.loading === 1;
        finish(files.plan as ArrayBuffer);

        // Assert
        expect(waited).toBe(true);
        expectColor(await drawn, RED);
        expect(scene.info().maps).toEqual({ loading: 0, loaded: 1 });
    });

    it('should draw the colour only and tell a file issue for a missing file, bytes that are no picture and a file of another type', async () => {
        // Act: three planes side by side, each magenta under its map
        await draw(
            scene,
            [
                eye(),
                fill(),
                wall({ map: picture('gone'), color: '#ff00ff' }, 'gone', { geometry: { kind: 'plane', width: 0.5, height: 2 }, position: [-0.7, 0, 0] }),
                wall({ map: picture('text'), color: '#ff00ff' }, 'text', { geometry: { kind: 'plane', width: 0.5, height: 2 } }),
                wall({ map: picture('plan', 'model/gltf-binary'), color: '#ff00ff' }, 'glb', { geometry: { kind: 'plane', width: 0.5, height: 2 }, position: [0.7, 0, 0] })
            ],
            BLACK_BG
        );

        // Assert: the scene draws, each plane in its colour; the GLB-typed reference is not read
        expectColor(pixelAt(host, 0.5 - 0.7 / 2.8, 0.35), MAGENTA);
        expectColor(pixelAt(host, 0.5, 0.35), MAGENTA);
        expectColor(pixelAt(host, 0.5 + 0.7 / 2.8, 0.35), MAGENTA);
        expect(issues).toEqual([
            { kind: 'file', path: `${ROOT}.glb`, node: 'mesh', reason: 'unsupported_type' },
            expect.objectContaining({ kind: 'file', node: 'mesh' }),
            expect.objectContaining({ kind: 'file', node: 'mesh' })
        ]);
        expect(issues).toContainEqual({ kind: 'file', path: `${ROOT}.gone`, node: 'mesh', reason: 'not_found' });
        expect(issues).toContainEqual({ kind: 'file', path: `${ROOT}.text`, node: 'mesh', reason: 'not_an_image' });
        expect(reads.sort()).toEqual(['gone', 'text']);
        expect(scene.info().maps).toEqual({ loading: 0, loaded: 0 });

        // Act: a restyle applies the materials again, and tells nothing twice
        scene.restyle();
        await scene.drawn();

        // Assert
        expect(issues).toHaveLength(3);
        expect(reads).toHaveLength(2);
    });

    it('should free the texture with its node, and the old one when the map changes or goes (memory count)', async () => {
        // Arrange: a mesh without a map drawn first (three.js keeps a lookup texture of its own for the material)
        await draw(scene, [eye(), fill(), wall({ color: '#ff00ff' })], BLACK_BG);
        const before = scene.info().memory.textures;
        const close = vi.spyOn(ImageBitmap.prototype, 'close');

        // Act / Assert: a texture is held while the map draws
        await draw(scene, [eye(), fill(), wall({ map: picture('plan') })], BLACK_BG);
        expect(scene.info().memory.textures).toBe(before + 1);

        // Another file: the old texture is freed and its bitmap closed, the new one drawn
        await draw(scene, [eye(), fill(), wall({ map: picture('other') })], BLACK_BG);
        expect(scene.info().memory.textures).toBe(before + 1);
        expect(close).toHaveBeenCalledTimes(1);
        expect(reads).toEqual(['plan', 'other']);

        // No map: the colour only
        await draw(scene, [eye(), fill(), wall({ color: '#ff00ff' })], BLACK_BG);
        expect(scene.info().memory.textures).toBe(before);
        expect(close).toHaveBeenCalledTimes(2);
        expectColor(pixelAt(host, 0.35, 0.35), MAGENTA);

        // The map again, then the node goes
        await draw(scene, [eye(), fill(), wall({ map: picture('plan') })], BLACK_BG);
        expect(scene.info().memory.textures).toBe(before + 1);
        await draw(scene, [eye(), fill()], BLACK_BG);
        expect(scene.info().memory.textures).toBe(before);
        expect(close).toHaveBeenCalledTimes(3);
        expect(scene.info().maps).toEqual({ loading: 0, loaded: 0 });
        expect(scene.boundsOf(WALL)).toBeUndefined();
    });

    it('should share the first copy map across the instances of a repeat3d, read once, and free it with the repeat', async () => {
        // Arrange: two copies left and right, the same picture on both
        const copy = (key: string, x: number): Scene3dTree => ({
            kind: 'mesh',
            key,
            path: `${REPEAT}.rows.${key}`,
            properties: { geometry: { kind: 'plane', width: 1, height: 2 }, position: [x, 0, 0], material: { map: picture('plan') } },
            children: []
        });
        const tiles: Scene3dTree = { kind: 'repeat3d', key: 'tiles', path: REPEAT, properties: {}, children: [copy('a', -0.6), copy('b', 0.6)] };
        // A mesh without a map drawn first (three.js keeps a lookup texture of its own for the material)
        await draw(scene, [eye(), fill(), wall({ color: '#ff00ff' })], BLACK_BG);
        await draw(scene, [eye(), fill()], BLACK_BG);
        const before = scene.info().memory.textures;

        // Act
        await draw(scene, [eye(), fill(), tiles], BLACK_BG);

        // Assert: each copy shows the whole picture, red at its own top-left
        expectColor(pixelAt(host, 0.5 + (-0.6 - 0.25) / 2.8, 0.35), RED);
        expectColor(pixelAt(host, 0.5 + (0.6 - 0.25) / 2.8, 0.35), RED);
        expectColor(pixelAt(host, 0.5 + (0.6 + 0.25) / 2.8, 0.65), GREY);
        expect(reads).toEqual(['plan']);
        expect(issues).toEqual([]);
        expect(scene.info().memory.textures).toBe(before + 1);

        // Act: the repeat goes
        await draw(scene, [eye(), fill()], BLACK_BG);

        // Assert
        expect(scene.info().memory.textures).toBe(before);
        expect(scene.info().maps).toEqual({ loading: 0, loaded: 0 });
    });
});
