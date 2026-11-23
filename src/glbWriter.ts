import { Color, Matrix4 } from 'three';
import type { BufferAttribute, BufferGeometry, InstancedMesh, InterleavedBufferAttribute, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { encodeGlb } from './glb.js';

// A binary glTF 2.0 file of what a scene draws (docs/design/stateui-3d-glb-export.md): the shown meshes and repeat3d
// instances with their world matrices, positions, normals, indices and plain materials. Small on purpose: the runtime
// chunk has little room under its size gate, so three's GLTFExporter is not used

type Attribute = BufferAttribute | InterleavedBufferAttribute;

/** The glTF `componentType` of a float and of an unsigned 32-bit integer; the `target` of vertex data and of indices */
const FLOAT = 5126;
const UINT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

/**
 * Writes a GLB of the meshes under `root` that are shown (`visible` up the tree): one node per mesh, and per instance of
 * an instanced mesh whose matrix is not zero, each with its world matrix and no hierarchy. Equal geometry and material
 * pairs share a glTF mesh. Pure apart from updating the world matrices
 */
export function writeGlb(root: Object3D): ArrayBuffer {
    root.updateWorldMatrix(true, true);
    const nodes: object[] = [];
    const meshes: object[] = [];
    const materials: object[] = [];
    const accessors: object[] = [];
    const views: object[] = [];
    const chunks: Uint8Array[] = [];
    let length = 0;
    const meshIds = new Map<string, number>();
    const materialIds = new Map<string, number>();
    const geometryIds = new Map<BufferGeometry, object>();

    /** Adds a typed array to the binary chunk as a buffer view, 4-byte aligned */
    const view = (array: Float32Array | Uint32Array, target: number): number => {
        views.push({ buffer: 0, byteOffset: length, byteLength: array.byteLength, target });
        chunks.push(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
        length += array.byteLength;
        return views.length - 1;
    };

    /** An accessor of `count` items of `size` floats read from an attribute (any stored type), with the bounds for `POSITION` */
    const vectors = (attribute: Attribute, bounds: boolean): number => {
        const { count } = attribute;
        const array = new Float32Array(count * 3);
        for (let index = 0; index < count; index += 1) array.set([attribute.getX(index), attribute.getY(index), attribute.getZ(index)], index * 3);
        const accessor: Record<string, unknown> = { bufferView: view(array, ARRAY_BUFFER), componentType: FLOAT, count, type: 'VEC3' };
        if (bounds) {
            const min = [Infinity, Infinity, Infinity];
            const max = [-Infinity, -Infinity, -Infinity];
            array.forEach((value, at) => {
                min[at % 3] = Math.min(min[at % 3] as number, value);
                max[at % 3] = Math.max(max[at % 3] as number, value);
            });
            Object.assign(accessor, { min, max });
        }
        accessors.push(accessor);
        return accessors.length - 1;
    };

    /** The primitive of a geometry (written once): its positions, normals and indices */
    const primitive = (geometry: BufferGeometry): object | undefined => {
        const known = geometryIds.get(geometry);
        if (known !== undefined) return known;
        const position = geometry.getAttribute('position') as Attribute | undefined;
        if (position === undefined || position.count === 0) return undefined;
        const attributes: Record<string, number> = { POSITION: vectors(position, true) };
        const normal = geometry.getAttribute('normal') as Attribute | undefined;
        if (normal !== undefined) attributes.NORMAL = vectors(normal, false);
        const made: Record<string, unknown> = { attributes };
        const index = geometry.getIndex();
        if (index !== null) {
            const array = new Uint32Array(index.count);
            for (let at = 0; at < index.count; at += 1) array[at] = index.getX(at);
            accessors.push({ bufferView: view(array, ELEMENT_ARRAY_BUFFER), componentType: UINT, count: index.count, type: 'SCALAR' });
            made.indices = accessors.length - 1;
        }
        geometryIds.set(geometry, made);
        return made;
    };

    /** The glTF material of a three material drawn in a colour, shared by equal ones */
    const material = (source: MeshStandardMaterial, color: Color): number => {
        const opacity = source.transparent ? source.opacity : 1;
        const entry: Record<string, unknown> = {
            pbrMetallicRoughness: { baseColorFactor: [...color.toArray(), opacity], metallicFactor: source.metalness ?? 0, roughnessFactor: source.roughness ?? 1 }
        };
        if (source.emissive !== undefined && source.emissive.getHex() !== 0) entry.emissiveFactor = source.emissive.toArray();
        if (opacity < 1) entry.alphaMode = 'BLEND';
        const key = JSON.stringify(entry);
        let id = materialIds.get(key);
        if (id === undefined) {
            materials.push(entry);
            id = materials.length - 1;
            materialIds.set(key, id);
        }
        return id;
    };

    /** A node drawing a geometry in a material and colour at a world matrix; nothing for an empty geometry */
    const place = (geometry: BufferGeometry, source: MeshStandardMaterial, color: Color, matrix: Matrix4): void => {
        const made = primitive(geometry);
        if (made === undefined || matrix.determinant() === 0) return;
        const materialId = material(source, color);
        const key = `${geometry.uuid}:${materialId}`;
        let id = meshIds.get(key);
        if (id === undefined) {
            meshes.push({ primitives: [{ ...made, material: materialId }] });
            id = meshes.length - 1;
            meshIds.set(key, id);
        }
        nodes.push({ mesh: id, matrix: matrix.toArray() });
    };

    const instance = new Matrix4();
    const tint = new Color();
    root.traverseVisible((object) => {
        const mesh = object as Mesh;
        if (mesh.isMesh !== true || Array.isArray(mesh.material)) return;
        const source = mesh.material as MeshStandardMaterial;
        const base = source.color ?? new Color(1, 1, 1);
        const instanced = mesh as InstancedMesh;
        if (instanced.isInstancedMesh !== true) {
            place(mesh.geometry, source, base, mesh.matrixWorld);
            return;
        }
        for (let at = 0; at < instanced.count; at += 1) {
            instanced.getMatrixAt(at, instance);
            if (instanced.instanceColor !== null) instanced.getColorAt(at, tint);
            else tint.setRGB(1, 1, 1);
            place(mesh.geometry, source, tint.multiply(base), instance.premultiply(mesh.matrixWorld));
        }
    });

    const json: Record<string, unknown> = { asset: { version: '2.0', generator: 'StateUI' }, scene: 0, scenes: [{ nodes: nodes.map((_, at) => at) }], nodes };
    if (meshes.length > 0) Object.assign(json, { meshes, materials, accessors, bufferViews: views, buffers: [{ byteLength: length }] });
    if (length === 0) return encodeGlb(json);
    const bin = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) {
        bin.set(chunk, at);
        at += chunk.byteLength;
    }
    return encodeGlb(json, bin);
}
