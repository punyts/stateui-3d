import { BoxGeometry, ConeGeometry, CylinderGeometry, Euler, Group, Mesh, MeshBasicMaterial, OrthographicCamera, PerspectiveCamera, Quaternion, Scene, TorusGeometry, Vector3 } from 'three';
import type { BufferGeometry, Camera, Object3D, Raycaster } from 'three';
import { isShownNode } from './interaction.js';
import { keepPosition3d, positionOf3d } from './drag.js';
import type { JsonValue, Scene3dTree, Vector3Tuple } from './tree.js';

/**
 * The move, rotate and scale gizmo (docs/design/stateui-3d-gizmo.md): the pure maths of what a handle does to a node's
 * `position`, `rotation` and `scale` (run in Node), and `Gizmos`, the handles drawn over the scene in a pass of their own
 */

/** What a node's `gizmo` shows */
export type GizmoMode = 'move' | 'rotate' | 'scale';

/** The property a gizmo's handles change */
export type GizmoProperty = 'position' | 'rotation' | 'scale';

/** The property each mode changes */
export const GIZMO_PROPERTY: Readonly<Record<GizmoMode, GizmoProperty>> = { move: 'position', rotate: 'rotation', scale: 'scale' };

/** The length of one handle on screen, in CSS pixels, however far the node is */
export const GIZMO_PIXELS = 96;

/** The turn `snap` steps by, in degrees, and the scale it rounds to */
export const ROTATE_SNAP = 15;
export const SCALE_SNAP = 0.1;

/** The smallest scale a handle leaves on an axis */
export const MIN_GIZMO_SCALE = 0.01;

/** A handle's axis: 0, 1, 2 for x, y, z; 3 for the centre cube of `scale` (all three) */
export type GizmoAxis = 0 | 1 | 2 | 3;

const AXES = ['x', 'y', 'z'] as const;

/** A number without the noise of the maths */
const clean = (value: number): number => Math.round(value * 1e6) / 1e6 + 0;

const vector = (value: JsonValue | undefined, fallback: number): [number, number, number] =>
    Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number' && Number.isFinite(item))
        ? [value[0] as number, value[1] as number, value[2] as number]
        : [fallback, fallback, fallback];

/** The node's gizmo when it shows one: an interactive node that is drawn, with `move`, `rotate` or `scale` */
export function gizmoMode(tree: Scene3dTree): GizmoMode | undefined {
    const { gizmo } = tree.properties;
    if (tree.properties.interactive !== true || !isShownNode(tree)) return undefined;
    return gizmo === 'move' || gizmo === 'rotate' || gizmo === 'scale' ? gizmo : undefined;
}

/** A node's `position`, `rotation` (degrees) or `scale`, with the defaults of an unset one */
export function gizmoValue(tree: Scene3dTree, property: GizmoProperty): Vector3Tuple {
    return property === 'position' ? positionOf3d(tree) : vector(tree.properties[property], property === 'scale' ? 1 : 0);
}

/** The position after a move handle along `axis` asks for `value` there: on a multiple of `step` with `snap`, x and z kept in `bounds` */
export function movedPosition(tree: Scene3dTree, axis: 0 | 1 | 2, value: number): Vector3Tuple {
    const wanted = positionOf3d(tree);
    wanted[axis] = value;
    return keepPosition3d(tree, wanted, [AXES[axis]]);
}

/**
 * The rotation (degrees, the node's x-y-z order) after a turn of `degrees` about the parent's `axis`, applied before
 * the node's own rotation; the turn in steps of `ROTATE_SNAP` with `snap`
 */
export function turnedRotation(tree: Scene3dTree, axis: 0 | 1 | 2, degrees: number): Vector3Tuple {
    const turn = tree.properties.snap === true ? Math.round(degrees / ROTATE_SNAP) * ROTATE_SNAP : degrees;
    const [x, y, z] = gizmoValue(tree, 'rotation').map((value) => (value * Math.PI) / 180) as [number, number, number];
    const about = new Vector3();
    about.setComponent(axis, 1);
    const turned = new Quaternion().setFromAxisAngle(about, (turn * Math.PI) / 180).multiply(new Quaternion().setFromEuler(new Euler(x, y, z)));
    const euler = new Euler().setFromQuaternion(turned);
    return [clean((euler.x * 180) / Math.PI), clean((euler.y * 180) / Math.PI), clean((euler.z * 180) / Math.PI)];
}

