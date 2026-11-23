import { describe, expect, it } from 'vitest';
import { editModeOf, meshEdges, nearPoints, readPicked, segmentDistance, togglePick } from './edit.js';
import type { CustomParams } from './geometries.js';
import type { JsonValue, Scene3dTree } from './tree.js';

const square: CustomParams = { kind: 'custom', vertices: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], faces: [[0, 1, 2, 3]], shading: 'flat' };

const mesh = (properties: Record<string, JsonValue>): Scene3dTree => ({
    kind: 'mesh',
    key: 'shape',
    path: '$.app.children.shape',
    properties: { interactive: true, geometry: { kind: 'custom', vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces: [[0, 1, 2]] }, ...properties },
    children: []
});

describe('edit', () => {
    it('should give the edit mode of an interactive custom mesh, and none for any other node', () => {
        // Act and assert
        expect(editModeOf(mesh({ edit: { mode: 'vertex', picked: [] } }))).toBe('vertex');
        expect(editModeOf(mesh({ edit: { mode: 'face' } }))).toBe('face');
        expect(editModeOf(mesh({ edit: { mode: 'none' } }))).toBeUndefined();
        expect(editModeOf(mesh({ edit: { mode: 'edge' }, interactive: false }))).toBeUndefined();
        expect(editModeOf(mesh({ edit: { mode: 'edge' }, visible: false }))).toBeUndefined();
        expect(editModeOf(mesh({ edit: { mode: 'edge' }, geometry: { kind: 'box' } }))).toBeUndefined();
        expect(editModeOf({ ...mesh({ edit: { mode: 'edge' } }), kind: 'group3d' })).toBeUndefined();
    });

    it('should list each edge of the faces once with the smaller index first, and none of an empty face', () => {
        // Act
        const edges = meshEdges([[0, 1, 2], [2, 1, 3], []]);

        // Assert
        expect(edges).toEqual([[0, 1], [1, 2], [0, 2], [1, 3], [2, 3]]);
    });

    it('should read only the picked elements the geometry has', () => {
        // Act and assert
        expect(readPicked('vertex', [0, 3, 4, -1, 1.5, 'a'], square)).toEqual([0, 3]);
        expect(readPicked('face', [0, 1], square)).toEqual([0]);
        expect(readPicked('edge', [[0, 1], [1, 0], [0, 2], [2, 3]], square)).toEqual([[0, 1], [2, 3]]);
        expect(readPicked('vertex', 'all', square)).toEqual([]);
    });

    it('should pick one element alone, and with add put it in or take it out', () => {
        // Act and assert
        expect(togglePick([1, 2], 3, false)).toEqual([3]);
        expect(togglePick([1, 2], 3, true)).toEqual([1, 2, 3]);
        expect(togglePick([1, 2], 2, true)).toEqual([1]);
        expect(togglePick([[0, 1]], [0, 1], true)).toEqual([]);
        expect(togglePick([[0, 1]], [1, 2], true)).toEqual([[0, 1], [1, 2]]);
    });

    it('should give the points within reach nearest first, and never one behind the camera', () => {
        // Act
        const near = nearPoints([[10, 10], undefined, [3, 4], [50, 50]], 0, 0, 15);

        // Assert
        expect(near.map(({ index }) => index)).toEqual([2, 0]);
        expect(near[0]?.distance).toBe(5);
    });

    it('should measure the distance to a segment and how far along it the nearest point is', () => {
        // Act and assert
        expect(segmentDistance([0, 0], [10, 0], 5, 3)).toEqual({ distance: 3, along: 0.5 });
        expect(segmentDistance([0, 0], [10, 0], -4, 3)).toEqual({ distance: 5, along: 0 });
        expect(segmentDistance([2, 2], [2, 2], 5, 6)).toEqual({ distance: 5, along: 0 });
    });
});
