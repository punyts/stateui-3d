import { AmbientLight, Color, DirectionalLight, Group, MathUtils, Mesh, MeshStandardMaterial, OrthographicCamera, PerspectiveCamera, PointLight, Scene, SpotLight } from 'three';
import type { BufferGeometry, Light, Object3D } from 'three';
import { diffTrees, flattenTree, sameValue } from './diff.js';
import { createGeometry, geometryParams } from './geometries.js';
import { applyMaterial, materialParams } from './materials.js';
import type { ColorResolver, JsonValue, Scene3dSettings, Scene3dTree } from './tree.js';
import { DEFAULT_FOV } from './cameras.js';

/**
 * The factor a node's light `intensity` is multiplied by for three.js: with it, a white surface facing a directional
 * light of intensity 1 (or lit by an ambient light of intensity 1) is drawn white, as an author expects, where
 * three.js's physically based lights would draw it at 1/π
 */
export const LIGHT_SCALE = Math.PI;
/** The intensity (before `LIGHT_SCALE`) of the ambient light of the `scene3d.ambient` colour an environment adds */
export const ENVIRONMENT_AMBIENT = 0.4;
/** The near and far planes of a `camera` node */
export const CAMERA_NEAR = 0.05;
export const CAMERA_FAR = 2000;

/** The properties whose change makes a node's object again: a light or camera of another `kind` is another class */
const REBUILT_BY: Partial<Record<Scene3dTree['kind'], readonly string[]>> = { light: ['kind'], camera: ['kind'] };

/** A node drawn in the scene: its tree, its object and, for a directional or spot light, the object it aims at */
interface Entry {
    tree: Scene3dTree;
    readonly object: Object3D;
    readonly aim?: Object3D;
}

const isVector3 = (value: JsonValue | undefined): value is [number, number, number] =>
    Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number' && Number.isFinite(n));

