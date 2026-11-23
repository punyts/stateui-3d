import { BufferGeometry, DoubleSide, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, Points, PointsMaterial, Quaternion, Scene, Vector3 } from 'three';
import type { Material, MeshStandardMaterial, Object3D } from 'three';
import { geometryParams } from './geometries.js';
import type { CustomParams, Vec3 } from './geometries.js';
import { isShownNode } from './interaction.js';
import type { JsonValue, Scene3dTree } from './tree.js';

/**
 * Editing a custom mesh in the scene (docs/design/stateui-mesh-editor.md, V2): the pure parts of picking its vertices,
 * edges and faces (run in Node), and `EditOverlay`, the dots and lines drawn over each mesh in edit mode in a scene of
 * their own, so they are never exported, never in the scene's bounds and never what `hit` finds
 */

/** What a press of a mesh in edit mode picks */
export type EditMode = 'vertex' | 'edge' | 'face';

/** The `edit.mode` values: `none` leaves the mesh as any other */
export const EDIT_MODES = ['none', 'vertex', 'edge', 'face'] as const;

/** How near, in CSS pixels, a press must be to a vertex or an edge where it is drawn to pick it */
export const VERTEX_PICK_PIXELS = 10;
export const EDGE_PICK_PIXELS = 8;

/** The overlay's colours: fixed, as the gizmo's are, since they mark the tool and not the theme */
export const EDIT_COLORS = { wire: '#1b1f24', picked: '#ff8a00' } as const;

/** A picked element: a vertex or a face index, or an edge as `[a, b]` with the smaller index first */
export type EditElement = number | readonly [number, number];

/** A point on the canvas in CSS pixels from its top-left corner */
export type ScreenPoint = readonly [number, number];

/** The edit mode of a node: a `mesh` with a `custom` geometry, interactive and drawn, whose `edit.mode` is not `none` */
export function editModeOf(tree: Scene3dTree): EditMode | undefined {
    const { geometry, edit, interactive } = tree.properties;
    if (tree.kind !== 'mesh' || interactive !== true || !isShownNode(tree)) return undefined;
    if (typeof geometry !== 'object' || geometry === null || Array.isArray(geometry) || geometry.kind !== 'custom') return undefined;
    const mode = typeof edit === 'object' && edit !== null && !Array.isArray(edit) ? edit.mode : undefined;
    return mode === 'vertex' || mode === 'edge' || mode === 'face' ? mode : undefined;
}

/** The edges of the faces, each once, as `[a, b]` with the smaller index first, in the order the faces give them */
export function meshEdges(faces: readonly (readonly number[])[]): [number, number][] {
    const seen = new Set<string>();
    const edges: [number, number][] = [];
    for (const face of faces) {
        face.forEach((from, at) => {
            const to = face[(at + 1) % face.length] as number;
            const edge: [number, number] = from < to ? [from, to] : [to, from];
            const key = `${edge[0]},${edge[1]}`;
            if (face.length < 3 || seen.has(key)) return;
            seen.add(key);
            edges.push(edge);
        });
    }
    return edges;
}

/** The elements of `edit.picked` that the geometry has, read for a mode; anything else is left out */
export function readPicked(mode: EditMode, value: JsonValue | undefined, params: CustomParams): EditElement[] {
    if (!Array.isArray(value)) return [];
    if (mode === 'edge') {
        const edges = new Set(meshEdges(params.faces).map(([a, b]) => `${a},${b}`));
        return value.filter((entry): entry is [number, number] => Array.isArray(entry) && entry.length === 2 && edges.has(`${entry[0]},${entry[1]}`));
    }
    const count = mode === 'vertex' ? params.vertices.length : params.faces.length;
    return value.filter((entry): entry is number => typeof entry === 'number' && Number.isInteger(entry) && entry >= 0 && entry < count && (mode === 'vertex' || (params.faces[entry]?.length ?? 0) > 0));
}

const sameElement = (a: EditElement, b: EditElement): boolean => (typeof a === 'number' || typeof b === 'number' ? a === b : a[0] === b[0] && a[1] === b[1]);

/** The pick after a press of an element: that element alone, or with `add` (Shift) the pick with it added or taken out */
export function togglePick(picked: readonly EditElement[], element: EditElement, add: boolean): EditElement[] {
    if (!add) return [element];
    return picked.some((entry) => sameElement(entry, element)) ? picked.filter((entry) => !sameElement(entry, element)) : [...picked, element];
}

/** The indices of the points within `max` pixels of (x, y), nearest first; an undefined point (behind the camera) is never near */
export function nearPoints(points: readonly (ScreenPoint | undefined)[], x: number, y: number, max: number): { index: number; distance: number }[] {
    const near: { index: number; distance: number }[] = [];
    points.forEach((point, index) => {
        const distance = point === undefined ? Infinity : Math.hypot(point[0] - x, point[1] - y);
        if (distance <= max) near.push({ index, distance });
    });
    return near.sort((a, b) => a.distance - b.distance);
}

