import type { createScene3d } from './scene3d.js';

export { createScene3d, DEFAULT_CAMERA_POSITION, DEFAULT_FOV } from './scene3d.js';
export type { Scene3d, Scene3dOptions } from './scene3d.js';
export { NODE3D_KINDS, isNode3dKind } from './tree.js';
export type { Bounds3d, JsonValue, Node3dKind, Scene3dTree, Vector3Tuple } from './tree.js';
export { VERSION } from './version.js';

/** The name of the one global the runtime chunk sets on the page */
export const GLOBAL_NAME = '__stateui3d';

/** What the runtime chunk puts on `globalThis.__stateui3d`; the runtime's `load3d` hook resolves with it (G3.3) */
export interface Stateui3dGlobal {
    readonly version: string;
    readonly createScene3d: typeof createScene3d;
}
