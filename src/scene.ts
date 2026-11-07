import { AmbientLight, Color, DirectionalLight, Fog, Group, HemisphereLight, MathUtils, Mesh, MeshStandardMaterial, OrthographicCamera, PerspectiveCamera, PointLight, Scene, SpotLight } from 'three';
import type { BufferGeometry, Light, LightShadow, Material, Object3D, Texture } from 'three';
import { diffTrees, flattenTree } from './diff.js';
import { environmentPreset, fogParams } from './environment.js';
import type { EnvironmentLight, EnvironmentName } from './environment.js';
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
/** The width and height in texels of the shadow map of a light with `shadows` */
export const SHADOW_MAP_SIZE = 1024;
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
    /** The lights of the environment preset, beside `root`; made again only when the preset changes */
    readonly environment = new Group();
    private environmentName: EnvironmentName | undefined;
    private settings: Scene3dSettings = {};
    /** One fog object while the scene has fog: a new one would make three.js compile every program again */
    private fog: Fog | undefined;

    constructor(
        private readonly resolve: ColorResolver,
        private readonly convert: (css: string) => Color | undefined
    ) {
        this.scene.add(this.root, this.environment);
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

    /** The environment preset drawn now (undefined before the first settings) */
    get environmentPreset(): EnvironmentName | undefined {
        return this.environmentName;
    }

    /** True while a `light` node casts shadows: the renderer turns its shadow map on then (once) */
    get wantsShadows(): boolean {
        for (const { object } of this.entries.values()) {
            if (isLight(object) && object.castShadow) return true;
        }
        return false;
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

    /**
     * Sets the scene's own properties: the background colour (the preset's when unset), the environment preset's lights
     * (made again only when the preset changes, so the nodes are kept) and the fog. The settings are kept for `restyle`
     */
    applySettings(settings: Scene3dSettings): void {
        this.settings = settings;
        const { name, preset } = environmentPreset(settings.environment);
        if (name !== this.environmentName) {
            this.clearEnvironment();
            for (const light of preset.lights) this.environment.add(makeEnvironmentLight(light));
            this.environmentName = name;
        }
        const ambient = isUnset(settings.ambient) ? undefined : this.color(settings.ambient);
        preset.lights.forEach((light, index) => {
            const object = this.environment.children[index] as Light | undefined;
            object?.color.copy((light.sceneAmbient === true ? ambient : undefined) ?? new Color(light.color));
        });
        const background = isUnset(settings.background)
            ? preset.background === undefined
                ? undefined
                : this.convert(preset.background)
            : this.color(settings.background);
        this.scene.background = background ?? null;
        const fog = fogParams(settings.fog);
        if (fog === undefined) {
            this.fog = undefined;
            this.scene.fog = null;
            return;
        }
        this.fog ??= new Fog(0xffffff);
        this.fog.color.copy((fog.color === undefined ? undefined : this.color(fog.color)) ?? background ?? new Color(0xffffff));
        this.fog.near = fog.near;
        this.fog.far = fog.far;
        this.scene.fog = this.fog;
    }

    /**
     * Resolves every colour again, the scene's own and the nodes' (a theme or mode change gives the same tokens other
     * values), without making any object again
     */
    restyle(): void {
        this.applySettings(this.settings);
        for (const entry of this.entries.values()) {
            if (entry.object instanceof Mesh) this.apply(entry, 'material');
            else if (isLight(entry.object)) this.apply(entry, 'color');
        }
    }

    /** Marks every mesh's material to be compiled again (after the renderer's shadow map was turned on) */
    recompile(): void {
        for (const { object } of this.entries.values()) {
            if (object instanceof Mesh) (object.material as Material).needsUpdate = true;
        }
    }

    /** Frees every node's geometry, material and texture and the environment's lights, and forgets the nodes */
    clear(): void {
        for (const path of [...this.entries.keys()]) this.remove(path);
        this.trees = [];
        this.clearEnvironment();
        this.environmentName = undefined;
        this.scene.fog = null;
        this.fog = undefined;
    }

    /** A colour value resolved and converted, or undefined when it names no colour */
    private color(value: JsonValue): Color | undefined {
        const css = this.resolve(value);
        return css === undefined ? undefined : this.convert(css);
    }

    private clearEnvironment(): void {
        for (const light of [...this.environment.children] as Light[]) {
            light.removeFromParent();
            light.dispose();
        }
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
            disposeMaterial(object.material as Material);
        }
        // A light frees its shadow map
        if (isLight(object)) object.dispose();
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
                // Drawn once a light has `shadows` (the renderer's shadow map is turned on then)
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
            } else if (name === 'shadows') {
                // An ambient light casts none; the others get a shadow map of SHADOW_MAP_SIZE texels a side
                const casts = value === true && !(object instanceof AmbientLight);
                const { shadow } = object as Light & { shadow?: LightShadow };
                if (casts && shadow !== undefined) {
                    shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
                    shadow.bias = -0.0005;
                    shadow.normalBias = 0.02;
                }
                object.castShadow = casts;
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

const isUnset = (value: JsonValue | undefined): value is undefined | null | '' => value === undefined || value === null || value === '';

/** Frees a material and the textures it holds */
function disposeMaterial(material: Material): void {
    for (const value of Object.values(material) as unknown[]) {
        if ((value as Texture | null)?.isTexture === true) (value as Texture).dispose();
    }
    material.dispose();
}

/** The three.js light of one light of an environment preset; its colour is set again by `applySettings` */
function makeEnvironmentLight(light: EnvironmentLight): Light {
    const intensity = light.intensity * LIGHT_SCALE;
    if (light.kind === 'ambient') return new AmbientLight(light.color, intensity);
    if (light.kind === 'hemisphere') return new HemisphereLight(light.color, light.groundColor ?? light.color, intensity);
    const sun = new DirectionalLight(light.color, intensity);
    sun.position.set(...(light.position ?? LIGHT_POSITION));
    return sun;
}

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
