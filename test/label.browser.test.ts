import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createScene3d } from '../src/scene3d.ts';
import type { Scene3d } from '../src/scene3d.ts';
import type { Scene3dIssue } from '../src/scene.ts';
import { LABEL_MAX_WIDTH } from '../src/labels.ts';
import type { ColorResolver, JsonValue, Scene3dSettings, Scene3dTree } from '../src/tree.ts';
import { ROOT, draw, node, pixels } from './pixels.ts';

/*
 * `label3d` (G3.6b of the graphics epic 3): a label draws its `_text` with `fillText` on a canvas, in the page font and
 * its colour, as a sprite that faces the camera, and frees its texture when it goes.
 */

const BLACK: Scene3dSettings = { background: '#000000', environment: 'none' };
const TAG = `${ROOT}.tag`;

/** The number of pixels of the canvas that are clearly red, green or any text colour on the black background */
function count(host: HTMLElement, test: (r: number, g: number, b: number) => boolean): number {
    const { data } = pixels(host);
    let found = 0;
    for (let at = 0; at < data.length; at += 4) if (test(data[at] ?? 0, data[at + 1] ?? 0, data[at + 2] ?? 0)) found += 1;
    return found;
}
const red = (host: HTMLElement): number => count(host, (r, g, b) => r > 150 && g < 90 && b < 90);
const green = (host: HTMLElement): number => count(host, (r, g, b) => g > 150 && r < 90 && b < 90);

const eye = (position: [number, number, number] = [0, 0, 5]): Scene3dTree => node('camera', 'eye', { position, target: [0, 0, 0] });
const tag = (properties: Record<string, JsonValue>): Scene3dTree => node('label3d', 'tag', { fontSize: 1, color: '#ff0000', ...properties });

describe('label3d in Chromium (G3.6b)', () => {
    let host: HTMLElement;
    let scene: Scene3d;
    let issues: Scene3dIssue[];
    /** The value the `{color.text.base}` token resolves to: the theme's text colour, switched by the dark mode test */
    let textColour: string;

    beforeEach(() => {
        host = document.createElement('div');
        host.style.width = '200px';
        host.style.height = '100px';
        host.style.fontFamily = 'Arial, sans-serif';
        document.body.append(host);
        issues = [];
        textColour = '#ff0000';
        const resolveColor: ColorResolver = (value) => (value === '{color.text.base}' ? textColour : typeof value === 'string' && !value.startsWith('{') ? value : undefined);
        scene = createScene3d(host, { resolveColor, onIssue: (issue) => issues.push(issue) });
    });

    afterEach(() => {
        scene.dispose();
        host.remove();
        delete (window as { labelXss?: unknown }).labelXss;
    });

    it('should draw the text in its colour, and a new texture when _text changes', async () => {
        // Act
        await draw(scene, [eye(), tag({ _text: 'I' })], BLACK);
        const short = red(host);
        await draw(scene, [eye(), tag({ _text: 'WWWW' })]);
        const long = red(host);

        // Assert
        expect(scene.info().labels).toBe(1);
        expect(short).toBeGreaterThan(20);
        expect(long).toBeGreaterThan(short * 3);
    });

    it('should face a moved camera: seen from the side, the label shows as much text as from the front', async () => {
        // Act
        await draw(scene, [eye([0, 0, 5]), tag({ _text: 'Crate' })], BLACK);
        const front = red(host);
        await draw(scene, [eye([5, 0, 0]), tag({ _text: 'Crate' })]);
        const side = red(host);
        await draw(scene, [eye([0, 5, 0.001]), tag({ _text: 'Crate' })]);
        const above = red(host);

        // Assert: a flat text would be edge on from the side and from above, and show nothing
        expect(front).toBeGreaterThan(100);
        expect(side).toBeGreaterThan(front * 0.8);
        expect(side).toBeLessThan(front * 1.25);
        expect(above).toBeGreaterThan(front * 0.8);
    });

    it('should recolour a label in the theme text colour on restyle, as a dark mode switch does', async () => {
        // Arrange: no color of its own, so the scene's labelColor token
        await draw(scene, [eye(), node('label3d', 'tag', { _text: 'Dark', fontSize: 1 })], { ...BLACK, labelColor: '{color.text.base}' });
        const before = { red: red(host), green: green(host) };

        // Act
        textColour = '#00ff00';
        scene.restyle();
        await scene.drawn();

        // Assert
        expect(before.red).toBeGreaterThan(50);
        expect(before.green).toBe(0);
        expect(green(host)).toBeGreaterThan(before.red * 0.8);
        expect(red(host)).toBe(0);
    });

    it('should hold as many geometries and textures after a label is removed as before it was added', async () => {
        // Arrange
        await draw(scene, [eye()], BLACK);
        const start = scene.info().memory;

        // Act
        await draw(scene, [eye(), tag({ _text: 'Price: 12 EUR' })]);
        const full = scene.info().memory;
        await draw(scene, [eye(), tag({ _text: 'Price: 14 EUR' })]);
        const changed = scene.info().memory;
        await draw(scene, [eye()]);
        const end = scene.info().memory;

        // Assert: one texture and one quad while it shows; a redraw replaces its texture
        expect(full).toEqual({ geometries: start.geometries + 1, textures: start.textures + 1 });
        expect(changed).toEqual(full);
        expect(end).toEqual(start);
        expect(scene.info().labels).toBe(0);
    });

    it('should draw markup in _text as text and run nothing', async () => {
        // Act
        await draw(scene, [eye(), tag({ _text: '<img src="x" onerror="window.labelXss = 1">' })], BLACK);
        // Read in the task of the frame: the drawing buffer is not kept after it
        const drawn = red(host);
        await new Promise((settle) => setTimeout(settle, 100));

        // Assert
        expect(drawn).toBeGreaterThan(100);
        expect(document.querySelector('img')).toBeNull();
        expect(host.querySelector('img')).toBeNull();
        expect((window as { labelXss?: unknown }).labelXss).toBeUndefined();
    });

    it('should draw nothing and report nothing for an empty _text, and cut a very long text without failing', async () => {
        // Act
        await draw(scene, [eye(), tag({ _text: '' })], BLACK);
        const empty = { labels: scene.info().labels, red: red(host), bounds: scene.boundsOf(TAG) };
        await draw(scene, [eye(), tag({ _text: 'W'.repeat(5000), fontSize: 0.5 })]);

        // Assert
        expect(empty).toEqual({ labels: 0, red: 0, bounds: undefined });
        expect(scene.info().labels).toBe(1);
        expect(red(host)).toBeGreaterThan(0);
        expect(issues).toEqual([]);
        // The sprite is as wide as the widest canvas: LABEL_MAX_WIDTH texels over a line box of 1.4 ems
        const bounds = scene.boundsOf(TAG);
        expect(bounds).toBeDefined();
        const width = (bounds?.max[0] ?? 0) - (bounds?.min[0] ?? 0);
        expect(width).toBeCloseTo(0.5 * 1.4 * (LABEL_MAX_WIDTH / Math.ceil(64 * 1.4)), 2);
    });

    it('should be pressed through a ray cast like a mesh when interactive', async () => {
        // Arrange
        await draw(scene, [eye(), tag({ _text: 'WWWW', interactive: true, _label: 'Price tag' })], BLACK);

        // Act
        const hit = scene.hit(100, 50);

        // Assert
        expect(hit?.path).toBe(TAG);
        expect(scene.elementOf(TAG)?.getAttribute('aria-label')).toBe('Price tag');
    });
});
