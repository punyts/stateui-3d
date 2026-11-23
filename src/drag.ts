import type { JsonValue, Scene3dTree, Vector3Tuple } from './tree.js';
import { isShownNode } from './interaction.js';

/**
 * The pure parts of dragging a 3D node (docs/design/stateui-3d-drag.md): which axes a node moves on, where a position
 * is kept (`bounds`, `snap`) and where an arrow key puts it. They run in Node; the scene (`scene3d.ts`) casts the ray.
 */

/** An axis of the parent's ground plane a node is dragged along */
export type DragAxis3d = 'x' | 'z';

/** The keyboard step when a node has no usable `step`; Shift moves ten steps */
export const DEFAULT_STEP_3D = 1;

const finite = (value: JsonValue | undefined): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** A number without the noise of the matrix maths */
const clean = (value: number): number => Math.round(value * 1e6) / 1e6 + 0;

/** The axes `draggable` names (`x`, `z`, or both for `ground`) for an interactive node that is drawn; none otherwise */
export function dragAxes3d(tree: Scene3dTree): readonly DragAxis3d[] {
    if (tree.properties.interactive !== true || !isShownNode(tree)) return [];
    const draggable = tree.properties.draggable;
    return draggable === 'x' ? ['x'] : draggable === 'z' ? ['z'] : draggable === 'ground' ? ['x', 'z'] : [];
}

/** The node's `position`, `[0, 0, 0]` when it is unset */
export function positionOf3d(tree: Scene3dTree): [number, number, number] {
    const value = tree.properties.position;
    return Array.isArray(value) && value.length === 3 && value.every((item) => finite(item) !== undefined)
        ? [value[0] as number, value[1] as number, value[2] as number]
        : [0, 0, 0];
}

/** The node's step: its `step` when it is a number above 0, else `DEFAULT_STEP_3D` */
function stepOf(tree: Scene3dTree): number {
    const step = finite(tree.properties.step);
    return step !== undefined && step > 0 ? step : DEFAULT_STEP_3D;
}

/**
 * Where a drag or a key may put the node when it asks for `wanted`: the axes it does not move on keep the node's own
 * values, `snap` rounds the moving axes to multiples of `step`, and `bounds` (`{ x, z, width, depth }`) keeps them inside
 */
export function keepPosition3d(tree: Scene3dTree, wanted: Vector3Tuple): Vector3Tuple {
    const axes = dragAxes3d(tree);
    const at = positionOf3d(tree);
    const result: [number, number, number] = [...at];
    const bounds = tree.properties.bounds;
    const box = typeof bounds === 'object' && bounds !== null && !Array.isArray(bounds) ? bounds : undefined;
    for (const axis of axes) {
        const index = axis === 'x' ? 0 : 2;
        let value = wanted[index];
        if (tree.properties.snap === true) value = Math.round(value / stepOf(tree)) * stepOf(tree);
        const min = box === undefined ? undefined : finite(box[axis]);
        const size = box === undefined ? undefined : finite(box[axis === 'x' ? 'width' : 'depth']);
        if (min !== undefined && size !== undefined && size >= 0) value = Math.min(min + size, Math.max(min, value));
        result[index] = clean(value);
    }
    return result;
}

/**
 * Where an arrow key puts a draggable node: `step` along x for Left and Right, along z for Up (-z) and Down (+z), ten
 * steps with Shift, then kept as a drag is. Undefined for another key or an axis the node does not move on
 */
export function stepMove3d(tree: Scene3dTree, key: string, shift: boolean): Vector3Tuple | undefined {
    const moves: Record<string, [DragAxis3d, number]> = { ArrowLeft: ['x', -1], ArrowRight: ['x', 1], ArrowUp: ['z', -1], ArrowDown: ['z', 1] };
    const move = Object.hasOwn(moves, key) ? moves[key] : undefined;
    if (move === undefined || !dragAxes3d(tree).includes(move[0])) return undefined;
    const at = positionOf3d(tree);
    const index = move[0] === 'x' ? 0 : 2;
    at[index] += move[1] * stepOf(tree) * (shift ? 10 : 1);
    return keepPosition3d(tree, at);
}
