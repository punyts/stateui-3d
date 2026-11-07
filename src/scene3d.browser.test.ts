import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createScene3d } from './scene3d.js';
import type { Scene3d } from './scene3d.js';
import type { JsonValue, Scene3dTree } from './tree.js';

function mesh(key: string, properties: Record<string, JsonValue> = {}, children: Scene3dTree[] = []): Scene3dTree {
    return { kind: 'mesh', key, path: `$.app.children.scene.children.${key}`, properties, children };
}

function group(key: string, properties: Record<string, JsonValue>, children: Scene3dTree[]): Scene3dTree {
    return { kind: 'group3d', key, path: `$.app.children.scene.children.${key}`, properties, children };
}

/** The colour at the middle of the canvas, read in the same task as the draw (the buffer is not kept after a frame) */
function centrePixel(host: HTMLElement): number[] {
    const canvas = host.querySelector('canvas');
    const gl = canvas?.getContext('webgl2');
    if (!canvas || !gl) throw new Error('No WebGL canvas');
    const pixel = new Uint8Array(4);
    gl.readPixels(Math.floor(gl.drawingBufferWidth / 2), Math.floor(gl.drawingBufferHeight / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    return [...pixel];
}

describe('createScene3d', () => {
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

    it('should add a canvas of the host size with no style attribute written as text', () => {
        // Assert
        const canvas = host.querySelector('canvas');
        expect(canvas).not.toBeNull();
        expect(canvas?.width).toBe(120 * devicePixelRatio);
        expect(canvas?.height).toBe(80 * devicePixelRatio);
        expect(canvas?.getBoundingClientRect().width).toBe(120);
    });

    it('should draw a mesh in its material colour in front of the default camera', () => {
        // Act
        scene.update([mesh('box', { material: { color: '#ff0000' } })]);

        // Assert
        expect(centrePixel(host)).toEqual([255, 0, 0, 255]);
    });

    it('should draw nothing where a hidden mesh is', () => {
        // Act
        scene.update([mesh('box', { material: { color: '#ff0000' }, visible: false })]);

        // Assert
        expect(centrePixel(host)).toEqual([0, 0, 0, 255]);
    });

    it('should hit the interactive node at a point of the host', () => {
        // Arrange
        const box = mesh('box', { interactive: true });
        scene.update([box, mesh('other', { position: [3, 0, 0] })]);

        // Act and assert
        expect(scene.hit(60, 40)?.path).toBe(box.path);
        expect(scene.hit(1, 1)).toBeUndefined();
    });

    it('should hit the nearest interactive ancestor of a mesh, and not a mesh that is not interactive', () => {
        // Arrange
        const inner = mesh('inner');
        const parent = group('parent', { interactive: true }, [inner]);

        // Act
        scene.update([parent]);
        const hitGroup = scene.hit(60, 40);
        scene.update([mesh('plain')]);
        const hitPlain = scene.hit(60, 40);

        // Assert
        expect(hitGroup?.path).toBe(parent.path);
        expect(hitPlain).toBeUndefined();
    });

    it('should give the bounds of a node in scene units, with the transforms of its ancestors', () => {
        // Arrange
        const inner = mesh('inner', { position: [1, 0, 0], scale: [2, 2, 2] });

        // Act
        scene.update([group('parent', { position: [0, 1, 0], rotation: [0, 0, 0] }, [inner])]);

        // Assert
        expect(scene.boundsOf(inner.path)).toEqual({ min: [0, 0, -1], max: [2, 2, 1] });
        expect(scene.boundsOf('$.app.children.scene.children.parent')).toEqual({ min: [0, 0, -1], max: [2, 2, 1] });
        expect(scene.boundsOf('$.app.children.nothing')).toBeUndefined();
    });

    it('should turn a mesh by its rotation in degrees', () => {
        // Arrange
        const box = mesh('box', { rotation: [0, 0, 45] });

        // Act
        scene.update([box]);

        // Assert
        const bounds = scene.boundsOf(box.path);
        expect(bounds?.max[0]).toBeCloseTo(Math.SQRT1_2);
        expect(bounds?.max[2]).toBeCloseTo(0.5);
    });

    it('should forget the nodes of the last tree on update', () => {
        // Arrange
        scene.update([mesh('box')]);

        // Act
        scene.update([]);

        // Assert
        expect(scene.boundsOf('$.app.children.scene.children.box')).toBeUndefined();
        expect(centrePixel(host)).toEqual([0, 0, 0, 255]);
    });

    it('should have no element for a node yet', () => {
        // Arrange
        scene.update([mesh('box', { interactive: true })]);

        // Assert
        expect(scene.elementOf('$.app.children.scene.children.box')).toBeUndefined();
    });

    it('should keep the reduced motion setting', () => {
        // Act
        scene.setReducedMotion(true);

        // Assert
        expect(scene.reducedMotion).toBe(true);
        const other = createScene3d(host, { reducedMotion: true });
        expect(other.reducedMotion).toBe(true);
        other.dispose();
    });

    it('should resolve drawn after the next frame', async () => {
        // Arrange
        scene.update([mesh('box')]);

        // Act and assert
        await expect(scene.drawn()).resolves.toBeUndefined();
    });

    it('should remove its canvas on dispose and do nothing after it', async () => {
        // Arrange
        const box = mesh('box', { interactive: true });
        scene.update([box]);

        // Act
        scene.dispose();
        scene.update([box]);

        // Assert
        expect(host.querySelector('canvas')).toBeNull();
        expect(scene.hit(60, 40)).toBeUndefined();
        expect(scene.boundsOf(box.path)).toBeUndefined();
        await expect(scene.drawn()).resolves.toBeUndefined();
        scene.dispose();
    });
});
