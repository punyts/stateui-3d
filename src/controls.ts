import { MOUSE, OrthographicCamera, PerspectiveCamera, TOUCH, Vector3 } from 'three';
import type { Camera, Object3D } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { DEFAULT_CAMERA_POSITION, DEFAULT_FOV, orthographicHeight } from './cameras.js';
import { CameraGestures } from './gesture.js';
import type { GestureClock } from './gesture.js';
import type { Scene3dTree, Vector3Tuple } from './tree.js';

/** The `controls` of a scene: none (the default), orbit (rotate and zoom) or pan (pan only) */
export const CONTROLS_MODES = ['none', 'orbit', 'pan'] as const;

export type ControlsMode = (typeof CONTROLS_MODES)[number];

/** The controls mode a value names; anything but `orbit` and `pan` is `none` */
export const controlsMode = (value: unknown): ControlsMode => (value === 'orbit' || value === 'pan' ? value : 'none');

/** How far an arrow key turns the camera around its target in `orbit`, in radians (15 degrees) */
export const KEY_ROTATE_STEP = Math.PI / 12;
/** How far an arrow key moves the camera in `pan`, as a share of the scene's height on screen */
export const KEY_PAN_STEP = 0.1;
/** What `+` scales the camera's distance to its target by in `orbit`; `-` scales it by the inverse */
export const KEY_ZOOM_STEP = 0.8;

/** What a key does to the camera: turn it (left, up, in radians), move it (right and down, in the scene's heights), or scale its distance */
export type KeyAction = { readonly rotate: readonly [number, number] } | { readonly pan: readonly [number, number] } | { readonly zoom: number };

/**
 * What a key does in a controls mode: in `orbit` the arrow keys turn the camera around its target by
 * `KEY_ROTATE_STEP` and `+` and `-` bring it nearer or farther (`KEY_ZOOM_STEP`); in `pan` the arrow keys move the
 * camera and its target by `KEY_PAN_STEP` of the scene's height. The directions are those of three.js's own
 * `OrbitControls` keys. Undefined for any other key, and for every key in `none`. Pure
 */
export function keyAction(key: string, mode: ControlsMode): KeyAction | undefined {
    if (mode === 'orbit') {
        switch (key) {
            case 'ArrowLeft':
                return { rotate: [KEY_ROTATE_STEP, 0] };
            case 'ArrowRight':
                return { rotate: [-KEY_ROTATE_STEP, 0] };
            case 'ArrowUp':
                return { rotate: [0, KEY_ROTATE_STEP] };
            case 'ArrowDown':
                return { rotate: [0, -KEY_ROTATE_STEP] };
            case '+':
                return { zoom: KEY_ZOOM_STEP };
            case '-':
                return { zoom: 1 / KEY_ZOOM_STEP };
            default:
                return undefined;
        }
    }
    if (mode === 'pan') {
        switch (key) {
            case 'ArrowLeft':
                return { pan: [KEY_PAN_STEP, 0] };
            case 'ArrowRight':
                return { pan: [-KEY_PAN_STEP, 0] };
            case 'ArrowUp':
                return { pan: [0, KEY_PAN_STEP] };
            case 'ArrowDown':
                return { pan: [0, -KEY_PAN_STEP] };
            default:
                return undefined;
        }
    }
    return undefined;
}

/** What a scene's controls hand the feeder when a gesture ends: the active camera's new `position` and `target` */
export interface CameraMove {
    /** The state path of the `camera` node */
    readonly path: string;
    /** In the space of the node's parent, as the node's own `position` and `target` are */
    readonly position: Vector3Tuple;
    readonly target: Vector3Tuple;
}

/** How the tree's camera draws: where it stands and looks (in world space), and its lens */
export interface CameraView {
    readonly position: Vector3;
    readonly target: Vector3;
    readonly fov: number;
    readonly near: number;
    readonly far: number;
    readonly orthographic: boolean;
    /** The state path of the `camera` node drawn through; undefined for the default camera */
    readonly path?: string;
    /** The object of that node's parent, whose space its `position` and `target` are in */
    readonly parent?: Object3D | null;
}

/** What the controls need of their scene */
export interface CameraControlsHost {
    /** The canvas the pointer and the wheel move the camera on */
    readonly canvas: HTMLCanvasElement;
    /** The element that is focusable with controls and whose keys move the camera */
    readonly keyTarget: Element;
    /** How the tree's camera draws now (the active `camera` node's, or the default camera's) */
    view(): CameraView;
    /** Asks for a frame the feeder did not ask for */
    draw(): void;
    /** Told the active camera's new `position` and `target` when a gesture that moved it ends; the feeder writes them */
    readonly onCamera?: (move: CameraMove) => void;
}

/** The orbit and pan controls of a scene */
export interface CameraControls {
    /** The mode in use */
    readonly mode: ControlsMode;
    /** Sets the mode: `none` stops listening, ends a gesture under way with no write and gives the camera back to the tree */
    setMode(mode: ControlsMode): void;
    /** The tree's active camera after an update: a change of it is the state's camera changing (see `CameraGestures`) */
    treeChanged(camera: Scene3dTree | undefined): void;
    /** The camera to draw through while the controls hold the camera (from a gesture until the state's camera changes); else undefined */
    camera(aspect: number): Camera | undefined;
    dispose(): void;
}

