import { Box3, OrthographicCamera, PerspectiveCamera, Raycaster, SRGBColorSpace, Vector2, Vector3 } from 'three';
import type { Camera, Object3D } from 'three';
import { DEFAULT_FOV, activeCamera, frameBounds, orthographicHeight } from './cameras.js';
import { controlsMode, createCameraControls } from './controls.js';
import type { CameraMove, CameraView } from './controls.js';
import { PressGesture, interactiveNodes, screenBox } from './interaction.js';
import { createProxies } from './proxies.js';
import { createColorConverter } from './materials.js';
import { createAnimations3d } from './animate.js';
import { ModelClips } from './clips.js';
import { createMotion3d } from './motion.js';
import type { Rgb } from './motion.js';
import { createRenderer } from './renderer.js';
import { createScheduler } from './scheduler.js';
import type { ReadToken } from './scheduler.js';
import { SceneGraph, cameraTarget } from './scene.js';
import type { InstanceLayout } from './instances.js';
import type { ReadSceneFile, Scene3dIssue } from './scene.js';
import type { LabelHooks } from './labels.js';
import type { Bounds3d, ColorResolver, JsonValue, Scene3dSettings, Scene3dTree, Vector3Tuple } from './tree.js';

/** What a scene is made with */
export interface Scene3dOptions {
    /**
     * True while motion is reduced (the theme's `motion.duration.base` resolves to a duration of zero); default false.
     * A `transition` then jumps (G3.9), and `animate` and a model's clip do not play (G3.9b)
     */
    readonly reducedMotion?: boolean;
    /**
     * Reads a custom property for the motion tokens a node's `transition` names (G3.9): `duration` `fast`, `base` or
     * `slow` as `--ui-motion-duration-<name>` (in `ms` or `s`) and `easing` `standard`, `enter` or `exit` as
     * `--ui-motion-easing-<name>` (a `cubic-bezier(...)`), read when a tween starts; an unset or unreadable one takes
     * the shipped value (100, 200 and 400 ms; the shipped curves). Default: the host's computed style, so the theme of
     * the page the scene is in applies
     */
    readonly readToken?: ReadToken;
    /**
     * Resolves a colour value (a literal or a token reference) to a CSS colour; the `scene3d` component passes the
     * component library's paint resolver reading the host's computed style (`--ui-…`). Without it a literal is used as it
     * is and a token resolves to nothing (the default colour of what it colours)
     */
    readonly resolveColor?: ColorResolver;
    /**
     * Told when the scene's picture changes without an `update` from the feeder, so a feeder that marks its readiness
     * (the `scene3d` component's `data-render`) marks it pending and waits for `drawn()` again: `pending` when the scene
     * asked for a frame by itself (a resize of the host, a restored WebGL context), `lost` when the WebGL context was lost
     * (the scene draws nothing until it is restored, and `drawn()` waits for the frame after the restore), `failed`
     * when it was not restored within `CONTEXT_RESTORE_TIMEOUT` (the feeder shows its fallback; a restore after that
     * still draws, with `pending`)
     */
    readonly onStatus?: (status: Scene3dStatus) => void;
    /**
     * Told the active camera node's new `position` and `target` (in its parent's space) once when an orbit or pan
     * gesture that moved it ends (G3.8b): the feeder writes them, so a reload keeps the view. Never told during a gesture
     */
    readonly onCamera?: (move: CameraMove) => void;
    /**
     * The element that is focusable while the scene has `controls` and whose arrow, `+` and `-` keys move the camera
     * (G3.8b); default the host. The `scene3d` component passes its labelled scene box
     */
    readonly keyTarget?: Element;
    /**
     * Reads the bytes of a stored file by its id, for a `model`'s `src` (G3.7b) and a `mesh`'s `material.map` (G3.7c): the
     * `scene3d` component reads them through the host (`ui-file-read`). Without it a model or map with a file is told
     * to `onIssue` as `file` `offline`
     */
    readonly readFile?: ReadSceneFile;
    /** Told when a node cannot draw (`Scene3dIssue`: a model's file or its bytes, a map's file); the other nodes draw */
    readonly onIssue?: (issue: Scene3dIssue) => void;
    /**
     * Told a `press` or a `hover` of an interactive node (G3.8, `Scene3dEvent`): the `scene3d` component raises it on
     * its element for the dispatcher, which runs the `on` entry of the node `shape` names
     */
    readonly onEvent?: (event: Scene3dEvent) => void;
    /**
     * Reads the font family a `label3d` draws its text in (G3.6b), when the labels are drawn and again on `restyle`.
     * Default: the host's computed `font-family`, so the page font applies; unset or empty is `sans-serif`
     */
    readonly readFont?: () => string | undefined;
}