/** The scale after a handle multiplies `axis` (3: all three) by `factor`; at least `MIN_GIZMO_SCALE`, rounded to `SCALE_SNAP` with `snap` */
export function scaledScale(tree: Scene3dTree, axis: GizmoAxis, factor: number): Vector3Tuple {
    const scale = gizmoValue(tree, 'scale');
    return scale.map((value, index): number => {
        if (axis !== 3 && axis !== index) return value;
        let next = value * factor;
        if (tree.properties.snap === true) next = Math.round(next / SCALE_SNAP) * SCALE_SNAP;
        return clean(Math.max(MIN_GIZMO_SCALE, next));
    }) as unknown as Vector3Tuple;
}

/** The size of one handle length in world units at a point: `GIZMO_PIXELS` on a canvas `height` CSS pixels high */
export function gizmoScale(camera: Camera, at: Vector3, height: number): number {
    if (camera instanceof OrthographicCamera) return ((camera.top - camera.bottom) / camera.zoom / height) * GIZMO_PIXELS;
    const fov = camera instanceof PerspectiveCamera ? camera.fov : 50;
    const distance = camera.getWorldPosition(new Vector3()).distanceTo(at);
    return ((2 * distance * Math.tan((fov * Math.PI) / 360)) / height) * GIZMO_PIXELS;
}

/** The axis colours (x red, y green, z blue, the centre grey) and the colour of the handle a drag holds */
const COLORS = [0xe5484d, 0x30a46c, 0x3e63dd, 0xb0b0b0];
const HELD = 0xf5d90a;

/** Where a node's gizmo sits: its origin, the parent's turn (move, rotate) and the node's own turn (scale), all in world space */
export interface GizmoPlace {
    readonly origin: Vector3;
    readonly parent: Quaternion;
    readonly own: Quaternion;
}

/** A handle a ray met: the node's path, its mode and the axis */
export interface GizmoHandle {
    readonly path: string;
    readonly mode: GizmoMode;
    readonly axis: GizmoAxis;
}

/** One handle of a template: its drawn meshes and a larger hidden mesh the ray meets, along +y */
function handle(axis: GizmoAxis, drawn: readonly BufferGeometry[], hit: BufferGeometry, materials: readonly MeshBasicMaterial[]): Group {
    const group = new Group();
    for (const geometry of drawn) group.add(new Mesh(geometry, materials[axis]));
    group.add(Object.assign(new Mesh(hit, materials[5]), { userData: { axis } }));
    // The geometries point up y (rings lie about z): turned so each points along its axis
    if (axis === 0) group.rotation.z = -Math.PI / 2;
    if (axis === 2) group.rotation.x = Math.PI / 2;
    return group;
}

/** The handles of a mode, one length long, for every node of that mode to clone */
function template(mode: GizmoMode, materials: readonly MeshBasicMaterial[]): Group {
    const group = new Group();
    const shaft = new CylinderGeometry(0.02, 0.02, 0.75).translate(0, 0.525, 0);
    const reach = new CylinderGeometry(0.1, 0.1, 0.9).translate(0, 0.55, 0);
    for (const axis of [0, 1, 2] as const) {
        if (mode === 'rotate') {
            const ring = handle(axis, [new TorusGeometry(0.9, 0.015, 6, 48)], new TorusGeometry(0.9, 0.08, 4, 24), materials);
            // A ring lies about z: about x it turns about y, about y about x
            ring.rotation.set(axis === 1 ? Math.PI / 2 : 0, axis === 0 ? Math.PI / 2 : 0, 0);
            group.add(ring);
        } else {
            const end = mode === 'move' ? new ConeGeometry(0.07, 0.2).translate(0, 0.9, 0) : new BoxGeometry(0.12, 0.12, 0.12).translate(0, 0.9, 0);
            group.add(handle(axis, [shaft, end], reach, materials));
        }
    }
    if (mode === 'scale') group.add(handle(3, [new BoxGeometry(0.18, 0.18, 0.18)], new BoxGeometry(0.24, 0.24, 0.24), materials));
    return group;
}

/**
 * The gizmos of a scene's nodes, in a scene of their own that the renderer draws after the scene's, over it. Each node
 * whose `gizmoMode` is set gets a clone of its mode's handles; `place` puts each at its node and sizes it for the camera
 */
