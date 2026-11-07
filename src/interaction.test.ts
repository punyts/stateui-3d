import { Box3, OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { PRESS_SLOP, PressGesture, interactiveNodes, isShownNode, screenBox } from './interaction.js';
import type { JsonValue, Node3dKind, Scene3dTree } from './tree.js';

function node(kind: Node3dKind, key: string, properties: Record<string, JsonValue> = {}, children: Scene3dTree[] = []): Scene3dTree {
    return { kind, key, path: `$.app.children.${key}`, properties, children };
}

/** A camera at z = 5 looking at the origin, 90 degrees high, on a square canvas */
function camera(): PerspectiveCamera {
    const result = new PerspectiveCamera(90, 1, 0.1, 100);
    result.position.set(0, 0, 5);
    result.lookAt(0, 0, 0);
    result.updateMatrixWorld(true);
    result.updateProjectionMatrix();
    return result;
}

const box = (min: [number, number, number], max: [number, number, number]): Box3 => new Box3(new Vector3(...min), new Vector3(...max));

describe('interactiveNodes', () => {
    it('should list the interactive nodes in tree order, a group before the nodes inside it, a repeat before its copies', () => {
        // Arrange
        const copies = [node('mesh', 'r1', { interactive: true }), node('mesh', 'r2'), node('mesh', 'r3', { interactive: true })];
        const tree = [
            node('mesh', 'a', { interactive: true }),
            node('group3d', 'g', { interactive: true }, [node('mesh', 'inner', { interactive: true }), node('mesh', 'plain')]),
            node('repeat3d', 'rep', {}, copies),
            node('light', 'sun')
        ];

        // Act
        const found = interactiveNodes(tree).map((item) => item.key);

        // Assert
        expect(found).toEqual(['a', 'g', 'inner', 'r1', 'r3']);
    });

    it('should leave out a node that is not drawn and everything below it', () => {
        // Arrange
        const tree = [
            node('mesh', 'gone', { interactive: true, visible: false }),
            node('mesh', 'hid', { interactive: true, hidden: true }),
            node('group3d', 'g', { visible: false }, [node('mesh', 'inner', { interactive: true })]),
            node('repeat3d', 'rep', {}, [node('mesh', 'r1', { interactive: true, hidden: true }), node('mesh', 'r2', { interactive: true })])
        ];

        // Act
        const found = interactiveNodes(tree).map((item) => item.key);

        // Assert
        expect(found).toEqual(['r2']);
        expect(isShownNode(node('mesh', 'x', { visible: true, hidden: false }))).toBe(true);
    });

    it('should take only interactive: true, not a truthy value', () => {
        // Act and assert
        expect(interactiveNodes([node('mesh', 'a', { interactive: 'yes' }), node('mesh', 'b', { interactive: 1 })])).toEqual([]);
    });
});

describe('screenBox', () => {
    it('should project a box at the origin to the middle of the canvas', () => {
        // Arrange: at distance 5 a 90 degree view is 10 units high, so a box 2 units wide is a fifth of the canvas
        const seen = screenBox(box([-1, -1, 0], [1, 1, 0]), camera(), 200, 200);

        // Assert
        expect(seen?.left).toBeCloseTo(80, 6);
        expect(seen?.top).toBeCloseTo(80, 6);
        expect(seen?.width).toBeCloseTo(40, 6);
        expect(seen?.height).toBeCloseTo(40, 6);
    });

    it('should put a box above and right of the centre up and right on the canvas (y down on screen)', () => {
        // Act
        const seen = screenBox(box([1, 1, 0], [2, 2, 0]), camera(), 200, 200);

        // Assert
        expect(seen?.left).toBeCloseTo(120, 6);
        expect(seen?.top).toBeCloseTo(60, 6);
    });

    it('should cut a box to the canvas, and be undefined for one wholly beside it', () => {
        // Act
        const cut = screenBox(box([4, -1, 0], [8, 1, 0]), camera(), 200, 200);
        const beside = screenBox(box([20, 20, 0], [21, 21, 0]), camera(), 200, 200);

        // Assert
        expect(cut?.left).toBeCloseTo(180, 6);
        expect(cut?.width).toBeCloseTo(20, 6);
        expect(beside).toBeUndefined();
    });

    it('should be undefined for a box behind the camera, the whole canvas for one around it, undefined for an empty box', () => {
        // Act
        const behind = screenBox(box([-1, -1, 6], [1, 1, 8]), camera(), 200, 100);
        const around = screenBox(box([-1, -1, 4], [1, 1, 6]), camera(), 200, 100);
        const empty = screenBox(new Box3(), camera(), 200, 100);

        // Assert
        expect(behind).toBeUndefined();
        expect(around).toEqual({ left: 0, top: 0, width: 200, height: 100 });
        expect(empty).toBeUndefined();
    });

    it('should project through an orthographic camera', () => {
        // Arrange: a view 4 units wide and high
        const flat = new OrthographicCamera(-2, 2, 2, -2, 0.1, 100);
        flat.position.set(0, 0, 5);
        flat.lookAt(0, 0, 0);
        flat.updateMatrixWorld(true);
        flat.updateProjectionMatrix();

        // Act
        const seen = screenBox(box([0, 0, -1], [1, 1, 1]), flat, 100, 100);

        // Assert
        expect(seen?.left).toBeCloseTo(50, 6);
        expect(seen?.top).toBeCloseTo(25, 6);
        expect(seen?.width).toBeCloseTo(25, 6);
        expect(seen?.height).toBeCloseTo(25, 6);
    });
});

describe('PressGesture', () => {
    it('should be a press when the pointer goes up where it went down', () => {
        // Arrange
        const gesture = new PressGesture();

        // Act
        gesture.down(1, 10, 10);
        const pressing = gesture.pressing;
        const pressed = gesture.up(1, 10, 10);

        // Assert
        expect(pressing).toBe(true);
        expect(pressed).toBe(true);
        expect(gesture.pressing).toBe(false);
    });

    it('should still be a press within the slop, and a drag past it, even when the pointer comes back', () => {
        // Arrange
        const within = new PressGesture();
        const dragged = new PressGesture();

        // Act
        within.down(1, 10, 10);
        within.move(1, 10 + PRESS_SLOP, 10);
        dragged.down(1, 10, 10);
        dragged.move(1, 11 + PRESS_SLOP, 10);
        dragged.move(1, 10, 10);

        // Assert
        expect(within.up(1, 10, 10 + PRESS_SLOP)).toBe(true);
        expect(dragged.up(1, 10, 10)).toBe(false);
    });

    it('should not be a press when the controls moved the camera during it (a drag to rotate is not a click)', () => {
        // Arrange
        const gesture = new PressGesture();

        // Act
        gesture.down(1, 10, 10);
        gesture.cameraMoved();
        const pressed = gesture.up(1, 10, 10);

        // Assert
        expect(pressed).toBe(false);
    });

    it('should forget a camera move before the press, and be no press after a cancel, for another pointer, or with none down', () => {
        // Arrange
        const before = new PressGesture();
        const cancelled = new PressGesture();
        const other = new PressGesture();
        const pinch = new PressGesture();

        // Act
        before.cameraMoved();
        before.down(1, 0, 0);
        cancelled.down(1, 0, 0);
        cancelled.cancel();
        other.down(1, 0, 0);
        pinch.down(1, 0, 0);
        pinch.down(2, 50, 0);

        // Assert
        expect(before.up(1, 0, 0)).toBe(true);
        expect(cancelled.up(1, 0, 0)).toBe(false);
        expect(other.up(2, 0, 0)).toBe(false);
        expect(pinch.up(1, 0, 0)).toBe(false);
        expect(pinch.up(2, 50, 0)).toBe(false);
        expect(new PressGesture().up(1, 0, 0)).toBe(false);
    });
});