/**
 * A `press` or a `hover` (entering only) of an interactive node (G3.8): `shape` is the node's state path
 * (`<repeat>.rows.<recordKey>` for a `repeat3d` copy), `key` its key (a copy's record key), `point` the point of the
 * node in world space: where the ray hit it, or the centre of its bounds for a press through its proxy
 */
export interface Scene3dEvent {
    readonly name: 'press' | 'hover';
    readonly shape: string;
    readonly key: string;
    readonly point: Vector3Tuple;
}

/** What `onStatus` of the scene's options is told (see there) */
export type Scene3dStatus = 'pending' | 'lost' | 'failed';

/** How long, in milliseconds, a scene waits for a lost WebGL context to be restored before it tells `failed` */
export const CONTEXT_RESTORE_TIMEOUT = 5000;

/** What a scene holds on the GPU and how it draws, for tests and diagnostics */
export interface Scene3dInfo {
    /** The geometries and textures the renderer holds (three.js's `renderer.info.memory`) */
    readonly memory: { readonly geometries: number; readonly textures: number };
    /** The shader programs the renderer holds */
    readonly programs: number;
    /** True once a light with `shadows` has turned the renderer's shadow map on (it stays on) */
    readonly shadowMap: boolean;
    /** True while the WebGL context is lost */
    readonly contextLost: boolean;
    /** The environment preset drawn (`none`, `studio`, `daylight`, `neutral`) */
    readonly environment: string | undefined;
    /** The `model` nodes whose file is being read or parsed, and those drawn */
    readonly models: { readonly loading: number; readonly loaded: number };
    /** The `material.map`s whose file is being read or decoded, and those drawn (G3.7c) */
    readonly maps: { readonly loading: number; readonly loaded: number };
    /** The tweens of `transition` running (G3.9) */
    readonly tweens: number;
    /** The nodes whose `animate` plays now (G3.9b) */
    readonly animations: number;
    /** The clips of `model` nodes playing now (G3.9b) */
    readonly clips: number;
    /** The instances the `repeat3d` nodes draw (G3.6) */
    readonly instances: number;
    /** The `label3d` nodes that draw a text (G3.6b) */
    readonly labels: number;
}

/**
 * A 3D scene drawn with three.js into a canvas in its host. It never writes to the store: the feeder (the `scene3d`
 * component, a test, another host) hands it a new tree with `update`. After `dispose` every call is a no-op. The names
 * follow `DrawingRenderer` of the component library's 2D renderers.
 */
export interface Scene3d {
    /**
     * Draws the tree, and the scene's own properties when given (else the last ones given): only what changed since the
     * last tree is touched, and one frame is asked for however many updates come before it
     */
    update(tree: readonly Scene3dTree[], settings?: Scene3dSettings): void;
    /**
     * The interactive node drawn at a point of the host, in CSS pixels from its top-left corner: the first node hit by
     * the ray, or its nearest `interactive` ancestor; undefined when none is. An instance of a `repeat3d` gives the copy
     * its instance index draws (G3.6: `key` the record key, `path` `<repeat>.rows.<recordKey>`) when the copy is
     * interactive, else the repeat or its nearest interactive ancestor
     */
    hit(x: number, y: number): Scene3dTree | undefined;
    /**
     * The bounds in scene units of the node with this state path, or undefined when it draws nothing; a repeat copy's
     * path (`<repeat>.rows.<recordKey>`) gives the bounds of its instance (G3.6)
     */
    boundsOf(path: string): Bounds3d | undefined;
    /**
     * The element that stands for a node (by its path): the proxy button of an interactive node that is drawn (G3.8);
     * undefined when there is none
     */
    elementOf(path: string): Element | undefined;
    /**
     * Resolves every colour again (the scene's own, the environment's ambient and fog, and the nodes'), without making
     * any object again, and draws: a feeder calls it when the theme or mode changes, since the same tokens then resolve
     * to other colours. The colours are read when the frame is drawn
     */
    restyle(): void;
    /** What the scene holds on the GPU and how it draws (`Scene3dInfo`) */
    info(): Scene3dInfo;
    /** Turns reduced motion on or off */
    setReducedMotion(reduced: boolean): void;
    /** True while motion is reduced */
    readonly reducedMotion: boolean;
    /**
     * Resolves once the last `update` is on screen: after the frame it asked for, at once when none is waiting. While
     * the WebGL context is lost it waits for the frame after the restore, and while a `model`'s file is read or parsed
     * it waits for the frame after the last one has loaded or failed (G3.7b), and so for a `material.map`'s file (G3.7c).
     * A feeder marks itself ready then (the
     * scene host's `data-render`). Resolves at once after `dispose`
     */
    drawn(): Promise<void>;
    /**
     * Frees the geometries, materials, textures, the environment's lights and the renderer (forcing the loss of its
     * WebGL context), removes the canvas and stops listening
     */
    dispose(): void;
}

