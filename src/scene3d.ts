import { Box3, OrthographicCamera, PerspectiveCamera, Raycaster, Vector2, Vector3 } from 'three';
import type { Camera, Object3D } from 'three';
import { DEFAULT_FOV, activeCamera, frameBounds, orthographicHeight } from './cameras.js';
import { createColorConverter } from './materials.js';
import { createRenderer } from './renderer.js';
import { SceneGraph, cameraTarget } from './scene.js';
import type { Bounds3d, ColorResolver, JsonValue, Scene3dSettings, Scene3dTree, Vector3Tuple } from './tree.js';

/** What a scene is made with */
export interface Scene3dOptions {
    /** True while motion is reduced (the theme's `motion.duration.base` resolves to a duration of zero); default false */
    readonly reducedMotion?: boolean;
    /**
     * Resolves a colour value (a literal or a token reference) to a CSS colour; the `scene3d` component passes the
     * component library's paint resolver reading the host's computed style (`--ui-…`). Without it a literal is used as it
     * is and a token resolves to nothing (the default colour of what it colours)
     */
    readonly resolveColor?: ColorResolver;
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
     * the ray, or its nearest `interactive` ancestor; undefined when none is
     */
    hit(x: number, y: number): Scene3dTree | undefined;
    /** The bounds in scene units of the node with this state path, or undefined when it draws nothing */
    boundsOf(path: string): Bounds3d | undefined;
    /** The element that stands for a node (by its path), the proxy button of an interactive node; undefined when there is none */
    elementOf(path: string): Element | undefined;
    /** Turns reduced motion on or off */
    setReducedMotion(reduced: boolean): void;
    /** True while motion is reduced */
    readonly reducedMotion: boolean;
    /**
     * Resolves once the last `update` is on screen: after the frame it asked for, at once when none is waiting. A feeder
     * marks itself ready then (the scene host's `data-render`). Resolves at once after `dispose`
     */
    drawn(): Promise<void>;
    /** Frees the geometries, materials and the renderer, removes the canvas and stops listening */
    dispose(): void;
}

/** A colour resolver that takes a literal as it is and resolves no token */
const literalColors: ColorResolver = (value: JsonValue) => (typeof value === 'string' && value.trim() !== '' && !value.trim().startsWith('{') ? value : undefined);

/** True when the object and every ancestor up to the root are visible */
function shown(object: Object3D | null, root: Object3D): boolean {
    for (let current = object; current && current !== root; current = current.parent) {
        if (!current.visible) return false;
    }
    return true;
}

/**
 * Makes a scene in `host`: a canvas that follows the host's size (`ResizeObserver`), a `WebGLRenderer` (`renderer.ts`)
 * and a three.js scene built from the node trees given to `update` (`scene.ts`: `camera`, `light`, `mesh`, `group3d`;
 * a `model` is an empty group until G3.7b). It draws through the active camera (`activeCamera`: the first `camera` with
 * `active: true`, else the first one), or, with none, a default perspective camera that frames the bounds of what is
 * drawn (`frameBounds`).
 *
 * It draws on demand: an update, a resize or a restored WebGL context asks for one animation frame, and nothing is
 * scheduled at rest. Throws a `Scene3dError` (`no_webgl`) when the browser gives no WebGL context; the caller shows its
 * fallback then
 */
export function createScene3d(host: Element, options: Scene3dOptions = {}): Scene3d {
    const view = host.ownerDocument.defaultView;
    const renderer = createRenderer(host);
    const { canvas, webgl } = renderer;
    const resolve = options.resolveColor ?? literalColors;
    const graph = new SceneGraph(resolve, createColorConverter(host.ownerDocument));
    const defaultCamera = new PerspectiveCamera(DEFAULT_FOV, 1, 0.1, 1000);
    const raycaster = new Raycaster();
    let reducedMotion = options.reducedMotion ?? false;
    let disposed = false;
    let frame: number | undefined;
    let waiting: (() => void)[] = [];

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

    /** The camera to draw through, set to the canvas's aspect ratio */
    function currentCamera(): Camera {
        const node = activeCamera(graph.tree);
        const object = node === undefined ? undefined : graph.objectOf(node.path);
        graph.root.updateWorldMatrix(true, true);
        if (node !== undefined && object instanceof PerspectiveCamera) {
            object.aspect = aspect();
            aim(object, node);
            object.updateProjectionMatrix();
            return object;
        }
        if (node !== undefined && object instanceof OrthographicCamera) {
            const target = aim(object, node);
            const fov = typeof node.properties.fov === 'number' ? node.properties.fov : DEFAULT_FOV;
            const height = orthographicHeight(object.getWorldPosition(new Vector3()).distanceTo(target), fov);
            const width = height * aspect();
            object.left = -width / 2;
            object.right = width / 2;
            object.top = height / 2;
            object.bottom = -height / 2;
            object.updateProjectionMatrix();
            return object;
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
        return defaultCamera;
    }

    function paint(): void {
        frame = undefined;
        if (disposed) return;
        webgl.render(graph.scene, currentCamera());
        const done = waiting;
        waiting = [];
        for (const settle of done) settle();
    }

    /** Asks for one frame; more changes before it draw in the same frame */
    function invalidate(): void {
        if (disposed || frame !== undefined) return;
        if (view === null) {
            paint();
            return;
        }
        frame = view.requestAnimationFrame(paint);
    }

    function resize(width: number, height: number): void {
        if (!disposed && renderer.resize(width, height)) invalidate();
    }

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
    // three.js sets its state up again after a restore; the picture has to be drawn again (G3.1: the first page of a
    // new headless Chromium loses its contexts once)
    canvas.addEventListener('webglcontextrestored', invalidate);
    resize(host.clientWidth, host.clientHeight);

    return {
        update(tree, settings) {
            if (disposed) return;
            graph.sync(tree);
            if (settings !== undefined) graph.applySettings(settings);
            invalidate();
        },
        hit(x, y) {
            if (disposed) return undefined;
            const { width, height } = renderer.size;
            raycaster.setFromCamera(new Vector2((x / width) * 2 - 1, -(y / height) * 2 + 1), currentCamera());
            for (const intersection of raycaster.intersectObject(graph.root, true)) {
                if (!shown(intersection.object, graph.root)) continue;
                for (let object: Object3D | null = intersection.object; object && object !== graph.root; object = object.parent) {
                    const tree = object.userData.tree as Scene3dTree | undefined;
                    if (tree?.properties.interactive === true) return tree;
                }
            }
            return undefined;
        },
        boundsOf(path) {
            const object = disposed ? undefined : graph.objectOf(path);
            if (!object) return undefined;
            graph.root.updateWorldMatrix(true, true);
            const box = new Box3().setFromObject(object);
            if (box.isEmpty()) return undefined;
            return { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] };
        },
        elementOf() {
            // The proxy buttons of interactive nodes come with G3.8
            return undefined;
        },
        setReducedMotion(reduced) {
            if (!disposed) reducedMotion = reduced;
        },
        get reducedMotion() {
            return reducedMotion;
        },
        drawn() {
            if (disposed || frame === undefined) return Promise.resolve();
            return new Promise((settle) => waiting.push(settle));
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            if (frame !== undefined) view?.cancelAnimationFrame(frame);
            frame = undefined;
            const done = waiting;
            waiting = [];
            for (const settle of done) settle();
            observer?.disconnect();
            canvas.removeEventListener('webglcontextrestored', invalidate);
            graph.clear();
            renderer.dispose();
        }
    };
}
