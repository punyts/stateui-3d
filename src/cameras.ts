import type { Scene3dTree, Vector3Tuple } from './tree.js';

/** The vertical field of view, in degrees, of the camera a scene with no `camera` node gets, and of a camera without `fov` */
export const DEFAULT_FOV = 50;
/** Where the default camera stands while the scene draws nothing; it looks at the origin */
export const DEFAULT_CAMERA_POSITION: Vector3Tuple = [0, 0, 5];
/** Where the default camera looks from, seen from the middle of the scene's bounds: straight in front, along +z */
export const DEFAULT_VIEW_DIRECTION: Vector3Tuple = [0, 0, 1];
/** The room the default camera leaves around the scene's bounds: 1.15 is 15% more than the bounding sphere */
export const FRAME_MARGIN = 1.15;

/**
 * The active camera of a tree: the first `camera` node with `active: true`, else the first `camera` node, in the order
 * of the tree (depth first, a group's children before its next sibling); undefined when the tree has none. Pure
 */
export function activeCamera(trees: readonly Scene3dTree[]): Scene3dTree | undefined {
    let first: Scene3dTree | undefined;
    const visit = (nodes: readonly Scene3dTree[]): Scene3dTree | undefined => {
        for (const node of nodes) {
            if (node.kind === 'camera') {
                if (node.properties.active === true) return node;
                first ??= node;
            }
            const found = visit(node.children);
            if (found !== undefined) return found;
        }
        return undefined;
    };
    return visit(trees) ?? first;
}

/** Where a camera stands and looks to frame some bounds, and the near and far planes that keep them in view */
export interface CameraFrame {
    readonly position: Vector3Tuple;
    readonly target: Vector3Tuple;
    readonly near: number;
    readonly far: number;
}

/**
 * The view of the default camera: it looks at the middle of the bounds from `DEFAULT_VIEW_DIRECTION`, far enough that
 * the bounding sphere (with `FRAME_MARGIN`) fits the narrower of the vertical field of view `fov` (degrees) and the
 * horizontal one the aspect ratio gives. With no bounds (an empty scene) it stands at `DEFAULT_CAMERA_POSITION`
 * looking at the origin. Pure
 */
export function frameBounds(bounds: { min: Vector3Tuple; max: Vector3Tuple } | undefined, fov: number, aspect: number): CameraFrame {
    if (bounds === undefined) return { position: DEFAULT_CAMERA_POSITION, target: [0, 0, 0], near: 0.1, far: 1000 };
    const { min, max } = bounds;
    const centre: Vector3Tuple = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const radius = Math.max(Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2, 0.01);
    const vertical = (fov * Math.PI) / 180;
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * (Number.isFinite(aspect) && aspect > 0 ? aspect : 1));
    const half = Math.min(vertical, horizontal) / 2;
    const distance = (radius * FRAME_MARGIN) / Math.sin(half);
    const [dx, dy, dz] = DEFAULT_VIEW_DIRECTION;
    return {
        position: [centre[0] + dx * distance, centre[1] + dy * distance, centre[2] + dz * distance],
        target: centre,
        near: Math.max(distance - radius * 2, distance / 1000, 0.01),
        far: distance + radius * 2
    };
}

/**
 * The height in scene units an orthographic camera shows: what a perspective camera of the same `fov` (degrees) sees
 * at the distance of its target, so switching `kind` keeps the size of the subject. Pure
 */
export function orthographicHeight(distance: number, fov: number): number {
    return Math.max(2 * distance * Math.tan((fov * Math.PI) / 360), 0.01);
}