/** How far (x, y) is from the segment a-b, and how far along it (0 at a, 1 at b) its nearest point is */
export function segmentDistance(a: ScreenPoint, b: ScreenPoint, x: number, y: number): { distance: number; along: number } {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = dx * dx + dy * dy;
    const along = length === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / length));
    return { distance: Math.hypot(a[0] + along * dx - x, a[1] + along * dy - y), along };
}

/** One edge of a pick, or every vertex of a picked face: the vertex indices a pick moves, each once, in ascending order */
export function pickedVertices(mode: EditMode, picked: readonly EditElement[], faces: readonly (readonly number[])[]): number[] {
    const indices = new Set<number>();
    for (const element of picked) {
        if (typeof element !== 'number') element.forEach((index) => indices.add(index));
        else if (mode === 'face') faces[element]?.forEach((index) => indices.add(index));
        else indices.add(element);
    }
    return [...indices].sort((a, b) => a - b);
}

/** The centre of the vertices at the indices: their mean, in the mesh's own space */
export function centreOf(vertices: readonly Vec3[], indices: readonly number[]): Vec3 {
    const sum = [0, 0, 0];
    for (const index of indices) (vertices[index] ?? [0, 0, 0]).forEach((value, axis) => (sum[axis] = (sum[axis] as number) + value));
    const count = Math.max(1, indices.length);
    return [(sum[0] as number) / count, (sum[1] as number) / count, (sum[2] as number) / count];
}

/**
 * What a held handle does to a pick, in the mesh's own space about the pick's centre: `move` by a distance along an
 * axis, `turn` by degrees about one, `scale` by a factor along one (3: all three)
 */
export type PickChange = { readonly kind: 'move'; readonly axis: 0 | 1 | 2; readonly by: number } | { readonly kind: 'turn'; readonly axis: 0 | 1 | 2; readonly degrees: number } | { readonly kind: 'scale'; readonly axis: 0 | 1 | 2 | 3; readonly factor: number };

/** A coordinate without the noise of the maths */
const clean = (value: number): number => Math.round(value * 1e6) / 1e6 + 0;

/** The vertices with those at the indices changed about the centre; the others are kept as they are */
export function reshapeVertices(vertices: readonly Vec3[], indices: readonly number[], change: PickChange, centre: Vec3): Vec3[] {
    const moved = new Set(indices);
    const about = new Vector3();
    if (change.kind === 'turn') about.setComponent(change.axis, 1);
    const turn = change.kind === 'turn' ? new Quaternion().setFromAxisAngle(about, (change.degrees * Math.PI) / 180) : undefined;
    return vertices.map((vertex, index): Vec3 => {
        if (!moved.has(index)) return vertex;
        const point = new Vector3(vertex[0] - centre[0], vertex[1] - centre[1], vertex[2] - centre[2]);
        if (change.kind === 'move') point.setComponent(change.axis, point.getComponent(change.axis) + change.by);
        else if (turn !== undefined) point.applyQuaternion(turn);
        else if (change.kind === 'scale') for (const axis of [0, 1, 2]) if (change.axis === 3 || change.axis === axis) point.setComponent(axis, point.getComponent(axis) * change.factor);
        return [clean(point.x + centre[0]), clean(point.y + centre[1]), clean(point.z + centre[2])];
    });
}

/** One mesh in edit mode: its node, its geometry read, its pick, the overlay drawn for them and the key they were drawn from */
export interface EditEntry {
    readonly tree: Scene3dTree;
    readonly mode: EditMode;
    readonly params: CustomParams;
    readonly picked: readonly EditElement[];
    readonly group: Group;
    readonly key: string;
}

/** A geometry of positions, flat `[x, y, z, ...]` */
const positions = (values: number[]): BufferGeometry => new BufferGeometry().setAttribute('position', new Float32BufferAttribute(values, 3));

/**
 * The overlays of the meshes in edit mode, in a scene of their own that the renderer draws after the scene's with its
 * depth kept, so only what is in front shows: each mesh's vertices as dots and its edges as lines, the picked ones (and
 * picked faces, see-through) in the pick colour. A mesh in edit mode has its faces pushed back a little in depth
 * (polygon offset), so its lines are not hidden in them
 */
export class EditOverlay {
    readonly scene = new Scene();
    private readonly shown = new Map<string, EditEntry>();
    private readonly materials: Material[] = [
        new PointsMaterial({ color: EDIT_COLORS.wire, size: 5, sizeAttenuation: false, toneMapped: false }),
        new PointsMaterial({ color: EDIT_COLORS.picked, size: 8, sizeAttenuation: false, toneMapped: false }),
        new LineBasicMaterial({ color: EDIT_COLORS.wire, toneMapped: false }),
        new LineBasicMaterial({ color: EDIT_COLORS.picked, toneMapped: false }),
        new MeshBasicMaterial({ color: EDIT_COLORS.picked, transparent: true, opacity: 0.45, side: DoubleSide, depthWrite: false, toneMapped: false })
    ];

