import { PerspectiveCamera, Vector3 } from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_FOV } from '../src/cameras.ts';
import { EDIT_COLORS } from '../src/edit.ts';
import type { EditElement } from '../src/edit.ts';
import { createScene3d } from '../src/scene3d.ts';
import type { MeshGeometry, MeshPick, NodeMove, Scene3d, Scene3dEvent } from '../src/scene3d.ts';
import type { JsonValue, Scene3dSettings, Scene3dTree } from '../src/tree.ts';
import { draw, expectColor, front, node, pixelAt, rgbOf } from './pixels.ts';

/** The host is 160 by 120 CSS pixels, the camera at z = 5 looking at the origin */
const WIDTH = 160;
const HEIGHT = 120;

/** A cube of side 2 about the origin: 0 to 3 its front (z = 1) and 4 to 7 its back, each face wound outward */
const VERTICES = [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1], [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1]];
const FACES = [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]];

const settings: Scene3dSettings = { background: '#000000', environment: 'none', controls: 'none' };
const sun = (): Scene3dTree => node('light', 'sun', { kind: 'ambient', intensity: 1 });
const cube = (mode: string, picked: EditElement[] = [], properties: Record<string, JsonValue> = {}): Scene3dTree =>
    node('mesh', 'cube', {
        interactive: true,
        geometry: { kind: 'custom', vertices: VERTICES, faces: FACES },
        material: { color: '#808080' },
        edit: { mode, picked: picked as JsonValue },
        ...properties
    });

/** Where a point of the scene is drawn, in CSS pixels from the canvas's top-left corner */
function screenOf(point: readonly number[]): [number, number] {
    const camera = new PerspectiveCamera(DEFAULT_FOV, WIDTH / HEIGHT, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const ndc = new Vector3(...point).project(camera);
    return [((ndc.x + 1) / 2) * WIDTH, ((1 - ndc.y) / 2) * HEIGHT];
}

const vertexAt = (index: number): [number, number] => screenOf(VERTICES[index] as number[]);

function pointer(host: HTMLElement, type: string, x: number, y: number, shiftKey = false): void {
    const canvas = host.querySelector('canvas') as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const buttons = type === 'pointerup' ? 0 : 1;
    canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, composed: true, cancelable: true, clientX: rect.left + x, clientY: rect.top + y, pointerId: 1, button: 0, buttons, pointerType: 'mouse', isPrimary: true, shiftKey }));
}

function click(host: HTMLElement, [x, y]: readonly number[], shiftKey = false): void {
    pointer(host, 'pointerdown', x as number, y as number, shiftKey);
    pointer(host, 'pointerup', x as number, y as number, shiftKey);
}

describe('picking the vertices, edges and faces of a custom mesh in edit mode, in Chromium (mesh editor V2)', () => {
    let host: HTMLElement;
    let scene: Scene3d;
    let picks: MeshPick[];
    let events: Scene3dEvent[];
    let moves: NodeMove[];

    beforeEach(() => {
        host = document.createElement('div');
        host.style.width = `${WIDTH}px`;
        host.style.height = `${HEIGHT}px`;
        document.body.append(host);
        picks = [];
        events = [];
        moves = [];
        scene = createScene3d(host, { onPick: (pick) => picks.push(pick), onEvent: (event) => events.push(event), onMove: (move) => moves.push(move) });
    });

    afterEach(() => {
        scene.dispose();
        host.remove();
    });

    it('should pick the vertex pressed, and with Shift add another and take one out', async () => {
        // Arrange
        await draw(scene, [front(), sun(), cube('vertex')], settings);

        // Act
        click(host, vertexAt(2));
        await draw(scene, [front(), sun(), cube('vertex', [2])], settings);
        click(host, vertexAt(1), true);
        await draw(scene, [front(), sun(), cube('vertex', [2, 1])], settings);
        click(host, vertexAt(2), true);

        // Assert
        expect(scene.info().editing).toBe(1);
        expect(picks).toEqual([
            { path: cube('vertex').path, picked: [2] },
            { path: cube('vertex').path, picked: [2, 1] },
            { path: cube('vertex').path, picked: [1] }
        ]);
        expect(events).toEqual([]);
    });

    it('should draw a picked vertex in the pick colour over the mesh', async () => {
        // Arrange
        const [x, y] = vertexAt(2);

        // Act
        await draw(scene, [front(), sun(), cube('vertex', [2])], settings);
        const color = pixelAt(host, x / WIDTH, y / HEIGHT);

        // Assert
        expectColor(color, rgbOf(EDIT_COLORS.picked));
    });

    it('should not pick a vertex the mesh hides, and clear the pick for a press beside the mesh', async () => {
        // Arrange
        await draw(scene, [front(), sun(), cube('vertex', [2])], settings);

        // Act
        click(host, vertexAt(6));
        const hidden = [...picks];
        click(host, [4, 4]);

        // Assert
        expect(hidden).toEqual([{ path: cube('vertex').path, picked: [] }]);
        expect(picks).toHaveLength(2);
        expect(picks[1]?.picked).toEqual([]);
    });

    it('should pick the edge pressed near its middle, with the smaller index first', async () => {
        // Arrange
        await draw(scene, [front(), sun(), cube('edge')], settings);
        const [a, b] = [vertexAt(1), vertexAt(2)];

        // Act
        click(host, [(a[0] + b[0]) / 2 + 3, (a[1] + b[1]) / 2]);

        // Assert
        expect(picks).toEqual([{ path: cube('edge').path, picked: [[1, 2]] }]);
    });

    it('should pick the face pressed, by its index in faces', async () => {
        // Arrange
        await draw(scene, [front(), sun(), cube('face')], settings);

        // Act
        click(host, [WIDTH / 2, HEIGHT / 2]);

        // Assert
        expect(picks).toEqual([{ path: cube('face').path, picked: [0] }]);
    });

    it('should not drag or press a draggable mesh in edit mode, and press it again when the mode is none', async () => {
        // Arrange
        await draw(scene, [front(), sun(), cube('face', [], { draggable: 'ground' })], settings);

        // Act
        pointer(host, 'pointerdown', WIDTH / 2, HEIGHT / 2);
        pointer(host, 'pointermove', WIDTH / 2 + 30, HEIGHT / 2);
        pointer(host, 'pointerup', WIDTH / 2 + 30, HEIGHT / 2);
        await draw(scene, [front(), sun(), cube('none')], settings);
        click(host, [WIDTH / 2, HEIGHT / 2]);

        // Assert
        expect(moves).toEqual([]);
        expect(scene.info().editing).toBe(0);
        expect(events.map(({ name }) => name)).toEqual(['press']);
    });

    it('should put no mesh in edit mode without onPick', async () => {
        // Arrange
        scene.dispose();
        scene = createScene3d(host, { onEvent: (event) => events.push(event) });

        // Act
        await draw(scene, [front(), sun(), cube('vertex')], settings);
        click(host, [WIDTH / 2, HEIGHT / 2]);

        // Assert
        expect(scene.info().editing).toBe(0);
        expect(events.map(({ name }) => name)).toEqual(['press']);
    });
});

