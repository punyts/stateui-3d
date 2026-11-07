import { describe, expect, it } from 'vitest';
import { DEFAULT_CAMERA_POSITION, FRAME_MARGIN, activeCamera, frameBounds, orthographicHeight } from './cameras.js';
import type { JsonValue, Node3dKind, Scene3dTree } from './tree.js';

function node(kind: Node3dKind, key: string, properties: Record<string, JsonValue> = {}, children: Scene3dTree[] = []): Scene3dTree {
    return { kind, key, path: `$.app.children.${key}`, properties, children };
}

describe('activeCamera', () => {
    it('should be the first camera with active: true, wherever it is in the tree', () => {
        // Arrange
        const tree = [node('camera', 'front'), node('group3d', 'rig', {}, [node('mesh', 'box'), node('camera', 'side', { active: true })]), node('camera', 'top', { active: true })];

        // Act and assert
        expect(activeCamera(tree)?.key).toBe('side');
    });

    it('should be the first camera when none is active', () => {
        // Arrange
        const tree = [node('mesh', 'box'), node('group3d', 'rig', {}, [node('camera', 'inner')]), node('camera', 'after', { active: false })];

        // Act and assert
        expect(activeCamera(tree)?.key).toBe('inner');
    });

    it('should be undefined for a tree with no camera', () => {
        // Act and assert
        expect(activeCamera([node('mesh', 'box'), node('light', 'sun')])).toBeUndefined();
        expect(activeCamera([])).toBeUndefined();
    });
});

describe('frameBounds', () => {
    it('should stand at the default position looking at the origin when nothing is drawn', () => {
        // Act
        const frame = frameBounds(undefined, 50, 1);

        // Assert
        expect(frame.position).toEqual(DEFAULT_CAMERA_POSITION);
        expect(frame.target).toEqual([0, 0, 0]);
    });

    it('should look at the middle of the bounds from in front, far enough to fit the bounding sphere', () => {
        // Act
        const frame = frameBounds({ min: [1, 1, -1], max: [3, 3, 1] }, 60, 1);

        // Assert
        const radius = Math.sqrt(12) / 2;
        const distance = (radius * FRAME_MARGIN) / Math.sin(Math.PI / 6);
        expect(frame.target).toEqual([2, 2, 0]);
        expect(frame.position[0]).toBeCloseTo(2);
        expect(frame.position[1]).toBeCloseTo(2);
        expect(frame.position[2]).toBeCloseTo(distance);
        expect(frame.near).toBeLessThan(distance - radius);
        expect(frame.far).toBeGreaterThan(distance + radius);
    });

    it('should stand further back for a narrow canvas, where the horizontal field of view is the smaller', () => {
        // Act
        const wide = frameBounds({ min: [-1, -1, -1], max: [1, 1, 1] }, 50, 2);
        const narrow = frameBounds({ min: [-1, -1, -1], max: [1, 1, 1] }, 50, 0.5);

        // Assert
        expect(narrow.position[2]).toBeGreaterThan(wide.position[2]);
    });

    it('should see the height a perspective camera of the same field of view sees at its target', () => {
        // Act and assert
        expect(orthographicHeight(5, 90)).toBeCloseTo(10);
        expect(orthographicHeight(0, 50)).toBe(0.01);
    });
});