    /** The meshes in edit mode, out of the interactive nodes of a new tree; a mesh whose geometry or pick changed is drawn again */
    sync(nodes: Iterable<Scene3dTree>, objectOf: (path: string) => Object3D | undefined): void {
        const wanted = new Map<string, Scene3dTree>();
        // A repeat3d copy has no object of its own (it is an instance), so it is never in edit mode
        for (const tree of nodes) if (editModeOf(tree) !== undefined && objectOf(tree.path) !== undefined) wanted.set(tree.path, tree);
        for (const [path, entry] of this.shown) {
            if (wanted.has(path)) continue;
            this.drop(entry);
            this.shown.delete(path);
            offset(objectOf(path), false);
        }
        for (const [path, tree] of wanted) {
            const mode = editModeOf(tree) as EditMode;
            const edit = tree.properties.edit as { [key: string]: JsonValue };
            const key = JSON.stringify([mode, tree.properties.geometry, edit.picked]);
            offset(objectOf(path), true);
            const known = this.shown.get(path);
            if (known?.key === key) {
                this.shown.set(path, { ...known, tree });
                continue;
            }
            if (known !== undefined) this.drop(known);
            const params = geometryParams(tree.properties.geometry) as CustomParams;
            const picked = readPicked(mode, edit.picked, params);
            const group = this.draw(mode, params, picked);
            this.scene.add(group);
            this.shown.set(path, { tree, mode, params, picked, group, key });
        }
    }

    /** The meshes in edit mode */
    get size(): number {
        return this.shown.size;
    }

    /** The entry of a mesh in edit mode */
    entry(path: string): EditEntry | undefined {
        return this.shown.get(path);
    }

    entries(): IterableIterator<EditEntry> {
        return this.shown.values();
    }

    /** Draws a mesh's overlay again over vertices a held handle moved, or over its geometry's own (none) */
    show(path: string, vertices?: readonly Vec3[]): void {
        const entry = this.shown.get(path);
        if (entry === undefined) return;
        this.drop(entry);
        const group = this.draw(entry.mode, vertices === undefined ? entry.params : { ...entry.params, vertices }, entry.picked);
        this.scene.add(group);
        this.shown.set(path, { ...entry, group });
    }

    /** Puts each overlay where its mesh is drawn this frame; a mesh that is not drawn hides it */
    place(objectOf: (path: string) => Object3D | undefined): void {
        for (const [path, { group }] of this.shown) {
            const object = objectOf(path);
            let shown = object !== undefined;
            for (let at = object; at && shown; at = at.parent ?? undefined) shown = at.visible;
            group.visible = shown;
            if (object !== undefined) group.matrix.copy(object.matrixWorld);
        }
        this.scene.updateMatrixWorld(true);
    }

    /** Frees the overlays and their materials */
    dispose(): void {
        for (const entry of this.shown.values()) this.drop(entry);
        this.shown.clear();
        for (const material of this.materials) material.dispose();
    }

    private draw(mode: EditMode, { vertices, faces }: CustomParams, picked: readonly EditElement[]): Group {
        const group = new Group();
        group.matrixAutoUpdate = false;
        const [dots, pickedDots, lines, pickedLines, pickedFaces] = this.materials as [PointsMaterial, PointsMaterial, LineBasicMaterial, LineBasicMaterial, MeshBasicMaterial];
        const corners = (indices: readonly number[]): number[] => indices.flatMap((index) => [...(vertices[index] ?? [0, 0, 0])]);
        const edges = meshEdges(faces);
        group.add(new Points(positions(vertices.flat()), dots), new LineSegments(positions(corners(edges.flat())), lines));
        if (picked.length === 0) return group;
        let mark: Object3D;
        if (mode === 'vertex') mark = new Points(positions(corners(picked as number[])), pickedDots);
        else if (mode === 'edge') mark = new LineSegments(positions(corners((picked as [number, number][]).flat())), pickedLines);
        else {
            const triangles = (picked as number[]).flatMap((index) => {
                const face = faces[index] ?? [];
                return face.slice(1, -1).flatMap((at, step) => [face[0] as number, at, face[step + 2] as number]);
            });
            mark = new Mesh(positions(corners(triangles)), pickedFaces);
        }
        // Over the wire where they meet: three would otherwise draw the opaque marks in material order
        mark.renderOrder = 1;
        group.add(mark);
        return group;
    }

    private drop(entry: EditEntry): void {
        this.scene.remove(entry.group);
        entry.group.traverse((object) => (object as Mesh).geometry?.dispose());
    }
}

/** Pushes a mesh's faces back in depth while it is in edit mode, so the overlay's lines on its edges show */
function offset(object: Object3D | undefined, on: boolean): void {
    const material = (object as Mesh | undefined)?.material as MeshStandardMaterial | undefined;
    if (material === undefined || material.polygonOffset === on) return;
    material.polygonOffset = on;
    material.polygonOffsetFactor = on ? 1 : 0;
    material.polygonOffsetUnits = on ? 1 : 0;
    material.needsUpdate = true;
}