describe('moving the pick of a custom mesh with its gizmo, in Chromium (mesh editor V3)', () => {
    let host: HTMLElement;
    let scene: Scene3d;
    let changes: MeshGeometry[];
    let moves: NodeMove[];

    /** The front top-right corner picked, with a move gizmo that snaps to half units */
    const picked = (properties: Record<string, JsonValue> = {}): Scene3dTree => cube('vertex', [2], { gizmo: 'move', snap: true, step: 0.5, ...properties });
    /** A point on the x arrow of the gizmo at the corner: 30 pixels to its right */
    const onArrow = (): [number, number] => [vertexAt(2)[0] + 30, vertexAt(2)[1]];

    function hold(dx: number): void {
        const [x, y] = onArrow();
        pointer(host, 'pointerdown', x, y);
        for (const step of [5, 10, 15, dx]) pointer(host, 'pointermove', x + step, y);
    }

    beforeEach(() => {
        host = document.createElement('div');
        host.style.width = `${WIDTH}px`;
        host.style.height = `${HEIGHT}px`;
        document.body.append(host);
        changes = [];
        moves = [];
        scene = createScene3d(host, { onPick: () => undefined, onGeometry: (change) => changes.push(change), onMove: (move) => moves.push(move) });
    });

    afterEach(() => {
        scene.dispose();
        host.remove();
    });

    it('should move the picked vertex along the mesh axis in the renderer while held, and write the geometry once on release', async () => {
        // Arrange
        await draw(scene, [front(), sun(), picked()], settings);

        // Act
        hold(20);
        const during = scene.boundsOf(picked().path)?.max[0];
        const written = changes.length;
        const [x, y] = onArrow();
        pointer(host, 'pointerup', x + 20, y);

        // Assert: 20 pixels is about 0.6 units at the corner, snapped to 0.5
        const vertices = [...VERTICES];
        vertices[2] = [1.5, 1, 1];
        expect(during).toBeCloseTo(1.5, 5);
        expect(written).toBe(0);
        expect(changes).toEqual([{ path: picked().path, geometry: { kind: 'custom', vertices, faces: FACES } }]);
        expect(moves).toEqual([]);
    });

    it('should put the vertices back and write nothing on Escape', async () => {
        // Arrange
        await draw(scene, [front(), sun(), picked()], settings);

        // Act
        hold(20);
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        const [x, y] = onArrow();
        pointer(host, 'pointerup', x + 20, y);

        // Assert
        expect(scene.boundsOf(picked().path)?.max[0]).toBeCloseTo(1, 5);
        expect(changes).toEqual([]);
    });

    it('should move the mesh, not the pick, with a gizmo and no pick', async () => {
        // Arrange
        await draw(scene, [front(), sun(), cube('vertex', [], { gizmo: 'move' })], settings);
        const [x, y] = [WIDTH / 2 + 30, HEIGHT / 2];

        // Act
        pointer(host, 'pointerdown', x, y);
        for (const step of [5, 10, 15, 20]) pointer(host, 'pointermove', x + step, y);
        pointer(host, 'pointerup', x + 20, y);

        // Assert
        expect(changes).toEqual([]);
        expect(moves.map(({ property }) => property)).toEqual(['position']);
    });
});
