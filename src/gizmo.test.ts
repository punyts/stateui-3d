import { Euler, OrthographicCamera, PerspectiveCamera, Quaternion, Raycaster, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { GIZMO_PIXELS, Gizmos, gizmoMode, gizmoScale, gizmoValue, movedPosition, scaledScale, turnedRotation } from './gizmo.js';
import type { JsonValue, Scene3dTree } from './tree.js';

const piece = (properties: Record<string, JsonValue>, key = 'piece'): Scene3dTree => ({ kind: 'mesh', key, path: `$.app.children.${key}`, properties: { interactive: true, ...properties }, children: [] });

/** The quaternion of a rotation in degrees, x-y-z order */
const turnOf = (degrees: readonly number[]): Quaternion => {
    const [x, y, z] = degrees.map((value) => (value * Math.PI) / 180) as [number, number, number];
    return new Quaternion().setFromEuler(new Euler(x, y, z));
};

describe('the 3D gizmo', () => {
    it('should show a gizmo only on an interactive node that is drawn, with a known mode', () => {
        // Act
        const modes = [
            gizmoMode(piece({ gizmo: 'move' })),
            gizmoMode(piece({ gizmo: 'rotate' })),
            gizmoMode(piece({ gizmo: 'scale' })),
            gizmoMode(piece({ gizmo: 'none' })),
            gizmoMode(piece({ gizmo: 'move', interactive: false })),
            gizmoMode(piece({ gizmo: 'move', visible: false }))
        ];

        // Assert
        expect(modes).toEqual(['move', 'rotate', 'scale', undefined, undefined, undefined]);
    });

    it('should read the values a handle changes, with the defaults of unset ones', () => {
        // Arrange
        const plain = piece({});
        const placed = piece({ position: [1, 2, 3], rotation: [0, 90, 0], scale: [2, 2, 2] });

        // Act, Assert
        expect([gizmoValue(plain, 'position'), gizmoValue(plain, 'rotation'), gizmoValue(plain, 'scale')]).toEqual([[0, 0, 0], [0, 0, 0], [1, 1, 1]]);
        expect([gizmoValue(placed, 'position'), gizmoValue(placed, 'rotation'), gizmoValue(placed, 'scale')]).toEqual([[1, 2, 3], [0, 90, 0], [2, 2, 2]]);
    });

    it('should move along one axis, lift on y, snap to the step and keep x and z in the bounds', () => {
        // Arrange
        const free = piece({ position: [1, 0, 2] });
        const board = piece({ position: [0, 0, 0], snap: true, step: 0.5, bounds: { x: -1, z: -1, width: 2, depth: 2 } });

        // Act
        const lifted = movedPosition(free, 1, 2.25);
        const snapped = movedPosition(board, 1, 0.8);
        const kept = movedPosition(board, 0, 7);

        // Assert
        expect(lifted).toEqual([1, 2.25, 2]);
        expect(snapped).toEqual([0, 1, 0]);
        expect(kept).toEqual([1, 0, 0]);
    });

    it('should turn about the parent axis before the node own rotation, in steps of 15 degrees with snap', () => {
        // Arrange
        const flat = piece({});
        const tilted = piece({ rotation: [90, 0, 0] });
        const snapping = piece({ snap: true });

        // Act
        const turned = turnedRotation(flat, 1, 90);
        const after = turnedRotation(tilted, 1, 90);
        const snapped = turnedRotation(snapping, 2, 22);

        // Assert: the turn about the parent's y follows the tilt about x
        expect(turned.map((value) => Math.round(value))).toEqual([0, 90, 0]);
        const expected = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2).multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2));
        expect(Math.abs(turnOf(after).dot(expected))).toBeCloseTo(1, 6);
        expect(snapped).toEqual([0, 0, 15]);
    });

    it('should scale one axis or all three, never below 0.01, rounding to 0.1 with snap', () => {
        // Arrange
        const box = piece({ scale: [2, 1, 1] });
        const snapping = piece({ snap: true });

        // Act
        const wider = scaledScale(box, 0, 1.5);
        const all = scaledScale(box, 3, 0.5);
        const flat = scaledScale(box, 1, -3);
        const snapped = scaledScale(snapping, 3, 1.26);

        // Assert
        expect(wider).toEqual([3, 1, 1]);
        expect(all).toEqual([1, 0.5, 0.5]);
        expect(flat).toEqual([2, 0.01, 1]);
        expect(snapped).toEqual([1.3, 1.3, 1.3]);
    });

    it('should size a handle to GIZMO_PIXELS on screen for a perspective and an orthographic camera', () => {
        // Arrange
        const perspective = new PerspectiveCamera(90, 1, 0.1, 100);
        perspective.position.set(0, 0, 5);
        perspective.updateMatrixWorld();
        const orthographic = new OrthographicCamera(-4, 4, 4, -4, 0.1, 100);

        // Act
        const near = gizmoScale(perspective, new Vector3(), 480);
        const flat = gizmoScale(orthographic, new Vector3(), 480);

        // Assert: 10 world units fill 480 pixels at a distance of 5 with a 90 degree field; 8 units fill the orthographic view
        expect(near).toBeCloseTo((10 / 480) * GIZMO_PIXELS, 6);
        expect(flat).toBeCloseTo((8 / 480) * GIZMO_PIXELS, 6);
    });

    it('should make handles for the nodes with a gizmo, find the handle a ray meets and forget a node that loses its gizmo', () => {
        // Arrange
        const gizmos = new Gizmos();
        const lid = piece({ gizmo: 'move' }, 'lid');
        const base = piece({ gizmo: 'none' }, 'base');
        const camera = new PerspectiveCamera(50, 1, 0.1, 100);
        camera.position.set(0, 0, 10);
        camera.updateMatrixWorld();
        const raycaster = new Raycaster();

        // Act
        gizmos.sync([lid, base]);
        gizmos.place(camera, 480, () => ({ origin: new Vector3(), parent: new Quaternion(), own: new Quaternion() }));
        const size = gizmoScale(camera, new Vector3(), 480);
        raycaster.set(new Vector3(0, size * 0.6, 10), new Vector3(0, 0, -1));
        const up = gizmos.handleAt(raycaster);
        raycaster.set(new Vector3(size * 0.6, 0, 10), new Vector3(0, 0, -1));
        const right = gizmos.handleAt(raycaster);
        gizmos.hold(up);
        gizmos.hold();
        gizmos.sync([piece({ gizmo: 'none' }, 'lid')]);

        // Assert
        expect(up).toEqual({ path: '$.app.children.lid', mode: 'move', axis: 1 });
        expect(right).toEqual({ path: '$.app.children.lid', mode: 'move', axis: 0 });
        expect(gizmos.size).toBe(0);
        gizmos.dispose();
    });

    it('should find the ring about z of a rotate gizmo and the centre cube of a scale gizmo', () => {
        // Arrange
        const gizmos = new Gizmos();
        const camera = new PerspectiveCamera(50, 1, 0.1, 100);
        camera.position.set(0, 0, 10);
        camera.updateMatrixWorld();
        const raycaster = new Raycaster();
        const size = gizmoScale(camera, new Vector3(), 480);
        const at = { origin: new Vector3(), parent: new Quaternion(), own: new Quaternion() };

        // Act
        gizmos.sync([piece({ gizmo: 'rotate' })]);
        gizmos.place(camera, 480, () => at);
        raycaster.set(new Vector3(size * 0.64, size * 0.64, 10), new Vector3(0, 0, -1));
        const ring = gizmos.handleAt(raycaster);
        gizmos.sync([piece({ gizmo: 'scale' })]);
        gizmos.place(camera, 480, () => at);
        raycaster.set(new Vector3(0, 0, 10), new Vector3(0, 0, -1));
        const centre = gizmos.handleAt(raycaster);

        // Assert
        expect(ring?.axis).toBe(2);
        expect(centre?.axis).toBe(3);
        gizmos.dispose();
    });
});
