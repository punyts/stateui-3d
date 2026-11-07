import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScene3d } from '../src/scene3d.ts';
import type { Scene3d } from '../src/scene3d.ts';
import { GEOMETRY_KINDS } from '../src/geometries.ts';
import { Scene3dError, isScene3dError } from '../src/renderer.ts';
import type { JsonValue, Node3dKind, Scene3dSettings, Scene3dTree } from '../src/tree.ts';

/** The owner's tolerance for pixels drawn by software WebGL: 12 per channel (epic 3 Decisions) */
const TOLERANCE = 12;
const ROOT = '$.app.children';

function node(kind: Node3dKind, key: string, properties: Record<string, JsonValue> = {}, children: Scene3dTree[] = []): Scene3dTree {
    const path = `${ROOT}.${key}`;
    return { kind, key, path, properties, children: children.map((child) => ({ ...child, path: `${path}.children.${child.key}` })) };
}

/** A camera at z = 5 looking at the origin */
const front = (properties: Record<string, JsonValue> = {}): Scene3dTree => node('camera', 'eye', { position: [0, 0, 5], target: [0, 0, 0], ...properties });
/** A directional light straight from the camera's side: a face towards +z gets all of it */
const sun = (properties: Record<string, JsonValue> = {}): Scene3dTree => node('light', 'sun', { kind: 'directional', position: [0, 0, 10], target: [0, 0, 0], ...properties });
const box = (color: string, properties: Record<string, JsonValue> = {}): Scene3dTree => node('mesh', 'box', { geometry: { kind: 'box' }, material: { color }, ...properties });

/** Every pixel of the canvas as RGBA rows from the bottom, read in the task of the frame (the buffer is not kept after it) */
function pixels(host: HTMLElement): { width: number; height: number; data: Uint8Array } {
    const canvas = host.querySelector('canvas');
    const gl = canvas?.getContext('webgl2');
    if (!canvas || !gl) throw new Error('No WebGL canvas');
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const data = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return { width, height, data };
}

/** The colour at a point of the canvas, as fractions of its width and height from the top-left */
function pixelAt(host: HTMLElement, fx = 0.5, fy = 0.5): number[] {
    const { width, height, data } = pixels(host);
    const x = Math.min(width - 1, Math.floor(width * fx));
    const y = Math.min(height - 1, Math.floor(height * (1 - fy)));
    const at = (y * width + x) * 4;
    return [...data.slice(at, at + 4)];
}

/** The number of pixels that are not the colour `rgb` (within the tolerance) */
function countOther(host: HTMLElement, rgb: readonly number[]): number {
    const { data } = pixels(host);
    let count = 0;
    for (let at = 0; at < data.length; at += 4) {
        if (rgb.some((value, channel) => Math.abs((data[at + channel] ?? 0) - value) > TOLERANCE)) count += 1;
    }
    return count;
}

function expectColor(actual: readonly number[], expected: readonly number[]): void {
    expect(actual.length, `got ${actual.join(', ')}`).toBeGreaterThanOrEqual(expected.length);
    expected.forEach((value, channel) => {
        expect(Math.abs((actual[channel] ?? 0) - value), `channel ${channel} of [${actual.join(', ')}], expected [${expected.join(', ')}]`).toBeLessThanOrEqual(TOLERANCE);
    });
}

/** Updates the scene and waits for the frame it asked for */
async function draw(scene: Scene3d, tree: Scene3dTree[], settings?: Scene3dSettings): Promise<void> {
    scene.update(tree, settings);
    await scene.drawn();
}

const BLACK_BG: Scene3dSettings = { background: '#000000', environment: 'none' };

/**
 * A pure colour lit head-on by a directional light of intensity 1, seen from the light's side: the colour itself, plus
 * the little white a non-metal reflects where the light and the view meet (the specular term of the standard material)
 */
const LIT_RED = [252, 27, 27, 255];
const LIT_GREEN = [27, 252, 27, 255];
const LIT_BLUE = [27, 27, 252, 255];

