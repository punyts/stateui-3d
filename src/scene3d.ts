import { Box3, BoxGeometry, Color, Group, MathUtils, Mesh, MeshBasicMaterial, PerspectiveCamera, Raycaster, Scene, Vector2, WebGLRenderer } from 'three';
import type { Object3D } from 'three';
import type { Bounds3d, JsonValue, Scene3dTree, Vector3Tuple } from './tree.js';

/** What a scene is made with; later stories add the scene's own properties, events and file reads */
export interface Scene3dOptions {
    /** True while motion is reduced (the theme's `motion.duration.base` resolves to a duration of zero); default false */
    readonly reducedMotion?: boolean;
}

/**
 * A 3D scene drawn with three.js into a canvas in its host. It never writes to the store: the feeder (the `scene3d`
 * component, a test, another host) hands it a new tree with `update`. After `dispose` every call is a no-op. The names
 * follow `DrawingRenderer` of the component library's 2D renderers.
 */
export interface Scene3d {
    /** Draws the tree */
    update(tree: readonly Scene3dTree[]): void;
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
     * Resolves once the last `update` is on screen, after the next frame. A feeder marks itself ready then (the scene
     * host's `data-render`). Resolves at once after `dispose`
     */
    drawn(): Promise<void>;
    /** Frees the geometries, materials and the renderer, removes the canvas and stops listening */
    dispose(): void;
}

/** The vertical field of view, in degrees, of the camera a scene with no `camera` node gets */
export const DEFAULT_FOV = 50;
/** Where the default camera stands; it looks at the origin */
export const DEFAULT_CAMERA_POSITION: Vector3Tuple = [0, 0, 5];
/** The size of the canvas while the host has none (the default size of a canvas element) */
const FALLBACK_SIZE = { width: 300, height: 150 };
const LITERAL_COLOR = /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i;

const isVector3 = (value: JsonValue | undefined): value is [number, number, number] =>
    Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number' && Number.isFinite(n));

const isObject = (value: JsonValue | undefined): value is { [key: string]: JsonValue } =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** Sets the position, rotation (degrees) and scale of an object from a node, and hides it when `visible` is false */
function place(object: Object3D, tree: Scene3dTree): void {
    const { position, rotation, scale, visible } = tree.properties;
    if (isVector3(position)) object.position.set(...position);
    if (isVector3(rotation)) object.rotation.set(...(rotation.map((degrees) => MathUtils.degToRad(degrees)) as [number, number, number]));
    if (isVector3(scale)) object.scale.set(...scale);
    object.visible = visible !== false;
    object.userData.tree = tree;
}

/** The colour of a mesh: its `material.color` when it is a literal colour, else white (tokens come with G3.5) */
function meshColor(tree: Scene3dTree): Color {
    const material = tree.properties.material;
    const value = isObject(material) ? material.color : undefined;
    return typeof value === 'string' && LITERAL_COLOR.test(value.trim()) ? new Color().setStyle(value.trim()) : new Color(0xffffff);
}

/** True when the object and every ancestor up to the root are visible */
function shown(object: Object3D | null, root: Object3D): boolean {
    for (let current = object; current && current !== root; current = current.parent) {
        if (!current.visible) return false;
    }
    return true;
}

/**
 * Makes a scene in `host`: a canvas, a `WebGLRenderer`, a three.js scene and a default perspective camera at
 * `DEFAULT_CAMERA_POSITION` looking at the origin. The canvas follows the host's size. Throws when the browser gives
 * no WebGL context; the caller shows its fallback then.
 *
 * This is the package's first renderer (G3.2): a `mesh` is drawn as a unit box in an unlit material of its
 * `material.color`, a `group3d` places its children, and the other nodes are not drawn yet (G3.5 and later stories)
 */
export function createScene3d(host: Element, options: Scene3dOptions = {}): Scene3d {
    const view = host.ownerDocument.defaultView;
    const canvas = host.ownerDocument.createElement('canvas');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    host.append(canvas);

    let renderer: WebGLRenderer;
    try {
        renderer = new WebGLRenderer({ canvas, antialias: true });
    } catch (error) {
        canvas.remove();
        throw new Error(`WebGL is not available: ${error instanceof Error ? error.message : String(error)}`);
    }
    renderer.setPixelRatio(view?.devicePixelRatio ?? 1);

    const scene = new Scene();
    const camera = new PerspectiveCamera(DEFAULT_FOV, 1, 0.1, 1000);
    camera.position.set(...DEFAULT_CAMERA_POSITION);
    camera.lookAt(0, 0, 0);
    const root = new Group();
    scene.add(root);

    const nodes = new Map<string, Object3D>();
    const raycaster = new Raycaster();
    let reducedMotion = options.reducedMotion ?? false;
    let disposed = false;

    function size(): { width: number; height: number } {
        const width = host.clientWidth;
        const height = host.clientHeight;
        return width > 0 && height > 0 ? { width, height } : FALLBACK_SIZE;
    }

    function render(): void {
        if (disposed) return;
        renderer.render(scene, camera);
    }

    function resize(): void {
        if (disposed) return;
        const { width, height } = size();
        // false: the canvas size in CSS is the host's (set above through CSSOM), never a style attribute
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        render();
    }

    function build(tree: Scene3dTree, parent: Object3D): void {
        let object: Object3D;
        if (tree.kind === 'group3d') {
            object = new Group();
        } else if (tree.kind === 'mesh') {
            object = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ color: meshColor(tree) }));
        } else {
            return;
        }
        place(object, tree);
        nodes.set(tree.path, object);
        parent.add(object);
        for (const child of tree.children) build(child, object);
    }

    function clear(): void {
        root.traverse((object) => {
            if (object instanceof Mesh) {
                object.geometry.dispose();
                (object.material as MeshBasicMaterial).dispose();
            }
        });
        root.clear();
        nodes.clear();
    }

    const observer = view && 'ResizeObserver' in view ? new view.ResizeObserver(resize) : undefined;
    observer?.observe(host);
    // three.js sets its state up again after a restore; the picture has to be drawn again (G3.1: the first page of a
    // new headless Chromium loses its contexts once)
    canvas.addEventListener('webglcontextrestored', render);
    resize();

    return {
        update(tree) {
            if (disposed) return;
            clear();
            for (const node of tree) build(node, root);
            render();
        },
        hit(x, y) {
            if (disposed) return undefined;
            const { width, height } = size();
            raycaster.setFromCamera(new Vector2((x / width) * 2 - 1, -(y / height) * 2 + 1), camera);
            for (const intersection of raycaster.intersectObject(root, true)) {
                if (!shown(intersection.object, root)) continue;
                for (let object: Object3D | null = intersection.object; object && object !== root; object = object.parent) {
                    const tree = object.userData.tree as Scene3dTree | undefined;
                    if (tree?.properties.interactive === true) return tree;
                }
            }
            return undefined;
        },
        boundsOf(path) {
            const object = disposed ? undefined : nodes.get(path);
            if (!object) return undefined;
            root.updateWorldMatrix(true, true);
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
            if (disposed || !view) return Promise.resolve();
            return new Promise((resolve) => view.requestAnimationFrame(() => resolve()));
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            observer?.disconnect();
            canvas.removeEventListener('webglcontextrestored', render);
            clear();
            renderer.dispose();
            // Frees the context now, not when the canvas is collected: a page keeps at most 16 (G3.1)
            renderer.forceContextLoss();
            canvas.remove();
        }
    };
}
