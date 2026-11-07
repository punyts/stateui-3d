import type { createScene3d } from './scene3d.js';

export { CONTEXT_RESTORE_TIMEOUT, createScene3d } from './scene3d.js';
export type { Scene3d, Scene3dInfo, Scene3dOptions, Scene3dStatus } from './scene3d.js';
export { DEFAULT_CAMERA_POSITION, DEFAULT_FOV, DEFAULT_VIEW_DIRECTION, FRAME_MARGIN, activeCamera, frameBounds, orthographicHeight } from './cameras.js';
export type { CameraFrame } from './cameras.js';
export { DEFAULT_ENVIRONMENT, DEFAULT_FOG_FAR, DEFAULT_FOG_NEAR, ENVIRONMENT_NAMES, ENVIRONMENT_PRESETS, environmentPreset, fogParams, isEnvironmentName } from './environment.js';
export type { EnvironmentLight, EnvironmentName, EnvironmentPreset, FogParams } from './environment.js';
export { changedProperties, diffTrees, flattenTree, sameValue } from './diff.js';
export type { FlatNode, TreeDiff } from './diff.js';
export { GEOMETRY_KINDS, MAX_SEGMENTS, MAX_SIZE, MIN_SEGMENTS, geometryParams, isGeometryKind } from './geometries.js';
export type { GeometryKind, GeometryParams } from './geometries.js';
export { DEFAULT_MESH_COLOR, DEFAULT_METALNESS, DEFAULT_ROUGHNESS, materialParams } from './materials.js';
export type { MaterialParams } from './materials.js';
export { FALLBACK_SIZE, MAX_PIXEL_RATIO, Scene3dError, isScene3dError } from './renderer.js';
export type { Scene3dErrorCode } from './renderer.js';
export { LIGHT_SCALE, SHADOW_MAP_SIZE, lightIntensity } from './scene.js';
export { NODE3D_KINDS, isNode3dKind } from './tree.js';
export type { Bounds3d, ColorResolver, JsonValue, Node3dKind, Scene3dSettings, Scene3dTree, Vector3Tuple } from './tree.js';
export { VERSION } from './version.js';

/** The name of the one global the runtime chunk sets on the page */
export const GLOBAL_NAME = '__stateui3d';

/** What the runtime chunk puts on `globalThis.__stateui3d`; the runtime's `load3d` hook resolves with it (G3.3) */
export interface Stateui3dGlobal {
    readonly version: string;
    readonly createScene3d: typeof createScene3d;
}
