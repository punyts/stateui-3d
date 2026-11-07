import type { createScene3d } from './scene3d.js';

export { CONTEXT_RESTORE_TIMEOUT, createScene3d } from './scene3d.js';
export type { Scene3d, Scene3dInfo, Scene3dOptions, Scene3dStatus } from './scene3d.js';
export type { Scene3dEvent } from './scene3d.js';
export { PRESS_SLOP, PressGesture, interactiveNodes, isShownNode, screenBox } from './interaction.js';
export type { ScreenBox } from './interaction.js';
export { createProxies } from './proxies.js';
export type { Proxies, ProxyHooks } from './proxies.js';
export { DEFAULT_CAMERA_POSITION, DEFAULT_FOV, DEFAULT_VIEW_DIRECTION, FRAME_MARGIN, activeCamera, frameBounds, orthographicHeight } from './cameras.js';
export type { CameraFrame } from './cameras.js';
export { CONTROLS_MODES, KEY_PAN_STEP, KEY_ROTATE_STEP, KEY_ZOOM_STEP, controlsMode, createCameraControls, keyAction } from './controls.js';
export type { CameraControls, CameraControlsHost, CameraMove, CameraView, ControlsMode, KeyAction } from './controls.js';
export { CameraGestures, WHEEL_IDLE } from './gesture.js';
export type { CameraGestureHooks, ControlsEvents, ControlsEventType, GestureClock, GestureKind } from './gesture.js';
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
export type { ReadSceneFile, Scene3dIssue } from './scene.js';
export { GLB_MAGIC, decodeDataUri, decodeGlb, encodeGlb, inspectGlb, isDataUri } from './glb.js';
export type { GlbInspection, GltfJson, ModelRefusal, ModelRefusalCode } from './glb.js';
export { BITMAP_IMAGES_PLUGIN, BITMAP_OPTIONS, ModelError, bitmapImages, disposeModel, parseModel } from './models.js';
export { MAP_BITMAP_OPTIONS, MapTextures, TEXTURE_FILE_TYPES, mapSource } from './textures.js';
export type { MapSource } from './textures.js';
export { INSTANCE_CAP, InstanceLayout, MAX_UPDATE_RANGES, MIN_INSTANCE_CAPACITY, RepeatInstances, SHARED_ROW_PROPERTIES, instanceCapacity, instanceMatrix, instanceValues } from './instances.js';
export type { InstanceChanges, InstanceValues } from './instances.js';
export { DEFAULT_LABEL_COLOR, DEFAULT_LABEL_FONT, DEFAULT_LABEL_FONT_SIZE, LABEL_FONT_PX, LABEL_LINE_HEIGHT, LABEL_MAX_CHARS, LABEL_MAX_WIDTH, LABEL_PADDING, Labels, MAX_LABEL_FONT_SIZE, labelCanvasSize, labelFont, labelFontSize, labelText } from './labels.js';
export type { LabelHooks } from './labels.js';
export { NODE3D_KINDS, isNode3dKind } from './tree.js';
export type { Bounds3d, ColorResolver, JsonValue, Node3dKind, Scene3dSettings, Scene3dTree, Vector3Tuple } from './tree.js';
export { DEFAULT_DURATIONS, DEFAULT_EASINGS, REDUCED_MOTION_PROPERTY, createScheduler, cubicBezier, durationToken, easingToken, interpolate, isReducedMotion, parseCubicBezier, parseDuration, parseEasing } from './scheduler.js';
export type { Easing, FrameTask, ReadToken, Scheduler, SchedulerHost, Timing, TweenValue } from './scheduler.js';
export { TWEENED_CHANNELS, createMotion3d, formatRgb, timingOf } from './motion.js';
export { ANIMATION3D_NAMES, BOB_HEIGHT, DEFAULT_ANIMATION_DURATION, PULSE_GROWTH, animatedProperties3d, createAnimations3d, readAnimation3d } from './animate.js';
export type { Animation3d, Animation3dName, Animations3d } from './animate.js';
export { ModelClips, unknownClipReason } from './clips.js';
export type { ModelClipsHooks } from './clips.js';
export type { Motion3d, Motion3dOptions, Rgb } from './motion.js';
export { VERSION } from './version.js';

/** The name of the one global the runtime chunk sets on the page */
export const GLOBAL_NAME = '__stateui3d';

/** What the runtime chunk puts on `globalThis.__stateui3d`; the runtime's `load3d` hook resolves with it (G3.3) */
export interface Stateui3dGlobal {
    readonly version: string;
    readonly createScene3d: typeof createScene3d;
}
