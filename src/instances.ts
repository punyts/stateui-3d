import { Box3, Color, Euler, InstancedMesh, MathUtils, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import type { BufferGeometry, Group } from 'three';
import { sameValue } from './diff.js';
import { createGeometry, geometryParams } from './geometries.js';
import { DEFAULT_MESH_COLOR, applyMaterial, materialParams } from './materials.js';
import { mapSource } from './textures.js';
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

/** A node's place, turn (degrees) and size */
export interface Placement3d {
    readonly position: Vector3Tuple;
    readonly rotation: Vector3Tuple;
    readonly scale: Vector3Tuple;
}

/**
 * What one instance of a repeat draws with: its place, turn (degrees), size, whether it shows, its colour value, and
 * the placements of the `group3d`s above it in its copy, outermost first (empty for a mesh row; docs/design/stateui-3d-group-rows.md)
 */
export interface InstanceValues extends Placement3d {
    readonly outer: readonly Placement3d[];
    /** False for a copy, or a group above it, with `visible: false` or `hidden: true`: drawn at scale zero */
    readonly shown: boolean;
    /** The copy's `material.color` as written (a literal or a token), or undefined for the default */
    readonly color: JsonValue | undefined;
}

const isVector3 = (value: JsonValue | undefined): value is [number, number, number] =>
    Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number' && Number.isFinite(n));

const isObject = (value: JsonValue | undefined): value is { [key: string]: JsonValue } => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A node's placement, the vectors copied. Pure */
function placementOf(tree: Scene3dTree): Placement3d {
    const { position, rotation, scale } = tree.properties;
    return {
        position: isVector3(position) ? [position[0], position[1], position[2]] : [0, 0, 0],
        rotation: isVector3(rotation) ? [rotation[0], rotation[1], rotation[2]] : [0, 0, 0],
        scale: isVector3(scale) ? [scale[0], scale[1], scale[2]] : [1, 1, 1]
    };
}

const shownTree = (tree: Scene3dTree): boolean => tree.properties.visible !== false && tree.properties.hidden !== true;

/**
 * The values a mesh of a repeat's copy draws its instance with: its own, under the `group3d`s `outer` gives (outermost
 * first; none for a mesh row). The vectors are copied, so the copy may change later. Pure
 */
export function instanceValues(copy: Scene3dTree, outer: readonly Scene3dTree[] = []): InstanceValues {
    const { material } = copy.properties;
    const color = isObject(material) ? material.color : undefined;
    return {
        ...placementOf(copy),
        outer: outer.map(placementOf),
        shown: shownTree(copy) && outer.every(shownTree),
        color: color === undefined || color === null || color === '' ? undefined : (JSON.parse(JSON.stringify(color)) as JsonValue)
    };
}

const sameVector = (a: Vector3Tuple, b: Vector3Tuple): boolean => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

const samePlacement = (a: Placement3d, b: Placement3d): boolean => sameVector(a.position, b.position) && sameVector(a.rotation, b.rotation) && sameVector(a.scale, b.scale);

/** True when two instances need the same matrix */
const samePlace = (a: InstanceValues, b: InstanceValues): boolean =>
    a.shown === b.shown && samePlacement(a, b) && a.outer.length === b.outer.length && a.outer.every((placement, index) => samePlacement(placement, b.outer[index] as Placement3d));

const euler = new Euler();
const quaternion = new Quaternion();
const place = new Vector3();
const size = new Vector3();

const outerMatrix = new Matrix4();

/** A placement's matrix: scale, then the turn in degrees (XYZ), then the place */
function placementMatrix(placement: Placement3d, scaled: boolean, into: Matrix4): Matrix4 {
    const [rx, ry, rz] = placement.rotation;
    euler.set(MathUtils.degToRad(rx), MathUtils.degToRad(ry), MathUtils.degToRad(rz));
    quaternion.setFromEuler(euler);
    place.set(...placement.position);
    if (scaled) size.set(...placement.scale);
    else size.set(0, 0, 0);
    return into.compose(place, quaternion, size);
}

/**
 * The matrix of an instance in its repeat's space: the matrices of the groups above it, outermost first, then its own
 * (scale, then the turn in degrees, XYZ, then the place); zero scale when it or a group above it is not shown
 */
export function instanceMatrix(values: InstanceValues, into = new Matrix4()): Matrix4 {
    placementMatrix(values, values.shown, into);
    for (let index = values.outer.length - 1; index >= 0; index--) into.premultiply(placementMatrix(values.outer[index] as Placement3d, true, outerMatrix));
    return into;
}

/**
 * The node at `part` below a copy (`''` the copy itself, `.children.a.children.b` a mesh inside its groups) and the
 * groups from the copy down to it, outermost first; undefined when the copy has no node there. Pure
 */
export function partOf(copy: Scene3dTree, part: string): { readonly tree: Scene3dTree; readonly outer: readonly Scene3dTree[] } | undefined {
    const outer: Scene3dTree[] = [];
    let tree: Scene3dTree | undefined = copy;
    const steps = part === '' ? [] : part.slice(1).split('.');
    for (let index = 0; index < steps.length && tree !== undefined; index += 2) {
        if (steps[index] !== 'children') return undefined;
        outer.push(tree);
        const key = steps[index + 1];
        tree = tree.children.find((child) => child.key === key);
    }
    return tree === undefined ? undefined : { tree, outer };
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
 * Which record each instance of a repeat's part draws, and what changed between two sets of copies. Instance `i` draws
 * the node at `part` of a copy (`partOf`: the copy itself for `''`), `treeAt(i)`, under the groups `chainAt(i)` gives; the copy's whose `key` is its record key (the binder's `<repeat>.rows.<recordKey>`). A kept record keeps its
 * index, so a change of one record changes one matrix and one colour; a new record takes the next index; a removed
 * record's index is taken by the last instance (one move), so the instances stay packed from 0. Pure: no three.js
 * object is touched, and copies with the same key after the first are ignored
 */
export class InstanceLayout {
    private keys: string[] = [];
    private readonly indices = new Map<string, number>();
    private values: InstanceValues[] = [];
    private trees: Scene3dTree[] = [];
    private chains: Scene3dTree[][] = [];

    /** @param part The place in each copy of the node this layout draws (`''`, the copy, for a mesh row) */
    constructor(readonly part = '') {}

    /** The number of instances */
    get count(): number {
        return this.keys.length;
    }

    /** The record key of the instance at an index (a ray cast's `instanceId`), or undefined past the count */
    keyAt(index: number): string | undefined {
        return this.keys[index];
    }

    /** The node of a copy the instance at an index draws, or undefined past the count */
    treeAt(index: number): Scene3dTree | undefined {
        return this.trees[index];
    }

    /** The node the instance at an index draws and the groups above it in its copy, innermost first (a ray cast's nearest interactive node) */
    chainAt(index: number): readonly Scene3dTree[] {
        return this.chains[index] ?? [];
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
        const next = new Map<string, { tree: Scene3dTree; outer: readonly Scene3dTree[] }>();
        for (const copy of copies) {
            if (next.size >= INSTANCE_CAP) break;
            if (next.has(copy.key)) continue;
            const found = partOf(copy, this.part);
            if (found !== undefined) next.set(copy.key, found);
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
                this.chains[index] = this.chains[last] as Scene3dTree[];
                this.indices.set(moved, index);
                matrices.add(index);
                colors.add(index);
            }
            this.keys.pop();
            this.values.pop();
            this.trees.pop();
            this.chains.pop();
        }
        for (const [key, { tree, outer }] of next) {
            const values = instanceValues(tree, outer);
            const chain = [tree, ...[...outer].reverse()];
            const index = this.indices.get(key);
            if (index === undefined) {
                const added = this.keys.length;
                this.keys.push(key);
                this.values.push(values);
                this.trees.push(tree);
                this.chains.push(chain);
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
            this.chains[index] = chain;
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
        this.chains = [];
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
    readonly layout: InstanceLayout;
    private mesh: InstancedMesh | undefined;
    private geometry: BufferGeometry | undefined;
    private material: MeshStandardMaterial | undefined;
    /** The shared values the mesh was made with, copied */
    private shared: { geometry?: JsonValue; material?: JsonValue; custom?: boolean } = {};

    /**
     * @param maps The scene's map textures and the repeat's path (G3.7c): the shared material takes the first copy's
     * `material.map`, read once for the repeat and freed with its material, and told a `custom` geometry's issues (a
     * `bad_face`, or `no_uvs` for a map it cannot draw). Without it no map is drawn
     * @param part The place in each copy of the mesh this draws (`''` for a mesh row; `InstanceLayout`)
     */
    constructor(
        private readonly group: Group,
        private readonly resolve: ColorResolver,
        private readonly convert: (css: string) => Color | undefined,
        private readonly maps?: { readonly textures: MapTextures; readonly path: string; readonly onIssue?: (reason: string) => void },
        part = ''
    ) {
        this.layout = new InstanceLayout(part);
    }

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
        let refresh = false;
        if (this.geometry === undefined || !sameValue(this.shared.geometry, geometry)) {
            const old = this.geometry;
            const params = geometryParams(geometry);
            this.geometry = createGeometry(params);
            if (params.kind === 'custom' && params.bad !== undefined) this.maps?.onIssue?.(`bad_face: ${params.bad}`);
            // A custom geometry has no texture coordinates: the material is set again when it becomes or stops being one
            if ((params.kind === 'custom') !== (this.shared.custom === true)) {
                this.shared.custom = params.kind === 'custom';
                refresh = true;
            }
            this.shared.geometry = geometry === undefined ? undefined : (JSON.parse(JSON.stringify(geometry)) as JsonValue);
            if (this.mesh !== undefined) {
                this.mesh.geometry = this.geometry;
                this.mesh.boundingSphere = null;
                this.mesh.boundingBox = null;
            }
            old?.dispose();
        }
        if (refresh || this.material === undefined || !sameValue(this.shared.material, material)) {
            this.material ??= new MeshStandardMaterial();
            applyMaterial(this.material, { ...materialParams(material, this.resolve), color: DEFAULT_MESH_COLOR }, this.convert);
            const noUvs = this.shared.custom === true && mapSource(material).kind !== 'none';
            if (noUvs) this.maps?.onIssue?.('no_uvs');
            this.maps?.textures.set(this.maps.path, 'repeat3d', noUvs ? { ...(material as Record<string, JsonValue>), map: null } : material, this.material);
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

/** The most meshes a `repeat3d`'s row draws (docs/design/stateui-3d-group-rows.md): one instanced mesh each */
export const MAX_ROW_PARTS = 16;

/**
 * The places of the meshes of a repeat's copy, in tree order (`''` when the copy is a mesh; `.children.<key>…` below its
 * `group3d`s), at most `MAX_ROW_PARTS`. Pure
 */
export function rowParts(copy: Scene3dTree): string[] {
    const parts: string[] = [];
    const walk = (tree: Scene3dTree, at: string): void => {
        if (parts.length >= MAX_ROW_PARTS) return;
        if (tree.kind === 'mesh') parts.push(at);
        else if (tree.kind === 'group3d') for (const child of tree.children) walk(child, `${at}.children.${child.key}`);
    };
    walk(copy, '');
    return parts;
}

/**
 * The three.js side of one `repeat3d` (docs/design/stateui-3d-group-rows.md): one `RepeatInstances` per mesh of its row
 * (`rowParts` of the first copy), all in the repeat's group. A mesh row has one part, the row; a `group3d` row one per
 * mesh below it, each placed under the groups above it in its copy. A part's map is read at the template's path of the
 * part (`<repeat>.row.children.<key>…`). A part the copies no longer have is freed
 */
export class RepeatRows {
    private readonly parts = new Map<string, RepeatInstances>();
    /** The copies last synced, as the records have them (a drag draws one moved, and puts it back from these) */
    private copies: readonly Scene3dTree[] = [];

    constructor(
        private readonly group: Group,
        private readonly resolve: ColorResolver,
        private readonly convert: (css: string) => Color | undefined,
        private readonly maps?: { readonly textures: MapTextures; readonly path: string; readonly onIssue?: (reason: string) => void }
    ) {}

    /** The instances of a part (`''` for a mesh row) */
    partAt(part: string): RepeatInstances | undefined {
        return this.parts.get(part);
    }

    /** The instanced mesh of the first part while it draws (a mesh row's one mesh) */
    get instanced(): InstancedMesh | undefined {
        return this.parts.values().next().value?.instanced;
    }

    /** The number of instances drawn, every part's */
    get count(): number {
        let count = 0;
        for (const part of this.parts.values()) count += part.count;
        return count;
    }

    /** Draws the copies (the repeat node's `children`, in record order), touching only what changed */
    sync(copies: readonly Scene3dTree[]): void {
        this.copies = copies;
        const first = copies[0];
        if (first !== undefined) {
            const wanted = rowParts(first);
            for (const [part, instances] of this.parts) {
                if (wanted.includes(part)) continue;
                instances.dispose();
                this.parts.delete(part);
            }
            for (const part of wanted) {
                if (this.parts.has(part)) continue;
                const maps = this.maps === undefined ? undefined : { textures: this.maps.textures, path: part === '' ? this.maps.path : `${this.maps.path}.row${part}` };
                this.parts.set(part, new RepeatInstances(this.group, this.resolve, this.convert, maps, part));
            }
        }
        for (const instances of this.parts.values()) instances.sync(copies);
    }

    /**
     * The node a path below `<repeat>.rows.` names (`<recordKey>`, or `<recordKey>.children.<key>…` inside a group row)
     * and the matrix of the groups above it in its copy, in the repeat's space (identity for the copy itself); undefined
     * when no copy has it (docs/design/stateui-3d-drag-copies.md)
     */
    nodeAt(rest: string): { readonly tree: Scene3dTree; readonly parent: Matrix4 } | undefined {
        const [key, below] = splitRest(rest);
        const copy = this.copies.find((each) => each.key === key);
        const found = copy === undefined ? undefined : partOf(copy, below);
        if (found === undefined) return undefined;
        const parent = new Matrix4();
        for (const group of found.outer) parent.multiply(placementMatrix(placementOf(group), true, outerMatrix));
        return { tree: found.tree, parent };
    }

    /**
     * Draws the node at `rest` with `value` as its `property` (`position` in its parent's space by default, or a gizmo's
     * `rotation` or `scale`), only the instances of its copy, in the renderer; with no value, draws the copies as last
     * synced again (a drag put back, or ended before the records change)
     */
    move(rest: string, value?: Vector3Tuple, property = 'position'): void {
        const [key, below] = splitRest(rest);
        const moved = (node: Scene3dTree, at: string): Scene3dTree =>
            at === below
                ? { ...node, properties: { ...node.properties, [property]: [...(value as Vector3Tuple)] } }
                : { ...node, children: node.children.map((child) => moved(child, `${at}.children.${child.key}`)) };
        const copies = value === undefined ? this.copies : this.copies.map((copy) => (copy.key === key ? moved(copy, '') : copy));
        for (const instances of this.parts.values()) instances.sync(copies);
    }

    /** Resolves every part's colours again (a theme or mode change) */
    restyle(): void {
        for (const instances of this.parts.values()) instances.restyle();
    }

    /**
     * The world bounds of what a copy's path below `<repeat>.rows.` names: the record key (the whole copy, every part),
     * or a node inside the copy (`<recordKey>.children.<key>…`, the parts at or below it); undefined when nothing is drawn there
     */
    boundsOf(rest: string): Box3 | undefined {
        const [key, below] = splitRest(rest);
        let found: Box3 | undefined;
        for (const [part, instances] of this.parts) {
            if (below !== '' && part !== below && !part.startsWith(`${below}.`)) continue;
            const bounds = instances.boundsOf(key);
            if (bounds === undefined) continue;
            found = found === undefined ? bounds : found.union(bounds);
        }
        return found;
    }

    /** Frees every part */
    dispose(): void {
        for (const instances of this.parts.values()) instances.dispose();
        this.parts.clear();
    }
}

/** A path below `<repeat>.rows.` as the record key and the place of a node in its copy (`''` the copy) */
function splitRest(rest: string): [string, string] {
    const at = rest.indexOf('.children.');
    return at < 0 ? [rest, ''] : [rest.slice(0, at), rest.slice(at)];
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