const finite = (value: JsonValue | undefined, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/** A light's intensity for three.js: the node's (0 to 100, default 1) times `LIGHT_SCALE` */
export const lightIntensity = (value: JsonValue | undefined): number => Math.min(100, Math.max(0, finite(value, 1))) * LIGHT_SCALE;

/** The position a light stands at when the node sets none (the `light` shape's default) */
const LIGHT_POSITION: [number, number, number] = [5, 10, 5];

/**
 * The three.js side of a scene: one object per node, keyed by the node's path, made and changed property by property
 * from the difference between the last tree and the next (`diffTrees`), so a changed `position` touches one object.
 * It draws nothing itself: `createScene3d` renders `scene` through the active camera
 */
export class SceneGraph {
    readonly scene = new Scene();
    /** The nodes' objects hang below this group; the environment's lights hang beside it */
    readonly root = new Group();
    private readonly entries = new Map<string, Entry>();
    private trees: readonly Scene3dTree[] = [];
    private ambient: AmbientLight | undefined;

    constructor(
        private readonly resolve: ColorResolver,
        private readonly convert: (css: string) => Color | undefined
    ) {
        this.scene.add(this.root);
    }

    /** The tree last given to `sync` */
    get tree(): readonly Scene3dTree[] {
        return this.trees;
    }

    /** The object drawn for the node with this path */
    objectOf(path: string): Object3D | undefined {
        return this.entries.get(path)?.object;
    }

    /** The number of nodes that have an object (a test counts them) */
    get size(): number {
        return this.entries.size;
    }

    /** Brings the objects in line with a new tree: removes the nodes that went, makes the new ones, changes the rest */
    sync(trees: readonly Scene3dTree[]): void {
        const diff = diffTrees(this.trees, trees);
        const removed = new Set(diff.removed);
        const added = [...diff.added];
        for (const [path, names] of diff.changed) {
            const rebuilt = REBUILT_BY[this.entries.get(path)?.tree.kind ?? 'mesh'] ?? [];
            if (names.some((name) => rebuilt.includes(name))) {
                removed.add(path);
                added.push(path);
            }
        }
        for (const path of removed) this.remove(path);
        const next = flattenTree(trees);
        for (const path of added) {
            const node = next.get(path);
            if (node !== undefined) this.add(node.tree);
        }
        for (const [path, names] of diff.changed) {
            if (removed.has(path)) continue;
            const entry = this.entries.get(path);
            const node = next.get(path);
            if (entry === undefined || node === undefined) continue;
            entry.tree = node.tree;
            for (const name of names) this.apply(entry, name);
        }
        // Each object under its parent's (one made again keeps its children), with the tree it stands for
        for (const [path, { tree, parent }] of next) {
            const entry = this.entries.get(path);
            if (entry === undefined) continue;
            entry.tree = tree;
            entry.object.userData.tree = tree;
            const into = parent === undefined ? this.root : (this.entries.get(parent)?.object ?? this.root);
            if (entry.object.parent !== into) into.add(entry.object);
            if (entry.aim !== undefined && entry.aim.parent !== into) into.add(entry.aim);
        }
        this.trees = trees;
    }

    /** Sets the scene's own properties: the background colour and the ambient light an environment adds */
    applySettings(settings: Scene3dSettings): void {
        const background = settings.background === undefined || settings.background === null ? undefined : this.resolve(settings.background);
        this.scene.background = (background === undefined ? undefined : this.convert(background)) ?? null;
        const wanted = settings.environment !== 'none';
        const css = wanted && settings.ambient !== undefined && settings.ambient !== null ? this.resolve(settings.ambient) : undefined;
        const colour = css === undefined ? undefined : this.convert(css);
        if (colour === undefined) {
            this.ambient?.removeFromParent();
            this.ambient?.dispose();
            this.ambient = undefined;
            return;
        }
        this.ambient ??= new AmbientLight();
        this.ambient.color.copy(colour);
        this.ambient.intensity = ENVIRONMENT_AMBIENT * LIGHT_SCALE;
        if (this.ambient.parent !== this.scene) this.scene.add(this.ambient);
    }

    /** Frees every node's geometry and material and forgets the nodes */
    clear(): void {
        for (const path of [...this.entries.keys()]) this.remove(path);
        this.trees = [];
        this.ambient?.dispose();
    }

    private add(tree: Scene3dTree): void {
        const object = this.make(tree);
        if (object === undefined) return;
        const aim = object instanceof DirectionalLight || object instanceof SpotLight ? object.target : undefined;
        const entry: Entry = { tree, object, aim };
        this.entries.set(tree.path, entry);
        object.userData.tree = tree;
        object.userData.path = tree.path;
        const names = new Set([...Object.keys(tree.properties), 'position', 'rotation', 'scale', 'visible', 'geometry', 'material', 'color', 'intensity', 'target', 'fov']);
        for (const name of names) this.apply(entry, name);
    }

    private make(tree: Scene3dTree): Object3D | undefined {
        switch (tree.kind) {
            case 'group3d':
            case 'model':
                // A model draws nothing yet: its GLB file is read and drawn by G3.7b; its transforms already apply
                return new Group();
            case 'mesh':
                // The geometry and the material are set by apply, as every property is
                return new Mesh(undefined, new MeshStandardMaterial());
            case 'light':
                return makeLight(tree.properties.kind);
            case 'camera':
                return tree.properties.kind === 'orthographic' ? new OrthographicCamera(-1, 1, 1, -1, CAMERA_NEAR, CAMERA_FAR) : new PerspectiveCamera(DEFAULT_FOV, 1, CAMERA_NEAR, CAMERA_FAR);
            default:
                // repeat3d and label3d draw with their own stories (G3.6, G3.6b)
                return undefined;
        }
    }

    private remove(path: string): void {
        const entry = this.entries.get(path);
        if (entry === undefined) return;
        this.entries.delete(path);
        const { object } = entry;
        object.removeFromParent();
        entry.aim?.removeFromParent();
        if (object instanceof Mesh) {
            (object.geometry as BufferGeometry).dispose();
            (object.material as MeshStandardMaterial).dispose();
        }
        if (object instanceof AmbientLight || object instanceof DirectionalLight || object instanceof PointLight || object instanceof SpotLight) object.dispose();
    }

    /** Sets one property of a node on its object */
    private apply(entry: Entry, name: string): void {
        const { object, tree } = entry;
        const value = tree.properties[name];
        switch (name) {
            case 'position':
                if (isVector3(value)) object.position.set(...value);
                else if (tree.kind === 'light') object.position.set(...LIGHT_POSITION);
                else object.position.set(0, 0, 0);
                return;
            case 'rotation':
                if (tree.kind === 'camera') return;
                if (isVector3(value)) object.rotation.set(MathUtils.degToRad(value[0]), MathUtils.degToRad(value[1]), MathUtils.degToRad(value[2]));
                else object.rotation.set(0, 0, 0);
                return;
            case 'scale':
                if (isVector3(value)) object.scale.set(...value);
                else object.scale.set(1, 1, 1);
                return;
            case 'visible':
            case 'hidden':
                // `hidden` is the property every component has: a hidden node is not drawn, as one with `visible: false`
                object.visible = tree.properties.visible !== false && tree.properties.hidden !== true;
                return;
        }
        if (object instanceof Mesh) {
            if (name === 'geometry') {
                const old = object.geometry as BufferGeometry;
                object.geometry = createGeometry(geometryParams(value));
                old.dispose();
            } else if (name === 'material') {
                applyMaterial(object.material as MeshStandardMaterial, materialParams(value, this.resolve), this.convert);
            } else if (name === 'castShadow' || name === 'receiveShadow') {
                // Shadows are drawn once a light has them (G3.5b); the flags are kept on the mesh already
                object[name] = value === true;
            }
            return;
        }
        if (isLight(object)) {
            if (name === 'color') {
                const css = value === undefined || value === null || value === '' ? undefined : this.resolve(value);
                object.color.copy((css === undefined ? undefined : this.convert(css)) ?? new Color(0xffffff));
            } else if (name === 'intensity') {
                object.intensity = lightIntensity(value);
            } else if (name === 'target' && entry.aim !== undefined) {
                if (isVector3(value)) entry.aim.position.set(...value);
                else entry.aim.position.set(0, 0, 0);
            }
            return;
        }
        if (object instanceof PerspectiveCamera && name === 'fov') {
            object.fov = Math.min(179, Math.max(1, finite(value, DEFAULT_FOV)));
            object.updateProjectionMatrix();
        }
    }
}

const isLight = (object: Object3D): object is Light => (object as Light).isLight === true;

/** The light of a `light` node's `kind` (default `directional`); point and spot lights do not fade with distance */
function makeLight(kind: JsonValue | undefined): Light {
    switch (kind) {
        case 'ambient':
            return new AmbientLight();
        case 'point':
            return new PointLight(0xffffff, 1, 0, 0);
        case 'spot':
            return new SpotLight(0xffffff, 1, 0, Math.PI / 6, 0.2, 0);
        default:
            return new DirectionalLight();
    }
}

/** The pieces of a camera node a renderer needs: its target in the node's parent space and its field of view */
export function cameraTarget(tree: Scene3dTree): [number, number, number] {
    const value = tree.properties.target;
    return isVector3(value) ? value : [0, 0, 0];
}