describe('the 3D renderer core in Chromium (G3.5)', () => {
    let host: HTMLElement;
    let scene: Scene3d;

    beforeEach(() => {
        host = document.createElement('div');
        host.style.width = '120px';
        host.style.height = '80px';
        document.body.append(host);
        scene = createScene3d(host);
    });

    afterEach(() => {
        scene.dispose();
        host.remove();
        vi.restoreAllMocks();
    });

    it('should draw a lit box at the centre of the image, on the background', async () => {
        // Act
        await draw(scene, [front(), sun(), box('#ff0000')], { background: '#0000ff', environment: 'none' });

        // Assert
        expectColor(pixelAt(host), LIT_RED);
        expectColor(pixelAt(host, 0.02, 0.02), [0, 0, 255, 255]);
    });

    it('should draw a mesh and a light with no camera node, framed by the default camera', async () => {
        // Act
        await draw(scene, [sun(), box('#00ff00', { position: [10, 10, 0] })], BLACK_BG);

        // Assert
        expectColor(pixelAt(host), LIT_GREEN);
        expectColor(pixelAt(host, 0.02, 0.02), [0, 0, 0, 255]);
    });

    it('should draw a mesh black with no light and no environment', async () => {
        // Act
        await draw(scene, [front(), box('#ff0000')], { background: '#0000ff', environment: 'none' });

        // Assert
        expectColor(pixelAt(host), [0, 0, 0, 255]);
    });

    it('should light a face by the cosine of the light angle and by its intensity', async () => {
        // Act
        await draw(scene, [front(), sun({ intensity: 0.5 }), box('#ffffff')], BLACK_BG);
        const half = pixelAt(host);
        await draw(scene, [front(), sun({ position: [0, 10, 10] }), box('#ffffff')], BLACK_BG);
        const slanted = pixelAt(host);

        // Assert: 0.5 and cos 45° in linear light, as sRGB
        expectColor(half, [188, 188, 188, 255]);
        expectColor(slanted, [218, 218, 218, 255]);
    });

    it('should light with ambient, point and spot lights and the light colour', async () => {
        // Act
        await draw(scene, [front(), node('light', 'sun', { kind: 'ambient', color: '#ff0000' }), box('#ffffff')], BLACK_BG);
        const ambient = pixelAt(host);
        await draw(scene, [front(), node('light', 'sun', { kind: 'point', position: [0, 0, 20] }), box('#00ff00')], BLACK_BG);
        const point = pixelAt(host);
        await draw(scene, [front(), node('light', 'sun', { kind: 'spot', position: [0, 0, 20], target: [0, 0, 0] }), box('#0000ff')], BLACK_BG);
        const spot = pixelAt(host);

        // Assert
        expectColor(ambient, [255, 0, 0, 255]);
        expectColor(point, LIT_GREEN);
        expectColor(spot, LIT_BLUE);
    });

    it('should change the pixel when the colour changes, and clear it when the node is removed', async () => {
        // Arrange
        await draw(scene, [front(), sun(), box('#ff0000')], BLACK_BG);
        const red = pixelAt(host);

        // Act
        await draw(scene, [front(), sun(), box('#00ff00')]);
        const green = pixelAt(host);
        await draw(scene, [front(), sun()]);
        const gone = pixelAt(host);

        // Assert
        expectColor(red, LIT_RED);
        expectColor(green, LIT_GREEN);
        expectColor(gone, [0, 0, 0, 255]);
    });

    it('should move a mesh by its position', async () => {
        // Arrange
        await draw(scene, [front(), sun(), box('#ff0000')], BLACK_BG);

        // Act
        await draw(scene, [front(), sun(), box('#ff0000', { position: [0, 1.5, 0] })]);

        // Assert
        expectColor(pixelAt(host), [0, 0, 0, 255]);
        expect(countOther(host, [0, 0, 0])).toBeGreaterThan(0);
    });

    it('should leave the canvas transparent with no background, so the host shows', async () => {
        // Act
        await draw(scene, [front(), sun(), box('#ff0000')], { environment: 'none' });

        // Assert
        expectColor(pixelAt(host, 0.02, 0.02), [0, 0, 0, 0]);
    });

    it('should resolve token colours with the resolver it is given, from the host computed style', async () => {
        // Arrange
        scene.dispose();
        host.style.setProperty('--ui-color-accent-base', '#00ff00');
        host.style.setProperty('--ui-scene3d-background', 'rgb(0, 0, 255)');
        host.style.setProperty('--ui-scene3d-ambient', '#ffffff');
        const read = (value: JsonValue): string | undefined => {
            if (typeof value !== 'string') return undefined;
            if (!value.startsWith('{')) return value;
            const name = `--ui-${value.slice(1, -1).replaceAll('.', '-')}`;
            return getComputedStyle(host).getPropertyValue(name).trim() || undefined;
        };
        scene = createScene3d(host, { resolveColor: read });

        // Act
        await draw(scene, [front(), box('{color.accent.base}')], { background: '{scene3d.background}', ambient: '{scene3d.ambient}', environment: 'studio' });

        // Assert: the environment's ambient light of 0.4 alone lights the box
        expectColor(pixelAt(host), [0, 170, 0, 255]);
        expectColor(pixelAt(host, 0.02, 0.02), [0, 0, 255, 255]);
    });

    it('should draw colours of other CSS forms and leave an unknown token white', async () => {
        // Act
        await draw(scene, [front(), sun(), box('color(srgb 1 0 0)')], BLACK_BG);
        const converted = pixelAt(host);
        await draw(scene, [front(), sun(), box('{color.missing}')]);
        const unresolved = pixelAt(host);

        // Assert
        expectColor(converted, LIT_RED);
        expectColor(unresolved, [255, 255, 255, 255]);
    });

    it('should draw through the active camera, else the first camera', async () => {
        // Arrange
        const left = node('mesh', 'left', { position: [-10, 0, 0], material: { color: '#ff0000' } });
        const right = node('mesh', 'right', { position: [10, 0, 0], material: { color: '#00ff00' } });
        const lights = node('light', 'fill', { kind: 'ambient' });
        const atLeft = (active: boolean): Scene3dTree => node('camera', 'a', { position: [-10, 0, 5], target: [-10, 0, 0], active });
        const atRight = (active: boolean): Scene3dTree => node('camera', 'b', { position: [10, 0, 5], target: [10, 0, 0], active });

        // Act
        await draw(scene, [lights, left, right, atLeft(false), atRight(false)], BLACK_BG);
        const first = pixelAt(host);
        await draw(scene, [lights, left, right, atLeft(false), atRight(true)]);
        const active = pixelAt(host);

        // Assert
        expectColor(first, [255, 0, 0, 255]);
        expectColor(active, [0, 255, 0, 255]);
    });

    it('should draw through an orthographic camera and follow a camera in a group', async () => {
        // Arrange
        const lights = node('light', 'fill', { kind: 'ambient' });
        const target = node('mesh', 'target', { position: [5, 0, 0], material: { color: '#ffff00' } });
        const rig = node('group3d', 'rig', { position: [5, 0, 0] }, [node('camera', 'eye', { position: [0, 0, 5], target: [0, 0, 0] })]);

        // Act
        await draw(scene, [lights, node('mesh', 'box', { material: { color: '#ff00ff' } }), node('camera', 'eye', { kind: 'orthographic', position: [0, 0, 5] })], BLACK_BG);
        const orthographic = pixelAt(host);
        const orthographicEdge = pixelAt(host, 0.02, 0.5);
        await draw(scene, [lights, target, rig]);
        const grouped = pixelAt(host);

        // Assert
        expectColor(orthographic, [255, 0, 255, 255]);
        expectColor(orthographicEdge, [0, 0, 0, 255]);
        expectColor(grouped, [255, 255, 0, 255]);
    });

    it.each(GEOMETRY_KINDS)('should draw a %s', async (kind) => {
        // Act
        await draw(scene, [front(), node('light', 'fill', { kind: 'ambient' }), node('mesh', 'shape', { geometry: { kind }, material: { color: '#ffffff' } })], BLACK_BG);

        // Assert
        expect(countOther(host, [0, 0, 0])).toBeGreaterThan(50);
    });

    it('should hide a mesh that is not visible', async () => {
        // Act
        await draw(scene, [front(), sun(), box('#ff0000', { visible: false })], BLACK_BG);

        // Assert
        expectColor(pixelAt(host), [0, 0, 0, 255]);
    });

    it('should ask for one frame per change and none at rest', async () => {
        // Arrange
        await draw(scene, [front(), sun(), box('#ff0000')], BLACK_BG);
        const frames = vi.spyOn(window, 'requestAnimationFrame');

        // Act: three changes in one task draw in one frame; then nothing for a while
        scene.update([front(), sun(), box('#00ff00')]);
        scene.update([front(), sun(), box('#0000ff')]);
        scene.update([front(), sun(), box('#ffffff')]);
        await scene.drawn();
        const afterChange = frames.mock.calls.length;
        await new Promise((resolve) => setTimeout(resolve, 150));

        // Assert
        expect(afterChange).toBe(1);
        expect(frames.mock.calls.length).toBe(1);
    });

    it('should ask for a frame when the host is resized', async () => {
        // Arrange
        await draw(scene, [front(), sun(), box('#ff0000')], BLACK_BG);
        const frames = vi.spyOn(window, 'requestAnimationFrame');

        // Act
        host.style.width = '60px';
        await new Promise((resolve) => setTimeout(resolve, 100));
        await scene.drawn();

        // Assert
        expect(frames.mock.calls.length).toBe(1);
        expect(host.querySelector('canvas')?.width).toBe(60 * Math.min(devicePixelRatio, 2));
    });
});

describe('createScene3d without WebGL', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        document.body.replaceChildren();
    });

    it('should throw a Scene3dError no_webgl and leave no canvas', () => {
        // Arrange
        const getContext = HTMLCanvasElement.prototype.getContext;
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
            if (type === 'webgl' || type === 'webgl2') return null;
            return (getContext as (...args: unknown[]) => unknown).call(this, type, ...rest) as never;
        });
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const host = document.createElement('div');
        document.body.append(host);

        // Act
        let thrown: unknown;
        try {
            createScene3d(host);
        } catch (error) {
            thrown = error;
        }

        // Assert
        expect(thrown).toBeInstanceOf(Scene3dError);
        expect(isScene3dError(thrown)).toBe(true);
        expect((thrown as Scene3dError).code).toBe('no_webgl');
        expect(isScene3dError(Object.assign(new Error('x'), { name: 'Scene3dError', code: 'no_webgl' }))).toBe(true);
        expect(isScene3dError(new Error('x'))).toBe(false);
        expect(host.querySelector('canvas')).toBeNull();
    });
});
