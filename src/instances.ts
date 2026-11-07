import { Box3, Color, Euler, InstancedMesh, MathUtils, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import type { BufferGeometry, Group } from 'three';
import { sameValue } from './diff.js';
import { createGeometry, geometryParams } from './geometries.js';
import { DEFAULT_MESH_COLOR, applyMaterial, materialParams } from './materials.js';
import type { MapTextures } from './textures.js';
import type { ColorResolver, JsonValue, Scene3dTree, Vector3Tuple } from './tree.js';

/**
 * The most instances a `repeat3d` draws (owner, Nov 2026). The `scene3d` component cuts the records at it with
 * `SUI-RUN-CAP` before they reach the scene; the scene draws the first `INSTANCE_CAP` copies it is given and no more
 */
export const INSTANCE_CAP = 20_000;
/** The smallest instance buffer a repeat allocates */
export const MIN_INSTANCE_CAPACITY = 16;
/**
 * The most changed instances uploaded one by one (one update range each); with more, the whole buffer is uploaded,
 * which is cheaper than many small uploads
 */
export const MAX_UPDATE_RANGES = 64;

/**
 * The instance buffer size for `count` instances, given the size allocated now (0 for none): kept while the count fits
 * and is more than a quarter of it, else the next power of two (at least `MIN_INSTANCE_CAPACITY`, at most
 * `INSTANCE_CAP`), so a count that grows or shrinks one record at a time reallocates in steps, not per record. Pure
 */
export function instanceCapacity(count: number, current = 0): number {
    const wanted = Math.min(Math.max(0, Math.floor(count)), INSTANCE_CAP);
    if (current > 0 && wanted <= current && (wanted > current / 4 || current <= MIN_INSTANCE_CAPACITY)) return current;
    let capacity = MIN_INSTANCE_CAPACITY;
    while (capacity < wanted) capacity *= 2;
    return Math.min(capacity, INSTANCE_CAP);
}

/** What one instance of a repeat draws with: its place, turn (degrees), size, whether it shows, and its colour value */
export interface InstanceValues {
    readonly position: Vector3Tuple;
    readonly rotation: Vector3Tuple;
    readonly scale: Vector3Tuple;
    /** False for a copy with `visible: false` or `hidden: true`: drawn at scale zero */
    readonly shown: boolean;
    /** The copy's `material.color` as written (a literal or a token), or undefined for the default */
    readonly color: JsonValue | undefined;
}

const isVector3 = (value: JsonValue | undefined): value is [number, number, number] =>
    Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number' && Number.isFinite(n));

const isObject = (value: JsonValue | undefined): value is { [key: string]: JsonValue } => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The values a copy of a repeat's row draws its instance with; the vectors are copied, so the copy may change later. Pure */
export function instanceValues(copy: Scene3dTree): InstanceValues {
    const { position, rotation, scale, visible, hidden, material } = copy.properties;
    const color = isObject(material) ? material.color : undefined;
    return {
        position: isVector3(position) ? [position[0], position[1], position[2]] : [0, 0, 0],
        rotation: isVector3(rotation) ? [rotation[0], rotation[1], rotation[2]] : [0, 0, 0],
        scale: isVector3(scale) ? [scale[0], scale[1], scale[2]] : [1, 1, 1],
        shown: visible !== false && hidden !== true,
        color: color === undefined || color === null || color === '' ? undefined : (JSON.parse(JSON.stringify(color)) as JsonValue)
    };
}

const sameVector = (a: Vector3Tuple, b: Vector3Tuple): boolean => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** True when two instances need the same matrix */
const samePlace = (a: InstanceValues, b: InstanceValues): boolean =>
    a.shown === b.shown && sameVector(a.position, b.position) && sameVector(a.rotation, b.rotation) && sameVector(a.scale, b.scale);

const euler = new Euler();
const quaternion = new Quaternion();
const place = new Vector3();
const size = new Vector3();

/** The matrix of an instance in its repeat's space: scale, then the turn in degrees (XYZ), then the place; zero scale when not shown */
export function instanceMatrix(values: InstanceValues, into = new Matrix4()): Matrix4 {
    const [rx, ry, rz] = values.rotation;
    euler.set(MathUtils.degToRad(rx), MathUtils.degToRad(ry), MathUtils.degToRad(rz));
    quaternion.setFromEuler(euler);
    place.set(...values.position);
    if (values.shown) size.set(...values.scale);
    else size.set(0, 0, 0);
    return into.compose(place, quaternion, size);
}

/** What one `sync` of an `InstanceLayout` changed: the count after it and the instance indices whose matrix or colour is new */
export interface InstanceChanges {
    readonly count: number;
    /** Indices whose matrix must be written, in ascending order */
    readonly matrices: readonly number[];
    /** Indices whose colour must be written, in ascending order */
    readonly colors: readonly number[];
}

/**
 * Which record each instance of a repeat draws, and what changed between two sets of copies. Instance `i` draws the
 * copy `treeAt(i)`, whose `key` is its record key (the binder's `<repeat>.rows.<recordKey>`). A kept record keeps its
 * index, so a change of one record changes one matrix and one colour; a new record takes the next index; a removed
 * record's index is taken by the last instance (one move), so the instances stay packed from 0. Pure: no three.js
 * object is touched, and copies with the same key after the first are ignored
 */
export class InstanceLayout {
    private keys: string[] = [];
    private readonly indices = new Map<string, number>();
    private values: InstanceValues[] = [];
    private trees: Scene3dTree[] = [];

    /** The number of instances */
    get count(): number {
        return this.keys.length;
    }

    /** The record key of the instance at an index (a ray cast's `instanceId`), or undefined past the count */
    keyAt(index: number): string | undefined {
        return this.keys[index];
    }

    /** The copy the instance at an index draws, or undefined past the count */
    treeAt(index: number): Scene3dTree | undefined {
        return this.trees[index];
    }

    /** The index of the instance of a record key, or undefined when it draws none */
    indexOf(key: string): number | undefined {
        return this.indices.get(key);
    }

    /** The values the instance at an index draws with */
    valuesAt(index: number): InstanceValues | undefined {
        return this.values[index];
    }

    /** Takes the next set of copies (at most `INSTANCE_CAP`) and tells which instances changed */
    sync(copies: readonly Scene3dTree[]): InstanceChanges {
        const next = new Map<string, Scene3dTree>();
        for (const copy of copies) {
            if (next.size >= INSTANCE_CAP) break;
            if (!next.has(copy.key)) next.set(copy.key, copy);
        }
        const matrices = new Set<number>();
        const colors = new Set<number>();
        // Gone records: the last instance moves into each hole
        for (const key of [...this.keys]) {
            if (next.has(key)) continue;
            const index = this.indices.get(key) as number;
            const last = this.keys.length - 1;
            this.indices.delete(key);
            if (index !== last) {
                const moved = this.keys[last] as string;
                this.keys[index] = moved;
                this.values[index] = this.values[last] as InstanceValues;
                this.trees[index] = this.trees[last] as Scene3dTree;
                this.indices.set(moved, index);
                matrices.add(index);
                colors.add(index);
            }
            this.keys.pop();
            this.values.pop();
            this.trees.pop();
        }
        for (const [key, tree] of next) {
            const values = instanceValues(tree);
            const index = this.indices.get(key);
            if (index === undefined) {
                const added = this.keys.length;
                this.keys.push(key);
                this.values.push(values);
                this.trees.push(tree);
                this.indices.set(key, added);
                matrices.add(added);
                colors.add(added);
                continue;
            }
            const before = this.values[index] as InstanceValues;
            if (!samePlace(before, values)) matrices.add(index);
            if (!sameValue(before.color, values.color)) colors.add(index);
            this.values[index] = values;
            this.trees[index] = tree;
        }
        const count = this.keys.length;
        const sorted = (set: Set<number>): number[] => [...set].filter((index) => index < count).sort((a, b) => a - b);
        return { count, matrices: sorted(matrices), colors: sorted(colors) };
    }

    /** Forgets every instance */
    clear(): void {
        this.keys = [];
        this.indices.clear();
        this.values = [];
        this.trees = [];
    }
}

/**
 * The properties of a repeat's row that every instance shares: the geometry, the material but its colour (its `map`
 * among it, G3.7c: one texture for every instance, tinted by each instance's colour), and the
 * shadow flags. They are taken from the first copy; the `scene3d` component reports a row whose copies differ in one
 * (`SUI-RUN-DRAW`). Each instance has its own `position`, `rotation`, `scale`, `visible`/`hidden` and `material.color`
 */
export const SHARED_ROW_PROPERTIES = ['geometry', 'material', 'castShadow', 'receiveShadow'] as const;

const matrix = new Matrix4();
const box = new Box3();

/**
 * The three.js side of one `repeat3d`: one `InstancedMesh` in the repeat's group, whose geometry and material all
 * instances share, with an instance matrix and an instance colour per record (`InstanceLayout`). The material's own
 * colour is white, so an instance's colour is its copy's `material.color` (white when unset). A change of one record
 * writes one matrix and one colour and uploads only those (update ranges); a count past the buffer allocates a new
 * buffer in steps (`instanceCapacity`); an empty set frees the mesh, its geometry and its material, so nothing is
 * drawn and nothing is held
 */
export class RepeatInstances {
    readonly layout = new InstanceLayout();
    private mesh: InstancedMesh | undefined;
    private geometry: BufferGeometry | undefined;
    private material: MeshStandardMaterial | undefined;
    /** The shared values the mesh was made with, copied */
    private shared: { geometry?: JsonValue; material?: JsonValue } = {};

    /**
     * @param maps The scene's map textures and the repeat's path (G3.7c): the shared material takes the first copy's
     * `material.map`, read once for the repeat and freed with its material. Without it no map is drawn
     */
    constructor(
        private readonly group: Group,
        private readonly resolve: ColorResolver,
        private readonly convert: (css: string) => Color | undefined,
        private readonly maps?: { readonly textures: MapTextures; readonly path: string }
    ) {}

    /** The instanced mesh while the repeat draws any instance (a test and the ray cast read it) */
    get instanced(): InstancedMesh | undefined {
        return this.mesh;
    }

    /** The number of instances drawn */
    get count(): number {
        return this.mesh?.count ?? 0;
    }

    /** Draws the copies (the repeat node's `children`, in record order), touching only what changed */
    sync(copies: readonly Scene3dTree[]): void {
        const { count, matrices, colors } = this.layout.sync(copies);
        if (count === 0) {
            this.free();
            return;
        }
        const first = this.layout.treeAt(0) as Scene3dTree;
        this.applyShared(first);
        const capacity = instanceCapacity(count, this.mesh === undefined ? 0 : this.mesh.instanceMatrix.count);
        if (this.mesh === undefined || capacity !== this.mesh.instanceMatrix.count) {
            this.allocate(capacity);
            this.writeAll(count);
            return;
        }
        const mesh = this.mesh;
        mesh.count = count;
        for (const index of matrices) mesh.setMatrixAt(index, instanceMatrix(this.layout.valuesAt(index) as InstanceValues, matrix));
        for (const index of colors) mesh.setColorAt(index, this.colorOf(index));
        upload(mesh.instanceMatrix, matrices, 16);
        if (mesh.instanceColor !== null) upload(mesh.instanceColor, colors, 3);
        if (matrices.length > 0) {
            mesh.boundingSphere = null;
            mesh.boundingBox = null;
        }
    }

    /** Resolves every instance's colour and the shared material's again (a theme or mode change) */
    restyle(): void {
        const mesh = this.mesh;
        const first = this.layout.treeAt(0);
        if (mesh === undefined || first === undefined || this.material === undefined) return;
        applyMaterial(this.material, { ...materialParams(first.properties.material, this.resolve), color: DEFAULT_MESH_COLOR }, this.convert);
        for (let index = 0; index < mesh.count; index++) mesh.setColorAt(index, this.colorOf(index));
        if (mesh.instanceColor !== null) uploadAll(mesh.instanceColor);
    }

    /** The bounds in the repeat's world space of the instance of a record key, or undefined when it draws none */
    boundsOf(key: string): Box3 | undefined {
        const index = this.layout.indexOf(key);
        const mesh = this.mesh;
        if (index === undefined || mesh === undefined || this.geometry === undefined) return undefined;
        if (this.geometry.boundingBox === null) this.geometry.computeBoundingBox();
        mesh.updateWorldMatrix(true, false);
        mesh.getMatrixAt(index, matrix);
        return box.copy(this.geometry.boundingBox as Box3).applyMatrix4(matrix).applyMatrix4(mesh.matrixWorld).clone();
    }

    /** Frees the mesh, its instance buffers, the geometry and the material, and forgets the instances */
    dispose(): void {
        this.free();
        this.layout.clear();
    }

    /** The colour of the instance at an index: its copy's `material.color` resolved, white when unset or unresolved */
    private colorOf(index: number): Color {
        const value = this.layout.valuesAt(index)?.color;
        const css = value === undefined ? undefined : this.resolve(value);
        return (css === undefined ? undefined : this.convert(css)) ?? new Color(DEFAULT_MESH_COLOR);
    }

    /** Makes the geometry again when the first copy's differs, and sets the material but its colour, and the shadow flags */
    private applyShared(first: Scene3dTree): void {
        const { geometry, material, castShadow, receiveShadow } = first.properties;
        if (this.geometry === undefined || !sameValue(this.shared.geometry, geometry)) {
            const old = this.geometry;
            this.geometry = createGeometry(geometryParams(geometry));
            this.shared.geometry = geometry === undefined ? undefined : (JSON.parse(JSON.stringify(geometry)) as JsonValue);
            if (this.mesh !== undefined) {
                this.mesh.geometry = this.geometry;
                this.mesh.boundingSphere = null;
                this.mesh.boundingBox = null;
            }
            old?.dispose();
        }
        if (this.material === undefined || !sameValue(this.shared.material, material)) {
            this.material ??= new MeshStandardMaterial();
            applyMaterial(this.material, { ...materialParams(material, this.resolve), color: DEFAULT_MESH_COLOR }, this.convert);
            this.maps?.textures.set(this.maps.path, 'repeat3d', material, this.material);
            this.shared.material = material === undefined ? undefined : (JSON.parse(JSON.stringify(material)) as JsonValue);
        }
        if (this.mesh !== undefined) {
            this.mesh.castShadow = castShadow === true;
            this.mesh.receiveShadow = receiveShadow === true;
        }
    }

    /** Makes a new instanced mesh of `capacity` instances in place of the old one (whose instance buffers are freed) */
    private allocate(capacity: number): void {
        const old = this.mesh;
        const mesh = new InstancedMesh(this.geometry, this.material, capacity);
        mesh.userData.layout = this.layout;
        const first = this.layout.treeAt(0);
        mesh.castShadow = first?.properties.castShadow === true;
        mesh.receiveShadow = first?.properties.receiveShadow === true;
        // The instance colours exist from the start, so the material's program is compiled once with them
        mesh.setColorAt(0, new Color(DEFAULT_MESH_COLOR));
        trackUploads(mesh.instanceMatrix);
        if (mesh.instanceColor !== null) trackUploads(mesh.instanceColor);
        this.mesh = mesh;
        this.group.add(mesh);
        if (old !== undefined) {
            old.removeFromParent();
            old.dispose();
        }
    }

    /** Writes every instance's matrix and colour and uploads the whole buffers */
    private writeAll(count: number): void {
        const mesh = this.mesh as InstancedMesh;
        mesh.count = count;
        for (let index = 0; index < count; index++) {
            mesh.setMatrixAt(index, instanceMatrix(this.layout.valuesAt(index) as InstanceValues, matrix));
            mesh.setColorAt(index, this.colorOf(index));
        }
        uploadAll(mesh.instanceMatrix);
        if (mesh.instanceColor !== null) uploadAll(mesh.instanceColor);
        mesh.boundingSphere = null;
        mesh.boundingBox = null;
    }

    private free(): void {
        const mesh = this.mesh;
        this.mesh = undefined;
        if (mesh !== undefined) {
            mesh.removeFromParent();
            mesh.dispose();
        }
        this.geometry?.dispose();
        this.geometry = undefined;
        this.maps?.textures.release(this.maps.path);
        this.material?.dispose();
        this.material = undefined;
        this.shared = {};
    }
}

/** An instance buffer's upload the renderer has not made yet: some ranges, or the whole buffer */
const pendingUploads = new WeakMap<InstancedMesh['instanceMatrix'], 'ranges' | 'full'>();

/**
 * Tracks the uploads of an instance buffer: until the renderer has uploaded it (`onUploadCallback`), later changes add
 * to the ranges asked for, or ride on a whole upload asked for. A new buffer is uploaded whole
 */
function trackUploads(attribute: InstancedMesh['instanceMatrix']): void {
    pendingUploads.set(attribute, 'full');
    attribute.onUpload(() => pendingUploads.delete(attribute));
}

/** Asks for the whole of an instance buffer to be uploaded at the next frame */
function uploadAll(attribute: InstancedMesh['instanceMatrix']): void {
    attribute.clearUpdateRanges();
    pendingUploads.set(attribute, 'full');
    attribute.needsUpdate = true;
}

/**
 * Marks the changed items of an instance buffer for upload: one update range of `size` numbers per index while the
 * ranges waiting for the next frame are at most `MAX_UPDATE_RANGES`, else the whole buffer. Nothing when no index changed
 */
function upload(attribute: InstancedMesh['instanceMatrix'], indices: readonly number[], size: number): void {
    if (indices.length === 0) return;
    const pending = pendingUploads.get(attribute);
    if (pending === 'full' || attribute.updateRanges.length + indices.length > MAX_UPDATE_RANGES) {
        uploadAll(attribute);
        return;
    }
    for (const index of indices) attribute.addUpdateRange(index * size, size);
    pendingUploads.set(attribute, 'ranges');
    attribute.needsUpdate = true;
}