/** A number without the noise of the matrix maths */
const clean = (value: number): number => Math.round(value * 1e6) / 1e6 + 0;

/**
 * The orbit and pan controls of a scene (G3.8b of the graphics epic 3), with three.js's `OrbitControls`: `orbit`
 * turns the camera around its target with the primary pointer button and zooms with the wheel (no pan), `pan` moves
 * the camera and its target with the primary button (no turn, no zoom). The controls move a camera of their own (a
 * perspective rig in world space, so a camera node inside a moved group, an orthographic camera and the default
 * camera all move the same way): from the start of a gesture the scene draws through it (`camera`), with the lens of
 * the tree's camera, and the tree's objects are never changed. The state's camera takes over again when it changes.
 *
 * The camera moves on every frame of a gesture and nothing is written until it ends (`CameraGestures`): then the
 * active camera node's `position` and `target`, in its parent's space, go to `onCamera` once, when they changed. The
 * default camera (a scene with no `camera` node) has nowhere to be written: it keeps the view in the renderer only.
 *
 * With controls, the key target is focusable (`tabindex="0"`, unless it has a `tabindex` of its own): the arrow keys
 * turn or pan and `+` and `-` zoom (`keyAction`), a step per key press (a held key repeats), written when the keys are
 * released; Escape during a pointer gesture puts the camera back where it started and writes nothing. No damping, so
 * a gesture never moves the camera after it ends, with or without reduced motion
 */