/** A colour resolver that takes a literal as it is and resolves no token */
const literalColors: ColorResolver = (value: JsonValue) => (typeof value === 'string' && value.trim() !== '' && !value.trim().startsWith('{') ? value : undefined);

/**
 * The copy of a `repeat3d` that the instance a ray hit draws (G3.6): the instanced mesh knows its `InstanceLayout`, and
 * the copy's `key` is the record key of the index. Undefined for anything that is not an instance
 */
function instanceCopy(object: Object3D, instanceId: number | undefined): Scene3dTree | undefined {
    const layout = object.userData.layout as InstanceLayout | undefined;
    return instanceId === undefined || layout === undefined ? undefined : layout.treeAt(instanceId);
}

/**
 * How a scene's labels are drawn (G3.6b): canvases of the host's document, in the font `readFont` gives, else the
 * host's computed `font-family` (the page font, as the theme sets it)
 */
function labelHooks(host: Element, options: Scene3dOptions): LabelHooks {
    const doc = host.ownerDocument;
    const view = doc.defaultView;
    return { doc, readFont: options.readFont ?? (() => view?.getComputedStyle(host).fontFamily) };
}

/** A number without the noise of the matrix maths (the point of a press or a hover, G3.8) */
const clean = (value: number): number => Math.round(value * 1e6) / 1e6 + 0;

/** True when the object and every ancestor up to the root are visible */
function shown(object: Object3D | null, root: Object3D): boolean {
    for (let current = object; current && current !== root; current = current.parent) {
        if (!current.visible) return false;
    }
    return true;
}

/**
 * Makes a scene in `host`: a canvas that follows the host's size (`ResizeObserver`), a `WebGLRenderer` (`renderer.ts`)
 * and a three.js scene built from the node trees given to `update` (`scene.ts`: `camera`, `light`, `mesh`, `group3d`,
 * `model`, whose GLB file it reads with `readFile` and parses with no URL, `models.ts`, a `mesh`'s `material.map`,
 * whose picture file it reads the same way and decodes to an `ImageBitmap`, `textures.ts`, and `repeat3d`, whose copies
 * it draws as one instanced mesh, `instances.ts`). It draws through the active camera (`activeCamera`: the first `camera` with
 * `active: true`, else the first one), or, with none, a default perspective camera that frames the bounds of what is
 * drawn (`frameBounds`). Switching the active camera, the environment preset or the fog makes no node again.
 *
 * It draws on demand: an update, a `restyle`, a resize or a restored WebGL context asks for one animation frame, and
 * nothing is scheduled at rest. The first light with `shadows` turns the renderer's shadow map on, once. On a lost
 * WebGL context it stops drawing; on its restore it draws the tree it holds again; when the context is not back within
 * `CONTEXT_RESTORE_TIMEOUT` it tells `onStatus` `failed`. Throws a `Scene3dError` (`no_webgl`) when the browser gives
 * no WebGL context; the caller shows its fallback then.
 *
 * With `controls` `orbit` or `pan` in the settings (G3.8b, `controls.ts`), a pointer drag, the wheel and the keys of
 * `keyTarget` move the camera in the renderer on every frame of the gesture (each frame tells `onStatus` `pending`),
 * and the active camera node's `position` and `target` go to `onCamera` once when the gesture ends. With `none` (the
 * default) the scene takes no pointer, wheel or key input for the camera.
 *
 * Labels (G3.6b, `labels.ts`): a `label3d` draws its `_text` with `fillText` on a canvas, in the page font (`readFont`)
 * and its `color` or the settings' `labelColor`, as a sprite that faces the camera, its font `fontSize` scene units. The
 * canvas is drawn again when the text, the font or the colour changes (`restyle` reads both again, and a web font that
 * finishes loading draws every label again), and freed with the node.
 *
 * Press and hover (G3.8, `interaction.ts` and `proxies.ts`): a primary pointer that goes down and up on the canvas
 * within `PRESS_SLOP` pixels, while the controls did not move the camera, is a `press` of the interactive node `hit`
 * finds under the release (a drag to rotate is never a press); nothing on empty space or on a node that is not
 * interactive. The pointer entering an interactive node, with no button down, is a `hover`, once per entry. Both go to
 * `onEvent` with the point the ray hit. Each interactive node that is drawn gets a proxy button (`createProxies`, in a
 * `proxies` layer before the canvas, in tree order), placed over the box its bounds cover on the canvas after every
 * frame that draws (so it follows the node, a tween and the camera); `elementOf` gives it. A click on a proxy, or Enter
 * or Space on a focused one, is a `press` at the centre of the node's bounds. The canvas shows the `move` cursor while
 * the scene has controls (a drag moves the view, wherever it starts), else `pointer` over an interactive node.
 *
 * A node with `transition` (G3.9, `motion.ts`) eases to the values a state change gives its `position`, `rotation`,
 * `scale`, a mesh's `material.color` and `material.opacity`, a light's `intensity` and a camera's `target`, on the
 * scene's scheduler (`scheduler.ts`): a frame per animation frame while a tween runs, none at rest, and `drawn()`
 * waits until the last tween has ended. A new value mid-tween starts from where the node is. Reduced motion
 * (`reducedMotion`, `setReducedMotion`) jumps every change and ends the running tweens. A gesture of the controls ends
 * the camera's tween at once; the camera written during a gesture jumps, and the camera a gesture wrote is not tweened
 *
 * `animate` and clips (G3.9b, `animate.ts` and `clips.ts`): a node with `animate` plays `spin` (a turn about its y
 * axis), `bob` (up `BOB_HEIGHT` and back) or `pulse` (`PULSE_GROWTH` larger and back) over its own values, drawn over
 * any tween, in the scheduler's frames; a camera's and a `repeat3d` copy's `animate` do not play (the repeat's own moves
 * every instance). A `model` plays the clip of its GLB that `animation` names (the file's first when unset) with an
 * `AnimationMixer` while `playing` is true, looping; `playing: false` pauses it where it is, and a name the file does
 * not have is told to `onIssue` (`model`, `unknown_clip`, naming the file's clips). The mixers move on only in a
 * frame of the scheduler while a clip plays. Neither writes anything, neither makes `drawn()` wait (it resolves after
 * the next frame), and a scene with no `animate` and no playing clip asks for no frame. Reduced motion rests every
 * `animate` and shows each clip's first frame, still; turning it off plays both from their beginning
 */
