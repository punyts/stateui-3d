import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createScene3d } from '../src/scene3d.ts';
import type { Scene3d } from '../src/scene3d.ts';
import type { JsonValue, Scene3dSettings, Scene3dTree } from '../src/tree.ts';
import { ROOT, draw, expectColor, front, node, pixelAt, pixels } from './pixels.ts';

const REPEAT = `${ROOT}.crates`;
const BLACK_BG: Scene3dSettings = { background: '#000000', environment: 'none' };
/** A pure colour lit head-on by a directional light of intensity 1 (as in render.browser.test.ts) */
const LIT_RED = [252, 27, 27, 255];
const LIT_GREEN = [27, 252, 27, 255];

/** A directional light from the camera's side */
const sun = (): Scene3dTree => node('light', 'sun', { kind: 'directional', position: [0, 0, 10], target: [0, 0, 0] });

/** The copy of the row for one record, as the feeder binds it */
const copy = (key: string, properties: Record<string, JsonValue> = {}): Scene3dTree => ({
    kind: 'mesh',
    key,
    path: `${REPEAT}.rows.${key}`,
    properties: { geometry: { kind: 'box' }, ...properties },
    children: []
});

const repeat = (copies: Scene3dTree[], properties: Record<string, JsonValue> = {}): Scene3dTree => ({ kind: 'repeat3d', key: 'crates', path: REPEAT, properties, children: copies });

/** Two boxes a quarter of the canvas left and right of the centre (the canvas is 3.5 units wide each side at z = 0) */
const pair = (left: string, right: string, rightProperties: Record<string, JsonValue> = {}): Scene3dTree[] => [
    copy('left', { position: [-1.75, 0, 0], material: { color: left } }),
    copy('right', { position: [1.75, 0, 0], material: { color: right }, ...rightProperties })
];

describe('repeat3d as instanced meshes in Chromium (G3.6)', () => {
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
    });

    it('should draw a colour per instance, seen at two known pixels', async () => {
        // Act
        await draw(scene, [front(), sun(), repeat(pair('#ff0000', '#00ff00'))], BLACK_BG);

        // Assert
        expectColor(pixelAt(host, 0.25, 0.5), LIT_RED);
        expectColor(pixelAt(host, 0.75, 0.5), LIT_GREEN);
        expectColor(pixelAt(host, 0.5, 0.5), [0, 0, 0, 255]);
        expect(scene.info().instances).toBe(2);
    });

    it('should recolour and move one instance without touching the other', async () => {
        // Arrange
        await draw(scene, [front(), sun(), repeat(pair('#ff0000', '#00ff00'))], BLACK_BG);

        // Act
        await draw(scene, [front(), sun(), repeat([copy('left', { position: [-1.75, 0, 0], material: { color: '#ff0000' } }), copy('right', { position: [0, 0, 0], material: { color: '#ff0000' } })])]);

        // Assert
        expectColor(pixelAt(host, 0.25, 0.5), LIT_RED);
        expectColor(pixelAt(host, 0.5, 0.5), LIT_RED);
        expectColor(pixelAt(host, 0.75, 0.5), [0, 0, 0, 255]);
    });

    it('should draw nothing for an empty or missing record set, and leave no stale instance when the last record goes', async () => {
        // Arrange
        await draw(scene, [front(), sun(), repeat([copy('only', { material: { color: '#ff0000' } })])], BLACK_BG);
        const drawn = pixelAt(host);

        // Act
        await draw(scene, [front(), sun(), repeat([])]);
        const empty = pixelAt(host);
        const info = scene.info();

        // Assert
        expectColor(drawn, LIT_RED);
        expectColor(empty, [0, 0, 0, 255]);
        expect(info.instances).toBe(0);
    });

    it('should hit an interactive instance and give its copy, keyed by its record key', async () => {
        // Arrange
        await draw(scene, [front(), sun(), repeat(pair('#ff0000', '#00ff00', { interactive: true, _label: 'Right crate' }))], BLACK_BG);

        // Act
        const right = scene.hit(90, 40);
        const left = scene.hit(30, 40);
        const empty = scene.hit(60, 40);

        // Assert: the left copy is not interactive, nor is the repeat
        expect(right?.key).toBe('right');
        expect(right?.path).toBe(`${REPEAT}.rows.right`);
        expect(right?.properties._label).toBe('Right crate');
        expect(left).toBeUndefined();
        expect(empty).toBeUndefined();
        expect(scene.boundsOf(`${REPEAT}.rows.right`)?.min[0]).toBeCloseTo(1.25);
    });

    it('should free the shared geometry and the instances when the repeat goes, the memory count back at its start', async () => {
        // Arrange: a plain mesh first, so the renderer's own textures of the standard material are made before the count
        const back = node('mesh', 'back', { position: [0, 0, -10], material: { color: '#808080' } });
        await draw(scene, [front(), sun(), back], BLACK_BG);
        const start = scene.info().memory;

        // Act
        await draw(scene, [front(), sun(), back, repeat(Array.from({ length: 100 }, (_, index) => copy(`r${index}`, { position: [index % 10, Math.floor(index / 10), 0] })))]);
        const during = scene.info();
        await draw(scene, [front(), sun(), back]);

        // Assert
        expect(during.instances).toBe(100);
        expect(during.memory.geometries).toBe(start.geometries + 1);
        expect(scene.info().memory).toEqual(start);
        expect(scene.info().instances).toBe(0);
    });

    it('should draw 10,000 instances within the 10 s render timeout, and log the time', async () => {
        // Arrange: a 100 by 100 grid, each instance its own colour, framed by the default camera
        const copies = Array.from({ length: 10_000 }, (_, index) =>
            copy(`r${index}`, { position: [(index % 100) * 1.5, Math.floor(index / 100) * 1.5, 0], material: { color: index % 2 === 0 ? '#ff0000' : '#00ff00' } })
        );
        const started = performance.now();

        // Act
        await draw(scene, [sun(), repeat(copies)], BLACK_BG);
        const first = performance.now() - started;
        const changed = performance.now();
        await draw(scene, [sun(), repeat(copies.map((tree, index) => (index === 5_000 ? copy(tree.key, { position: [0, 0, 5] }) : tree)))]);
        const one = performance.now() - changed;

        // Assert
        console.info(`repeat3d: 10,000 instances drawn in ${first.toFixed(0)} ms; one record changed in ${one.toFixed(0)} ms`);
        expect(scene.info().instances).toBe(10_000);
        expect(first).toBeLessThan(10_000);
        const { data } = pixels(host);
        let lit = 0;
        for (let at = 0; at < data.length; at += 4) if ((data[at] ?? 0) > 40 || (data[at + 1] ?? 0) > 40) lit += 1;
        expect(lit).toBeGreaterThan(data.length / 4 / 10);
    });
});
