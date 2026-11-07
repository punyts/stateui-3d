import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createScene3d } from './scene3d.js';
import type { Scene3d } from './scene3d.js';
import type { JsonValue, Node3dKind, Scene3dTree } from './tree.js';

const ROOT = '$.app.children.scene.children';

function node(kind: Node3dKind, key: string, properties: Record<string, JsonValue> = {}, children: Scene3dTree[] = []): Scene3dTree {
    const path = `${ROOT}.${key}`;
    return { kind, key, path, properties, children: children.map((child) => ({ ...child, path: `${path}.children.${child.key}` })) };
}

/** A camera at z = 5 looking at the origin, so a node's place on screen does not depend on the default framing */
const front = (): Scene3dTree => node('camera', 'eye', { position: [0, 0, 5], target: [0, 0, 0] });

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
        const ratio = Math.min(devicePixelRatio, 2);
        expect(canvas).not.toBeNull();
        expect(canvas?.width).toBe(120 * ratio);
        expect(canvas?.height).toBe(80 * ratio);
        expect(canvas?.getBoundingClientRect().width).toBe(120);
        expect(canvas?.getAttribute('style')).not.toContain('120');
    });

    it('should hit the interactive node at a point of the host', async () => {
        // Arrange
        const box = node('mesh', 'box', { interactive: true });
        scene.update([front(), box, node('mesh', 'other', { position: [3, 0, 0] })]);
        await scene.drawn();

        // Act and assert
        expect(scene.hit(60, 40)?.path).toBe(box.path);
        expect(scene.hit(1, 1)).toBeUndefined();
    });

    it('should hit the nearest interactive ancestor of a mesh, and not a mesh that is not interactive', () => {
        // Arrange
        const parent = node('group3d', 'parent', { interactive: true }, [node('mesh', 'inner')]);

        // Act
        scene.update([front(), parent]);
        const hitGroup = scene.hit(60, 40);
        scene.update([front(), node('mesh', 'plain')]);
        const hitPlain = scene.hit(60, 40);

        // Assert
        expect(hitGroup?.path).toBe(parent.path);
        expect(hitPlain).toBeUndefined();
    });

    it('should not hit a hidden mesh', () => {
        // Arrange
        scene.update([front(), node('mesh', 'box', { interactive: true, visible: false })]);

        // Act and assert
        expect(scene.hit(60, 40)).toBeUndefined();
    });

    it('should give the bounds of a node in scene units, with the transforms of its ancestors', () => {
        // Arrange
        const parent = node('group3d', 'parent', { position: [0, 1, 0], rotation: [0, 0, 0] }, [node('mesh', 'inner', { position: [1, 0, 0], scale: [2, 2, 2] })]);

        // Act
        scene.update([parent]);

        // Assert
        expect(scene.boundsOf(`${parent.path}.children.inner`)).toEqual({ min: [0, 0, -1], max: [2, 2, 1] });
        expect(scene.boundsOf(parent.path)).toEqual({ min: [0, 0, -1], max: [2, 2, 1] });
        expect(scene.boundsOf('$.app.children.nothing')).toBeUndefined();
    });

    it('should turn a mesh by its rotation in degrees', () => {
        // Arrange
        const box = node('mesh', 'box', { rotation: [0, 0, 45] });

        // Act
        scene.update([box]);

        // Assert
        const bounds = scene.boundsOf(box.path);
        expect(bounds?.max[0]).toBeCloseTo(Math.SQRT1_2);
        expect(bounds?.max[2]).toBeCloseTo(0.5);
    });

    it('should size a mesh by its geometry', () => {
        // Arrange
        const ball = node('mesh', 'ball', { geometry: { kind: 'sphere', radius: 2, segments: 64 } });

        // Act
        scene.update([ball]);

        // Assert
        const bounds = scene.boundsOf(ball.path);
        expect(bounds?.min[1]).toBeCloseTo(-2);
        expect(bounds?.max[1]).toBeCloseTo(2);
    });

    it('should forget the nodes that are no longer in the tree', () => {
        // Arrange
        scene.update([node('mesh', 'box')]);

        // Act
        scene.update([]);

        // Assert
        expect(scene.boundsOf(`${ROOT}.box`)).toBeUndefined();
    });

    it('should have no element for a node yet', () => {
        // Arrange
        scene.update([node('mesh', 'box', { interactive: true })]);

        // Assert
        expect(scene.elementOf(`${ROOT}.box`)).toBeUndefined();
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

    it('should resolve drawn after the frame an update asked for, and at once when none waits', async () => {
        // Arrange
        await scene.drawn();
        let framed = false;
        requestAnimationFrame(() => (framed = true));
        scene.update([node('mesh', 'box')]);

        // Act
        await scene.drawn();
        const afterFrame = framed;

        // Assert
        expect(afterFrame).toBe(true);
        await expect(scene.drawn()).resolves.toBeUndefined();
    });

    it('should remove its canvas on dispose and do nothing after it', async () => {
        // Arrange
        const box = node('mesh', 'box', { interactive: true });
        scene.update([box]);
        const pending = scene.drawn();

        // Act
        scene.dispose();
        scene.update([box]);

        // Assert
        await expect(pending).resolves.toBeUndefined();
        expect(host.querySelector('canvas')).toBeNull();
        expect(scene.hit(60, 40)).toBeUndefined();
        expect(scene.boundsOf(box.path)).toBeUndefined();
        await expect(scene.drawn()).resolves.toBeUndefined();
        scene.dispose();
    });
});
