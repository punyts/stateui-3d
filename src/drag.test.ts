import { describe, expect, it } from 'vitest';
import { dragAxes3d, keepPosition3d, positionOf3d, stepMove3d } from './drag.js';
import type { JsonValue, Scene3dTree } from './tree.js';

const piece = (properties: Record<string, JsonValue>): Scene3dTree => ({ kind: 'mesh', key: 'piece', path: '$.app.children.piece', properties: { interactive: true, ...properties }, children: [] });

describe('dragging a 3D node', () => {
    it('should drag along the axes draggable names, only an interactive node that is drawn', () => {
        // Act
        const axes = [
            dragAxes3d(piece({ draggable: 'x' })),
            dragAxes3d(piece({ draggable: 'z' })),
            dragAxes3d(piece({ draggable: 'ground' })),
            dragAxes3d(piece({ draggable: 'y' })),
            dragAxes3d(piece({ draggable: 'ground', interactive: false })),
            dragAxes3d(piece({ draggable: 'ground', visible: false }))
        ];

        // Assert
        expect(axes).toEqual([['x'], ['z'], ['x', 'z'], [], [], []]);
    });

    it('should keep the axes it does not move on, snap to the step and stay inside the bounds', () => {
        // Arrange
        const free = piece({ draggable: 'x', position: [1, 0.5, 2] });
        const board = piece({ draggable: 'ground', position: [0, 0.5, 0], snap: true, step: 0.5, bounds: { x: -2, z: -1, width: 4, depth: 2 } });

        // Act
        const along = keepPosition3d(free, [3.3, 9, 9]);
        const snapped = keepPosition3d(board, [0.74, 7, -0.3]);
        const kept = keepPosition3d(board, [9, 0, -9]);

        // Assert
        expect(along).toEqual([3.3, 0.5, 2]);
        expect(snapped).toEqual([0.5, 0.5, -0.5]);
        expect(kept).toEqual([2, 0.5, -1]);
        expect(positionOf3d(piece({ position: 'x' }))).toEqual([0, 0, 0]);
    });

    it('should move by step with the arrow keys, ten steps with Shift, and not along an axis it does not move on', () => {
        // Arrange
        const board = piece({ draggable: 'ground', position: [1, 0, 1], step: 0.25 });
        const rail = piece({ draggable: 'x', position: [0, 0, 0] });

        // Act
        const moves = [stepMove3d(board, 'ArrowLeft', false), stepMove3d(board, 'ArrowUp', false), stepMove3d(board, 'ArrowDown', true), stepMove3d(rail, 'ArrowRight', false)];
        const refused = [stepMove3d(rail, 'ArrowUp', false), stepMove3d(board, 'Enter', false)];

        // Assert
        expect(moves).toEqual([[0.75, 0, 1], [1, 0, 0.75], [1, 0, 3.5], [1, 0, 0]]);
        expect(refused).toEqual([undefined, undefined]);
    });
});