export function createScene3d(host: Element, options: Scene3dOptions = {}): Scene3d {
    const view = host.ownerDocument.defaultView;
    const renderer = createRenderer(host);
    const { canvas, webgl } = renderer;
    const resolve = options.resolveColor ?? literalColors;
    // G3.9b: the clips of the models, played on the scheduler's frames while one plays
    const clips = new ModelClips({ onIssue: options.onIssue });
    // A model that settles draws again; `drawn()` waits until no model is loading
    const graph = new SceneGraph(resolve, createColorConverter(host.ownerDocument), {
        readFile: options.readFile,
        onIssue: options.onIssue,
        onSettled: () => invalidate(),
        // G3.9b: a model drawn or freed; a clip it plays asks for frames
        onModel: (path, model) => {
            clips.attach(path, model);
            playClips();
        }
    }, labelHooks(host, options));
    const defaultCamera = new PerspectiveCamera(DEFAULT_FOV, 1, 0.1, 1000);
    const raycaster = new Raycaster();
    // Press and hover (G3.8): the proxy buttons of the interactive nodes, a pointer's press, the node the pointer is in
    const proxies = createProxies(host, { press: (path) => pressProxy(path) });
    const press = new PressGesture();
    /** The interactive nodes that are drawn, by path: each has a proxy */
    let interactive = new Map<string, Scene3dTree>();
    /** The path of the interactive node the pointer is in, so `hover` is told once per entry */
    let hovered: string | undefined;
    let reducedMotion = options.reducedMotion ?? false;
    let disposed = false;
    let frame: number | undefined;
    let waiting: (() => void)[] = [];
    /** True while the WebGL context is lost: nothing is drawn and `drawn()` waits */
    let lost = false;
    /** The timer of `CONTEXT_RESTORE_TIMEOUT` while the context is lost */
    let restoreTimer: ReturnType<typeof setTimeout> | undefined;
    /** True when the colours are to be resolved again before the next frame (`restyle`) */
    let restyled = false;
    // The defaults of the scene's own properties (the `studio` environment) until the feeder gives its own
    graph.applySettings({});

    // Transitions (G3.9): one scheduler per scene, idle when nothing moves; its frames draw the tree with the tweens
    // where they are. Without a window there are no frames, so every change jumps
    const motionColors = createColorConverter(host.ownerDocument);
    const rgbOf = (value: JsonValue): Rgb | undefined => {
        const css = resolve(value);
        const colour = css === undefined ? undefined : motionColors(css);
        if (colour === undefined) return undefined;
        const { r, g, b } = colour.getRGB({ r: 0, g: 0, b: 0 }, SRGBColorSpace);
        return [r * 255, g * 255, b * 255];
    };
    const readToken: ReadToken = options.readToken ?? ((name) => view?.getComputedStyle(host).getPropertyValue(name).trim() || undefined);
    const scheduler = createScheduler({
        requestFrame: view === null ? undefined : (callback) => view.requestAnimationFrame(callback),
        cancelFrame: (handle) => view?.cancelAnimationFrame(handle),
        onFrame: () => drawMotion()
    });
    scheduler.setReduced(reducedMotion || view === null);
    const motion = createMotion3d({ scheduler, read: readToken, colorOf: rgbOf });
    // G3.9b: `animate` on the same scheduler, drawn over the tweens of `transition`
    const animations = createAnimations3d(scheduler);
    clips.setReduced(reducedMotion || view === null);
    /** The frame task that moves the clips on while one plays, and the scheduler time of its last frame */
    let clipTask: (() => void) | undefined;
    let clipTime: number | undefined;

    /** Moves the playing clips on in each frame of the scheduler, asking for frames only while one plays (G3.9b) */
    function playClips(): void {
        if (disposed || clipTask !== undefined || clips.playing === 0) return;
        clipTime = undefined;
        clipTask = scheduler.request((now) => {
            const seconds = clipTime === undefined ? 0 : Math.max(0, now - clipTime) / 1000;
            clipTime = now;
            if (clips.advance(seconds)) return true;
            clipTask = undefined;
            return false;
        });
    }
    /** The active camera the state last gave (its path and properties), to tell a change of it from a tween's */
    let stateCamera: string | undefined;

    /** A frame of the scheduler: the tree with the tweens where they are now, drawn in this frame */
    function drawMotion(): void {
        if (disposed) return;
        graph.sync(animations.decorate(motion.current()));
        if (lost) return;
        if (frame !== undefined) view?.cancelAnimationFrame(frame);
        paint();
    }

    /**
     * Before a tree is drawn (G3.9): when the state's camera changed while the controls hold the camera after a gesture,
     * its tween starts from the view the controls show, not from the camera before the gesture
     */
    function cameraFromView(tree: readonly Scene3dTree[]): void {
        const camera = activeCamera(tree);
        const key = camera === undefined ? '' : JSON.stringify([camera.path, camera.properties]);
        if (key === stateCamera) return;
        stateCamera = key;
        const hold = controls.holding();
        if (hold !== undefined && hold.path === camera?.path) motion.settle(hold.path, { position: [...hold.position], target: [...hold.target] });
    }

    const aspect = (): number => renderer.size.width / renderer.size.height;

    /** Turns a camera node's object to its target, given in the space of the node's parent */
    function aim(object: Object3D, tree: Scene3dTree): Vector3 {
        object.updateWorldMatrix(true, false);
        const target = new Vector3(...cameraTarget(tree));
        if (object.parent) object.parent.localToWorld(target);
        object.lookAt(target);
        object.updateMatrixWorld(true);
        return target;
    }

    /** The camera to draw through, set to the canvas's aspect ratio: the controls' own while they hold the camera (G3.8b) */
    function currentCamera(): Camera {
        return controls.camera(aspect()) ?? treeCamera().camera;
    }

    /** How the tree's camera draws (the controls take it from here when a gesture starts) */
    function cameraView(): CameraView {
        const { camera, target, fov, node } = treeCamera();
        const object = node === undefined ? undefined : graph.objectOf(node.path);
        return {
            position: camera.getWorldPosition(new Vector3()),
            target,
            fov,
            near: camera.near,
            far: camera.far,
            orthographic: camera instanceof OrthographicCamera,
            path: node?.path,
            parent: object?.parent ?? null
        };
    }

    /** The tree's camera, set to the canvas's aspect ratio, with its target in world space and its field of view */
    function treeCamera(): { camera: PerspectiveCamera | OrthographicCamera; target: Vector3; fov: number; node?: Scene3dTree } {
        const node = activeCamera(graph.tree);
        const object = node === undefined ? undefined : graph.objectOf(node.path);
        graph.root.updateWorldMatrix(true, true);
        const fov = typeof node?.properties.fov === 'number' ? node.properties.fov : DEFAULT_FOV;
        if (node !== undefined && object instanceof PerspectiveCamera) {
            object.aspect = aspect();
            const target = aim(object, node);
            object.updateProjectionMatrix();
            return { camera: object, target, fov, node };
        }
        if (node !== undefined && object instanceof OrthographicCamera) {
            const target = aim(object, node);
            const height = orthographicHeight(object.getWorldPosition(new Vector3()).distanceTo(target), fov);
            const width = height * aspect();
            object.left = -width / 2;
            object.right = width / 2;
            object.top = height / 2;
            object.bottom = -height / 2;
            object.updateProjectionMatrix();
            return { camera: object, target, fov, node };
        }
        const box = new Box3().setFromObject(graph.root);
        const bounds = box.isEmpty() ? undefined : { min: box.min.toArray() as Vector3Tuple, max: box.max.toArray() as Vector3Tuple };
        const view = frameBounds(bounds, DEFAULT_FOV, aspect());
        defaultCamera.aspect = aspect();
        defaultCamera.near = view.near;
        defaultCamera.far = view.far;
        defaultCamera.position.set(...view.position);
        defaultCamera.lookAt(...view.target);
        defaultCamera.updateProjectionMatrix();
        defaultCamera.updateMatrixWorld(true);
        return { camera: defaultCamera, target: new Vector3(...view.target), fov: DEFAULT_FOV };
    }

    function paint(): void {
        frame = undefined;
        if (disposed || lost) return;
        if (restyled) {
            restyled = false;
            graph.restyle();
        }
        // The shadow map is turned on once, by the first light with shadows; the programs compiled without it are
        // compiled again
        if (!webgl.shadowMap.enabled && graph.wantsShadows) {
            webgl.shadowMap.enabled = true;
            graph.recompile();
        }
        const camera = currentCamera();
        webgl.render(graph.scene, camera);
        // G3.8: the proxies follow the nodes and the camera of this frame
        placeProxies(camera);
        // The models and maps (G3.7c) being loaded are not on screen yet: waiting goes on until the frame after the last
        // one settles, and while a transition runs until the frame it ends in (G3.9)
        if (graph.loading > 0 || motion.running > 0) return;
        const done = waiting;
        waiting = [];
        for (const settle of done) settle();
    }

    /** Asks for one frame; more changes before it draw in the same frame. None while the context is lost */
    function invalidate(): void {
        if (disposed || lost || frame !== undefined) return;
        if (view === null) {
            paint();
            return;
        }
        frame = view.requestAnimationFrame(paint);
    }

    /** Asks for a frame the feeder did not ask for, and tells it so (`pending`) */
    function invalidateByItself(): void {
        if (disposed || lost) return;
        invalidate();
        options.onStatus?.('pending');
    }

    function resize(width: number, height: number, byItself = true): void {
        if (disposed || !renderer.resize(width, height)) return;
        if (byItself) invalidateByItself();
        else invalidate();
    }

    /** The context is lost: three.js draws nothing until it is back (it keeps the context restorable), and nor do we */
    function onContextLost(): void {
        if (disposed || lost) return;
        lost = true;
        if (frame !== undefined) view?.cancelAnimationFrame(frame);
        frame = undefined;
        options.onStatus?.('lost');
        const timers = view ?? globalThis;
        restoreTimer = timers.setTimeout(() => {
            restoreTimer = undefined;
            if (!disposed && lost) options.onStatus?.('failed');
        }, CONTEXT_RESTORE_TIMEOUT);
    }

    /**
     * The context is back: three.js has set its state up again (its listener ran first) and uploads the geometries and
     * programs again as they are drawn, so the tree the scene holds is drawn again (G3.1: the first page of a new
     * headless Chromium loses its contexts once)
     */
    function onContextRestored(): void {
        if (disposed || !lost) return;
        lost = false;
        if (restoreTimer !== undefined) (view ?? globalThis).clearTimeout(restoreTimer);
        restoreTimer = undefined;
        invalidateByItself();
    }

    // Press and hover (G3.8) ---------------------------------------------------------------------------------------

    /**
     * The world bounds of the node with this path (a repeat copy's: its instance's), or undefined when it draws nothing.
     * `update` false when the world matrices are up to date (the proxies are placed after a frame)
     */
    function worldBox(path: string, update = true): Box3 | undefined {
        if (disposed) return undefined;
        const object = graph.objectOf(path);
        if (!object) {
            // A repeat copy's path (`<repeat>.rows.<recordKey>`, G3.6): the bounds of its instance
            const instance = graph.instanceBounds(path);
            return instance === undefined || instance.isEmpty() ? undefined : instance;
        }
        if (update) graph.root.updateWorldMatrix(true, true);
        const box = new Box3().setFromObject(object);
        return box.isEmpty() ? undefined : box;
    }

    /**
     * The interactive node drawn at a point of the host in CSS pixels, with the point in world space where the ray met
     * it: the first node hit, or its nearest interactive ancestor; a `repeat3d` instance gives its copy when that is
     * interactive (G3.6)
     */
    function pick(x: number, y: number): { readonly tree: Scene3dTree; readonly point: Vector3 } | undefined {
        if (disposed) return undefined;
        const { width, height } = renderer.size;
        if (width <= 0 || height <= 0) return undefined;
        raycaster.setFromCamera(new Vector2((x / width) * 2 - 1, -(y / height) * 2 + 1), currentCamera());
        for (const intersection of raycaster.intersectObject(graph.root, true)) {
            if (!shown(intersection.object, graph.root)) continue;
            // An instance of a repeat3d (G3.6): the copy its index draws, whose key is its record key
            const copy = instanceCopy(intersection.object, intersection.instanceId);
            if (copy?.properties.interactive === true) return { tree: copy, point: intersection.point };
            for (let object: Object3D | null = intersection.object; object && object !== graph.root; object = object.parent) {
                const tree = object.userData.tree as Scene3dTree | undefined;
                if (tree?.properties.interactive === true) return { tree, point: intersection.point };
            }
        }
        return undefined;
    }

    /** Tells `onEvent` a press or a hover of a node, at a point in world space */
    function raise(name: Scene3dEvent['name'], tree: Scene3dTree, point: Vector3): void {
        if (disposed || options.onEvent === undefined) return;
        options.onEvent({ name, shape: tree.path, key: tree.key, point: [clean(point.x), clean(point.y), clean(point.z)] });
    }

    /** A click on a proxy, or Enter or Space on a focused one: a press at the centre of its node's bounds */
    function pressProxy(path: string): void {
        const tree = interactive.get(path);
        const box = tree === undefined ? undefined : worldBox(path);
        if (tree !== undefined && box !== undefined) raise('press', tree, box.getCenter(new Vector3()));
    }

    /** Puts each proxy over the box its node covers on the canvas through the camera of the frame just drawn */
    function placeProxies(camera: Camera): void {
        if (proxies.size === 0) return;
        const { width, height } = renderer.size;
        graph.root.updateWorldMatrix(true, true);
        proxies.place((path) => {
            const box = interactive.has(path) ? worldBox(path, false) : undefined;
            return box === undefined ? undefined : screenBox(box, camera, width, height);
        });
    }

    /** The interactive nodes of a new tree get their proxies, in tree order; a hovered node that went is forgotten */
    function syncInteractive(tree: readonly Scene3dTree[]): void {
        const nodes = interactiveNodes(tree);
        interactive = new Map(nodes.map((node) => [node.path, node]));
        proxies.sync(nodes);
        if (hovered !== undefined && !interactive.has(hovered)) hovered = undefined;
    }

    /** A pointer event's point in CSS pixels from the canvas's top-left corner */
    function pointAt(event: PointerEvent): [number, number] {
        const rect = canvas.getBoundingClientRect();
        return [event.clientX - rect.left, event.clientY - rect.top];
    }

    const onPointerDown = (event: PointerEvent): void => {
        if (disposed || event.button !== 0) return;
        const [x, y] = pointAt(event);
        press.down(event.pointerId, x, y);
    };

    /** The pointer moved: farther than the slop makes a press a drag; with no button down, `hover` on entering a node */
    const onPointerMove = (event: PointerEvent): void => {
        if (disposed) return;
        const [x, y] = pointAt(event);
        press.move(event.pointerId, x, y);
        // A drag is not a hover, and keeps its cursor
        if (event.buttons !== 0) return;
        const found = interactive.size > 0 ? pick(x, y) : undefined;
        const cursor = controls.mode !== 'none' ? 'move' : found !== undefined ? 'pointer' : '';
        if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
        const path = found?.tree.path;
        if (path === hovered) return;
        hovered = path;
        if (found !== undefined) raise('hover', found.tree, found.point);
    };

    /** The pointer went up: a press when it did not move and the camera did not move, of the node under it */
    const onPointerUp = (event: PointerEvent): void => {
        if (disposed) return;
        const [x, y] = pointAt(event);
        if (!press.up(event.pointerId, x, y)) return;
        const found = pick(x, y);
        if (found !== undefined) raise('press', found.tree, found.point);
    };

    const onPointerCancel = (): void => press.cancel();

    const onPointerLeave = (): void => {
        hovered = undefined;
        if (canvas.style.cursor !== '') canvas.style.cursor = '';
    };

    // Before the controls' own listeners (made with the first settings), so a press is known before their gesture starts
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('pointerleave', onPointerLeave);

    const observer =
        view && 'ResizeObserver' in view
            ? new view.ResizeObserver((entries) => {
                  const entry = entries[entries.length - 1];
                  const box = entry?.contentBoxSize?.[0];
                  if (box) resize(box.inlineSize, box.blockSize);
                  else if (entry) resize(entry.contentRect.width, entry.contentRect.height);
              })
            : undefined;
    observer?.observe(host);
    // G3.6b: a web font that finishes loading draws the labels again (the same family now has its own glyphs)
    const fonts = (host.ownerDocument as Document & { fonts?: FontFaceSet }).fonts;
    const onFontsLoaded = (): void => {
        if (disposed || graph.labels.size === 0) return;
        graph.labels.redraw();
        invalidateByItself();
    };
    fonts?.addEventListener('loadingdone', onFontsLoaded);
    canvas.addEventListener('webglcontextlost', onContextLost);
    canvas.addEventListener('webglcontextrestored', onContextRestored);
    // Orbit and pan (G3.8b): a gesture's frames are frames the feeder did not ask for, and it writes when it ends
    const controls = createCameraControls({
        canvas,
        keyTarget: options.keyTarget ?? host,
        view: cameraView,
        // G3.8: a pointer gesture that moved the camera is a drag to rotate or pan, never a press
        draw: () => {
            press.cameraMoved();
            invalidateByItself();
        },
        // G3.9: the camera a gesture writes comes back as state and is shown at once, never tweened back from where it was
        onCamera:
            options.onCamera === undefined
                ? undefined
                : (move) => {
                      motion.settle(move.path, { position: [...move.position], target: [...move.target] });
                      options.onCamera?.(move);
                  },
        // G3.9: a gesture ends the camera's transition at once and starts from where the camera goes
        onGestureStart: () => {
            if (motion.finish((node) => node.kind === 'camera')) graph.sync(animations.decorate(motion.current()));
        }
    });
    resize(host.clientWidth, host.clientHeight, false);

    return {
        update(tree, settings) {
            if (disposed) return;
            // G3.9: the changes of nodes with `transition` tween; the camera the controls hold during a gesture jumps
            cameraFromView(tree);
            // G3.9b: `animate` over the tweens, and the models' clips
            graph.sync(animations.follow(motion.apply(tree, (node) => node.kind === 'camera' && controls.gesturing)));
            clips.follow(tree);
            playClips();
            if (settings !== undefined) graph.applySettings(settings);
            if (settings !== undefined) controls.setMode(controlsMode(settings.controls));
            // The state's camera, not one a transition is moving
            controls.treeChanged(activeCamera(tree));
            // G3.8: the proxies of the interactive nodes (placed when the frame is drawn)
            syncInteractive(tree);
            invalidate();
        },
        hit(x, y) {
            return pick(x, y)?.tree;
        },
        boundsOf(path) {
            const box = worldBox(path);
            return box === undefined ? undefined : { min: box.min.toArray() as Vector3Tuple, max: box.max.toArray() as Vector3Tuple };
        },
        elementOf(path) {
            // G3.8: the proxy button of an interactive node that is drawn
            return disposed ? undefined : proxies.elementOf(path);
        },
        restyle() {
            if (disposed) return;
            restyled = true;
            invalidate();
        },
        info() {
            const { memory, programs } = webgl.info;
            return {
                memory: { geometries: memory.geometries, textures: memory.textures },
                programs: programs?.length ?? 0,
                shadowMap: webgl.shadowMap.enabled,
                contextLost: lost,
                environment: graph.environmentPreset,
                models: { loading: graph.loadingModels, loaded: graph.loadedModels },
                maps: { loading: graph.loadingMaps, loaded: graph.loadedMaps },
                tweens: motion.running,
                animations: animations.playing,
                clips: clips.playing,
                instances: graph.instances,
                labels: graph.labels.drawn
            };
        },
        setReducedMotion(reduced) {
            if (disposed) return;
            reducedMotion = reduced;
            // Turning it on ends every transition at its end value, drawn at once
            if (!scheduler.setReduced(reduced || view === null)) return;
            // G3.9b: `animate` rests and the clips show their first frame; turned off, both play from their beginning
            clips.setReduced(reduced || view === null);
            clipTime = undefined;
            if (!reduced) animations.restart();
            graph.sync(animations.decorate(motion.current()));
            playClips();
            invalidate();
        },
        get reducedMotion() {
            return reducedMotion;
        },
        drawn() {
            if (disposed || (frame === undefined && !lost && graph.loading === 0 && motion.running === 0)) return Promise.resolve();
            return new Promise((settle) => waiting.push(settle));
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            if (frame !== undefined) view?.cancelAnimationFrame(frame);
            frame = undefined;
            if (restoreTimer !== undefined) (view ?? globalThis).clearTimeout(restoreTimer);
            restoreTimer = undefined;
            const done = waiting;
            waiting = [];
            for (const settle of done) settle();
            observer?.disconnect();
            // G3.6b
            fonts?.removeEventListener('loadingdone', onFontsLoaded);
            // Before the renderer forces its context loss, which would otherwise be taken for one to wait out
            canvas.removeEventListener('webglcontextlost', onContextLost);
            canvas.removeEventListener('webglcontextrestored', onContextRestored);
            // G3.8: press and hover
            canvas.removeEventListener('pointerdown', onPointerDown);
            canvas.removeEventListener('pointermove', onPointerMove);
            canvas.removeEventListener('pointerup', onPointerUp);
            canvas.removeEventListener('pointercancel', onPointerCancel);
            canvas.removeEventListener('pointerleave', onPointerLeave);
            proxies.dispose();
            interactive = new Map();
            hovered = undefined;
            controls.dispose();
            scheduler.dispose();
            motion.dispose();
            // G3.9b
            animations.dispose();
            clips.dispose();
            graph.clear();
            renderer.dispose();
        }
    };
}
