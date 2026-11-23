import { InstancedMesh, Mesh } from 'three';
import { describe, expect, it } from 'vitest';
import { decodeGlb, inspectGlb } from './glb.js';
import { writeGlb } from './glbWriter.js';
import { createColorConverter } from './materials.js';
import { parseModel } from './models.js';
import { SceneGraph } from './scene.js';
import type { JsonValue, Scene3dTree } from './tree.js';

const ROOT = '$.app.children';
const literal = (value: JsonValue): string | undefined => (typeof value === 'string' && value.startsWith('#') ? value : undefined);
const node = (kind: Scene3dTree['kind'], key: string, properties: Record<string, JsonValue> = {}, children: Scene3dTree[] = []): Scene3dTree => ({ kind, key, path: `${ROOT}.${key}`, properties, children });
const copy = (key: string, at: number[], color: string): Scene3dTree => ({
    kind: 'mesh',
    key,
    path: `${ROOT}.crates.rows.${key}`,
    properties: { geometry: { kind: 'box' }, position: at, material: { color } },
    children: []
});

/** A graph drawn from a tree, as the scene draws it */
function graphOf(tree: Scene3dTree[]): SceneGraph {
    const graph = new SceneGraph(literal, createColorConverter(undefined));
    graph.sync(tree);
    return graph;
}

interface Gltf {
    nodes: { mesh: number; matrix: number[] }[];
    meshes?: { primitives: { attributes: { POSITION: number; NORMAL?: number }; indices?: number; material: number }[] }[];
    materials?: { pbrMetallicRoughness: { baseColorFactor: number[]; metallicFactor: number; roughnessFactor: number }; alphaMode?: string }[];
    accessors?: { count: number; min?: number[]; max?: number[] }[];
}

describe('writeGlb (docs/design/stateui-3d-glb-export.md)', () => {
    it('should write a custom geometry as its triangles, flat without indices and smooth with them (mesh editor, V1)', async () => {
        // Arrange: a square of two triangles, flat, and the same square smooth beside it
        const square = { kind: 'custom', vertices: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], faces: [[0, 1, 2, 3]] };
        const graph = graphOf([node('mesh', 'flat', { geometry: square }), node('mesh', 'smooth', { geometry: { ...square, shading: 'smooth' }, position: [2, 0, 0] })]);

        // Act
        const bytes = writeGlb(graph.root);
        const gltf = decodeGlb(bytes).json as unknown as Gltf;

        // Assert
        expect((await parseModel(bytes)).children.length).toBeGreaterThan(0);
        const [flat, smooth] = (gltf.meshes ?? []).map((mesh) => mesh.primitives[0]);
        expect(flat?.indices).toBeUndefined();
        expect(gltf.accessors?.[flat?.attributes.POSITION ?? -1]?.count).toBe(6);
        expect(gltf.accessors?.[smooth?.attributes.POSITION ?? -1]?.count).toBe(4);
        expect(gltf.accessors?.[smooth?.indices ?? -1]?.count).toBe(6);
        expect(gltf.accessors?.[flat?.attributes.POSITION ?? -1]?.max).toEqual([1, 1, 0]);
    });

    it('should write a GLB the frame loads, with a node per shown mesh at its world matrix and a plain material', async () => {
        // Arrange: a red box in a group moved along x, a hidden sphere
        const graph = graphOf([
            node('group3d', 'rack', { position: [2, 0, 0] }, [{ ...node('mesh', 'box', { geometry: { kind: 'box' }, position: [0, 1, 0], material: { color: '#ff0000', metalness: 0.5, roughness: 0.25 } }), path: `${ROOT}.rack.children.box` }]),
            node('mesh', 'ball', { geometry: { kind: 'sphere' }, visible: false })
        ]);

        // Act
        const bytes = writeGlb(graph.root);
        const { json, bin } = decodeGlb(bytes);
        const gltf = json as unknown as Gltf;
        const loaded = await parseModel(bytes);

        // Assert
        expect(inspectGlb(bytes).ok).toBe(true);
        expect(gltf.nodes).toHaveLength(1);
        expect(gltf.nodes[0]?.matrix.slice(12, 15)).toEqual([2, 1, 0]);
        const material = gltf.materials?.[0]?.pbrMetallicRoughness;
        expect(material?.baseColorFactor).toEqual([1, 0, 0, 1]);
        expect([material?.metallicFactor, material?.roughnessFactor]).toEqual([0.5, 0.25]);
        const primitive = gltf.meshes?.[0]?.primitives[0];
        expect(primitive?.attributes.NORMAL).toBeDefined();
        expect(primitive?.indices).toBeDefined();
        expect(gltf.accessors?.[primitive?.attributes.POSITION ?? -1]?.min).toEqual([-0.5, -0.5, -0.5]);
        expect(bin?.byteLength).toBeGreaterThan(0);
        const meshes: Mesh[] = [];
        loaded.traverse((object) => void ((object as Mesh).isMesh && meshes.push(object as Mesh)));
        expect(meshes).toHaveLength(1);
        expect(meshes[0]?.geometry.getAttribute('position').count).toBe(24);
    });

    it('should write each shown instance of a repeat as a node of its own colour, sharing the geometry, and skip a hidden one', () => {
        // Arrange
        const graph = graphOf([
            node('repeat3d', 'crates', { position: [0, 0, 5] }, [copy('a', [1, 0, 0], '#00ff00'), copy('b', [2, 0, 0], '#0000ff'), { ...copy('c', [3, 0, 0], '#00ff00'), properties: { ...copy('c', [3, 0, 0], '#00ff00').properties, visible: false } }])
        ]);
        const instanced = graph.repeatOf(`${ROOT}.crates`)?.instanced as InstancedMesh;

        // Act
        const gltf = decodeGlb(writeGlb(graph.root)).json as unknown as Gltf;

        // Assert
        expect(instanced.count).toBe(3);
        expect(gltf.nodes.map((entry) => entry.matrix.slice(12, 15))).toEqual([
            [1, 0, 5],
            [2, 0, 5]
        ]);
        expect(gltf.materials?.map((entry) => entry.pbrMetallicRoughness.baseColorFactor)).toEqual([
            [0, 1, 0, 1],
            [0, 0, 1, 1]
        ]);
        expect(gltf.meshes).toHaveLength(2);
        expect(gltf.meshes?.[0]?.primitives[0]?.attributes.POSITION).toBe(gltf.meshes?.[1]?.primitives[0]?.attributes.POSITION);
    });

    it('should mark a see-through material BLEND, and write an empty scene with no buffer', () => {
        // Arrange
        const glass = graphOf([node('mesh', 'glass', { geometry: { kind: 'box' }, material: { color: '#ffffff', opacity: 0.5 } })]);

        // Act
        const glassJson = decodeGlb(writeGlb(glass.root)).json as unknown as Gltf;
        const empty = decodeGlb(writeGlb(graphOf([]).root));

        // Assert
        expect(glassJson.materials?.[0]?.alphaMode).toBe('BLEND');
        expect(glassJson.materials?.[0]?.pbrMetallicRoughness.baseColorFactor[3]).toBe(0.5);
        expect(empty.json).toEqual({ asset: { version: '2.0', generator: 'StateUI' }, scene: 0, scenes: [{ nodes: [] }], nodes: [] });
        expect(empty.bin).toBeUndefined();
    });
});