export class Gizmos {
    readonly scene = new Scene();
    private readonly templates = new Map<GizmoMode, Group>();
    private readonly shown = new Map<string, { readonly tree: Scene3dTree; readonly mode: GizmoMode; readonly group: Group }>();
    private held: Object3D | undefined;
    /** The axis colours, the held colour, and the hidden material of the meshes the ray meets: shared by every gizmo */
    private readonly materials = [...COLORS, HELD].map((color) => new MeshBasicMaterial({ color, toneMapped: false })).concat(new MeshBasicMaterial({ visible: false }));

    /** The nodes with a gizmo, out of the interactive nodes of a new tree */
    sync(nodes: Iterable<Scene3dTree>): void {
        const wanted = new Map<string, [Scene3dTree, GizmoMode]>();
        for (const tree of nodes) {
            const mode = gizmoMode(tree);
            if (mode !== undefined) wanted.set(tree.path, [tree, mode]);
        }
        for (const [path, entry] of this.shown) {
            if (wanted.get(path)?.[1] === entry.mode) continue;
            this.scene.remove(entry.group);
            this.shown.delete(path);
        }
        for (const [path, [tree, mode]] of wanted) {
            const known = this.shown.get(path);
            if (known !== undefined) {
                this.shown.set(path, { ...known, tree });
                continue;
            }
            let made = this.templates.get(mode);
            if (made === undefined) this.templates.set(mode, (made = template(mode, this.materials)));
            const group = made.clone();
            this.scene.add(group);
            this.shown.set(path, { tree, mode, group });
        }
    }

    /** The number of gizmos shown */
    get size(): number {
        return this.shown.size;
    }

    /** Puts each gizmo at its node through the camera of this frame; a node with no place hides its gizmo */
    place(camera: Camera, height: number, placeOf: (tree: Scene3dTree) => GizmoPlace | undefined): void {
        for (const { tree, mode, group } of this.shown.values()) {
            const place = placeOf(tree);
            group.visible = place !== undefined && height > 0;
            if (place === undefined || height <= 0) continue;
            group.position.copy(place.origin);
            group.quaternion.copy(mode === 'scale' ? place.own : place.parent);
            group.scale.setScalar(gizmoScale(camera, place.origin, height));
        }
        this.scene.updateMatrixWorld(true);
    }

    /** The nearest handle the ray meets; the centre cube of `scale` first, which an axis pointing at the camera covers */
    handleAt(raycaster: Raycaster): GizmoHandle | undefined {
        const met = raycaster.intersectObject(this.scene, true).sort((a, b) => Number(b.object.userData.axis === 3) - Number(a.object.userData.axis === 3));
        for (const { object } of met) {
            const axis = object.userData.axis as GizmoAxis | undefined;
            const gizmo = object.parent?.parent;
            if (axis === undefined || !gizmo?.visible) continue;
            for (const [path, entry] of this.shown) if (entry.group === gizmo) return { path, mode: entry.mode, axis };
        }
        return undefined;
    }

    /** Shows the handle a drag holds in the held colour, or none */
    hold(found?: GizmoHandle): void {
        this.paint(this.held);
        this.held = undefined;
        const entry = found === undefined ? undefined : this.shown.get(found.path);
        const group = entry?.group.children.find((child) => child.children.some((mesh) => mesh.userData.axis === found?.axis));
        if (group === undefined) return;
        this.held = group;
        this.paint(group, 4);
    }

    /** Draws a handle's meshes in a material: its axis colour, or the held colour */
    private paint(group: Object3D | undefined, color?: number): void {
        const axis = group?.children.find((mesh) => mesh.userData.axis !== undefined)?.userData.axis as GizmoAxis | undefined;
        for (const mesh of group?.children ?? []) if (mesh.userData.axis === undefined) (mesh as Mesh).material = this.materials[color ?? axis ?? 0] as MeshBasicMaterial;
    }

    /** Frees the handles' geometries and materials */
    dispose(): void {
        this.hold();
        for (const made of this.templates.values()) made.traverse((object) => (object as Mesh).geometry?.dispose());
        for (const material of this.materials) material.dispose();
        this.scene.clear();
        this.shown.clear();
    }
}