export function createCameraControls(host: CameraControlsHost): CameraControls {
    const { canvas, keyTarget } = host;
    const document = canvas.ownerDocument;
    const timers = document.defaultView ?? globalThis;
    const clock: GestureClock = {
        setTimeout: (handler, ms) => timers.setTimeout(handler, ms),
        clearTimeout: (timer) => timers.clearTimeout(timer as number)
    };
    const rig = new PerspectiveCamera(DEFAULT_FOV, 1, 0.05, 2000);
    rig.position.set(...DEFAULT_CAMERA_POSITION);
    const flat = new OrthographicCamera(-1, 1, 1, -1, 0.05, 2000);
    let mode: ControlsMode = 'none';
    let orbit: OrbitControls | undefined;
    let gestures: CameraGestures | undefined;
    /** The tree's view when the controls took the camera, with its distance; undefined while the tree's camera draws */
    let held: (CameraView & { readonly distance: number }) | undefined;
    /** Where the gesture under way started, and whether the controls held the camera before it */
    let snapshot: { position: Vector3; target: Vector3; held: boolean } | undefined;
    /** True from a `wheel` event on the canvas until the end of its task: the `start` of the controls it causes is the wheel's */
    let wheeling = false;
    /** True when the controls set the key target's `tabindex` */
    let ownTabIndex = false;
    let cameraKey: string | undefined;

    const target = (): Vector3 => orbit?.target ?? new Vector3();

    const place = (position: Vector3, at: Vector3): void => {
        rig.position.copy(position);
        target().copy(at);
        rig.up.set(0, 1, 0);
        rig.lookAt(at);
        rig.updateMatrixWorld(true);
    };

    const gestureHooks = {
        begin(): void {
            const before = held !== undefined;
            if (held === undefined) {
                const view = host.view();
                held = { ...view, distance: Math.max(view.position.distanceTo(view.target), 1e-6) };
                rig.fov = view.fov;
                place(view.position, view.target);
            }
            snapshot = { position: rig.position.clone(), target: target().clone(), held: before };
        },
        change(): void {
            rig.updateMatrixWorld(true);
            host.draw();
        },
        commit(): void {
            const start = snapshot;
            snapshot = undefined;
            if (start !== undefined && start.position.equals(rig.position) && start.target.equals(target())) return;
            const view = host.view();
            if (view.path === undefined || host.onCamera === undefined) return;
            const local = (point: Vector3): Vector3Tuple => {
                const value = view.parent ? view.parent.worldToLocal(point.clone()) : point.clone();
                return [clean(value.x), clean(value.y), clean(value.z)];
            };
            host.onCamera({ path: view.path, position: local(rig.position), target: local(target()) });
        },
        restore(): void {
            const start = snapshot;
            if (start === undefined) return;
            place(start.position, start.target);
            if (!start.held) held = undefined;
            // The pointer is still down: the controls ignore it until its release (their `end` turns them on again)
            if (orbit !== undefined) orbit.enabled = false;
            host.draw();
        },
        release(): void {
            snapshot = undefined;
            if (held === undefined) return;
            held = undefined;
            host.draw();
        }
    };

    const onWheel = (): void => {
        wheeling = true;
        queueMicrotask(() => {
            wheeling = false;
        });
    };

    const onEnd = (): void => {
        if (orbit !== undefined) orbit.enabled = true;
    };

    const onKeyDown = (event: Event): void => {
        const key = event as KeyboardEvent;
        if (key.altKey || key.ctrlKey || key.metaKey || orbit === undefined || gestures === undefined) return;
        const action = keyAction(key.key, mode);
        if (action === undefined) return;
        key.preventDefault();
        if (!gestures.keyDown(key.code || key.key)) return;
        if ('rotate' in action) {
            orbit.rotateLeft(action.rotate[0]);
            orbit.rotateUp(action.rotate[1]);
        } else if ('pan' in action) {
            const height = canvas.clientHeight || 1;
            orbit.pan(action.pan[0] * height, action.pan[1] * height);
        } else {
            // `dollyIn` multiplies the distance to the target by its argument
            orbit.dollyIn(action.zoom);
        }
    };

    const onKeyUp = (event: Event): void => {
        const key = event as KeyboardEvent;
        gestures?.keyUp(key.code || key.key);
    };

    const onFocusOut = (): void => gestures?.finish();

    /** Escape anywhere during a pointer gesture (the focus need not be on the scene) */
    const onEscape = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape' || gestures?.cancel() !== true) return;
        event.preventDefault();
        event.stopPropagation();
    };

    const stop = (): void => {
        gestures?.dispose();
        gestures = undefined;
        if (orbit !== undefined) {
            orbit.removeEventListener('end', onEnd);
            orbit.dispose();
            orbit = undefined;
        }
        canvas.removeEventListener('wheel', onWheel);
        keyTarget.removeEventListener('keydown', onKeyDown);
        keyTarget.removeEventListener('keyup', onKeyUp);
        keyTarget.removeEventListener('focusout', onFocusOut);
        document.removeEventListener('keydown', onEscape, true);
        snapshot = undefined;
        if (held !== undefined) {
            held = undefined;
            host.draw();
        }
    };

    const start = (next: Exclude<ControlsMode, 'none'>): void => {
        // Before the controls' own listener, so `wheeling` is set when their `start` comes
        canvas.addEventListener('wheel', onWheel);
        const controls = new OrbitControls(rig, canvas);
        controls.target.set(0, 0, 0);
        controls.enableDamping = false;
        controls.enableRotate = next === 'orbit';
        controls.enableZoom = next === 'orbit';
        controls.enablePan = next === 'pan';
        if (next === 'pan') {
            controls.mouseButtons = { LEFT: MOUSE.PAN, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.PAN };
            controls.touches = { ONE: TOUCH.PAN, TWO: TOUCH.PAN };
        }
        controls.addEventListener('end', onEnd);
        orbit = controls;
        gestures = new CameraGestures(controls, gestureHooks, clock, () => (wheeling ? 'wheel' : 'pointer'));
        keyTarget.addEventListener('keydown', onKeyDown);
        keyTarget.addEventListener('keyup', onKeyUp);
        keyTarget.addEventListener('focusout', onFocusOut);
        document.addEventListener('keydown', onEscape, true);
    };

    return {
        get mode() {
            return mode;
        },
        setMode(next) {
            if (next === mode) return;
            stop();
            mode = next;
            if (next === 'none') {
                if (ownTabIndex) keyTarget.removeAttribute('tabindex');
                ownTabIndex = false;
                return;
            }
            if (!keyTarget.hasAttribute('tabindex')) {
                keyTarget.setAttribute('tabindex', '0');
                ownTabIndex = true;
            }
            start(next);
        },
        treeChanged(camera) {
            const key = camera === undefined ? '' : JSON.stringify([camera.path, camera.properties]);
            const changed = cameraKey !== undefined && key !== cameraKey;
            cameraKey = key;
            if (!changed) return;
            if (gestures !== undefined) gestures.stateChange();
            else gestureHooks.release();
        },
        camera(aspect) {
            if (held === undefined) return undefined;
            const at = target();
            const distance = rig.position.distanceTo(at);
            // The planes follow the distance, so zooming out or in keeps what the tree's camera showed in view
            const near = Math.min(held.near, (held.near * distance) / held.distance);
            const far = held.far + Math.max(0, distance - held.distance);
            if (held.orthographic) {
                const height = orthographicHeight(distance, held.fov);
                const width = height * aspect;
                flat.position.copy(rig.position);
                flat.up.set(0, 1, 0);
                flat.lookAt(at);
                flat.left = -width / 2;
                flat.right = width / 2;
                flat.top = height / 2;
                flat.bottom = -height / 2;
                flat.near = near;
                flat.far = far;
                flat.updateProjectionMatrix();
                flat.updateMatrixWorld(true);
                return flat;
            }
            rig.aspect = aspect;
            rig.near = near;
            rig.far = far;
            rig.updateProjectionMatrix();
            rig.updateMatrixWorld(true);
            return rig;
        },
        dispose() {
            stop();
            if (ownTabIndex) keyTarget.removeAttribute('tabindex');
            ownTabIndex = false;
            mode = 'none';
        }
    };
}
