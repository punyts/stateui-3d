import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Mesh } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { decodeGlb, encodeGlb } from './glb.js';
import type { GltfJson } from './glb.js';
import { createColorConverter } from './materials.js';
import { ModelError, parseModel } from './models.js';
import { SceneGraph } from './scene.js';
import type { ModelHooks, Scene3dIssue } from './scene.js';
import type { JsonValue, Scene3dTree } from './tree.js';

const fixture = (): ArrayBuffer => new Uint8Array(readFileSync(join(import.meta.dirname, '..', 'test', 'fixtures', 'box.glb'))).buffer;
const PATH = '$.app.children.chair';
const ref = (id: string): JsonValue => ({ id, name: `${id}.glb`, size: 2268, type: 'model/gltf-binary' });
const model = (properties: Record<string, JsonValue> = {}): Scene3dTree => ({ kind: 'model', key: 'chair', path: PATH, properties, children: [] });

/** A graph whose files are read from a map of ids to bytes; a missing id rejects with `not_found` */
function graphWith(files: Record<string, ArrayBuffer>, hooks: Partial<ModelHooks> = {}) {
    const issues: Scene3dIssue[] = [];
    const settled = vi.fn();
    const reads: { id: string; signal: AbortSignal }[] = [];
    const graph = new SceneGraph(() => undefined, createColorConverter(undefined), {
        readFile: (id, signal) => {
            reads.push({ id, signal });
            const data = files[id];
            return data === undefined ? Promise.reject({ code: 'not_found' }) : Promise.resolve(data.slice(0));
        },
        onIssue: (issue) => issues.push(issue),
        onSettled: settled,
        ...hooks
    });
    return { graph, issues, settled, reads };
}

/** Waits until the graph has no model loading */
async function settledModels(graph: SceneGraph): Promise<void> {
    for (let i = 0; i < 200 && graph.loadingModels > 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('parseModel (Node, no images decoded)', () => {
    it('should parse the fixture box into its scene, neither centred nor scaled', async () => {
        // Act
        const scene = await parseModel(fixture());

        // Assert
        const box = scene.getObjectByName('box');
        expect(box).toBeInstanceOf(Mesh);
        expect(scene.position.toArray()).toEqual([0, 0, 0]);
        expect(scene.scale.toArray()).toEqual([1, 1, 1]);
        expect(Array.isArray(scene.userData.animations)).toBe(true);
    });

    it('should reject a compressed model with a ModelError naming the reason, before parsing', async () => {
        // Arrange
        const { json, bin } = decodeGlb(fixture());
        (json as GltfJson).extensionsRequired = ['KHR_draco_mesh_compression'];

        // Act
        const error = await parseModel(encodeGlb(json, bin)).catch((caught: unknown) => caught);

        // Assert
        expect(error).toBeInstanceOf(ModelError);
        expect((error as ModelError).code).toBe('draco');
        expect((error as ModelError).message).toBe('draco: it uses KHR_draco_mesh_compression');
    });

    it('should reject a GLB three.js cannot parse as invalid_glb', async () => {
        // Arrange: an accessor that names a buffer view the file does not have
        const { json, bin } = decodeGlb(fixture());
        (json.meshes as { primitives: { attributes: Record<string, number> }[] }[])[0]!.primitives[0]!.attributes.POSITION = 42;

        // Act
        const error = await parseModel(encodeGlb(json, bin)).catch((caught: unknown) => caught);

        // Assert
        expect((error as ModelError).code).toBe('invalid_glb');
    });
});

describe('SceneGraph models (Node, no WebGL)', () => {
    it('should read the model file by its id, add its scene to the node group and settle', async () => {
        // Arrange
        const { graph, issues, settled, reads } = graphWith({ chair: fixture() });

        // Act
        graph.sync([model({ src: ref('chair'), position: [1, 2, 3] })]);
        const loading = graph.loadingModels;
        await settledModels(graph);

        // Assert
        const group = graph.objectOf(PATH);
        expect(loading).toBe(1);
        expect(reads.map((read) => read.id)).toEqual(['chair']);
        expect(group?.position.toArray()).toEqual([1, 2, 3]);
        expect(group?.children).toHaveLength(1);
        expect(group?.getObjectByName('box')).toBeInstanceOf(Mesh);
        expect(graph.loadedModels).toBe(1);
        expect(settled).toHaveBeenCalledTimes(1);
        expect(issues).toEqual([]);
    });

    it('should tell no_file for an empty src and draw nothing, without reading', () => {
        // Arrange
        const { graph, issues, reads } = graphWith({});

        // Act
        graph.sync([model(), { ...model({ src: '' }), key: 'b', path: `${PATH}2` }]);

        // Assert
        expect(reads).toEqual([]);
        expect(graph.loadingModels).toBe(0);
        expect(issues).toEqual([
            { kind: 'file', path: PATH, reason: 'no_file' },
            { kind: 'file', path: `${PATH}2`, reason: 'no_file' }
        ]);
    });

    it('should tell the read code of a missing file, and offline without a reader', async () => {
        // Arrange
        const missing = graphWith({});
        const offline = graphWith({}, { readFile: undefined });

        // Act
        missing.graph.sync([model({ src: ref('gone') })]);
        offline.graph.sync([model({ src: ref('gone') })]);
        await settledModels(missing.graph);

        // Assert
        expect(missing.issues).toEqual([{ kind: 'file', path: PATH, reason: 'not_found' }]);
        expect(missing.settled).toHaveBeenCalledTimes(1);
        expect(missing.graph.objectOf(PATH)?.children).toEqual([]);
        expect(offline.issues).toEqual([{ kind: 'file', path: PATH, reason: 'offline' }]);
    });

    it('should tell a refused model as a model issue with its reason, and keep the other nodes', async () => {
        // Arrange
        const { json, bin } = decodeGlb(fixture());
        json.extensionsUsed = ['EXT_meshopt_compression'];
        const { graph, issues } = graphWith({ packed: encodeGlb(json, bin) });

        // Act
        graph.sync([model({ src: ref('packed') }), { kind: 'mesh', key: 'box', path: '$.app.children.box', properties: {}, children: [] }]);
        await settledModels(graph);

        // Assert
        expect(issues).toEqual([{ kind: 'model', path: PATH, reason: 'meshopt: it uses EXT_meshopt_compression' }]);
        expect(graph.objectOf('$.app.children.box')).toBeInstanceOf(Mesh);
        expect(graph.loadedModels).toBe(0);
    });

    it('should not read again for the same file, and abort the read of a file replaced while it loads', async () => {
        // Arrange
        const { graph, reads, issues } = graphWith({ a: fixture(), b: fixture() });
        graph.sync([model({ src: ref('a') })]);

        // Act
        graph.sync([model({ src: ref('b') })]);
        const firstAborted = reads[0]?.signal.aborted;
        await settledModels(graph);
        graph.sync([model({ src: { ...(ref('b') as object), name: 'renamed.glb' } as JsonValue })]);

        // Assert
        expect(reads.map((read) => read.id)).toEqual(['a', 'b']);
        expect(firstAborted).toBe(true);
        expect(graph.objectOf(PATH)?.children).toHaveLength(1);
        expect(issues).toEqual([]);
    });

    it('should free the model when src changes to another file or the node goes', async () => {
        // Arrange
        const { graph } = graphWith({ a: fixture(), b: fixture() });
        graph.sync([model({ src: ref('a') })]);
        await settledModels(graph);
        const first = graph.objectOf(PATH)?.children[0];
        const firstBox = first?.getObjectByName('box') as Mesh;
        const disposed = vi.fn();
        firstBox.geometry.addEventListener('dispose', disposed);

        // Act
        graph.sync([model({ src: ref('b') })]);
        await settledModels(graph);
        const second = graph.objectOf(PATH)?.children[0];
        const secondBox = second?.getObjectByName('box') as Mesh;
        const secondDisposed = vi.fn();
        secondBox.geometry.addEventListener('dispose', secondDisposed);
        graph.sync([]);

        // Assert
        expect(disposed).toHaveBeenCalledTimes(1);
        expect(first?.parent).toBeNull();
        expect(second).not.toBe(first);
        expect(secondDisposed).toHaveBeenCalledTimes(1);
        expect(graph.loadedModels).toBe(0);
    });

    it('should free a model that finishes loading after its node went', async () => {
        // Arrange
        let finish: (data: ArrayBuffer) => void = () => undefined;
        const { graph, issues, settled } = graphWith({}, { readFile: () => new Promise<ArrayBuffer>((resolve) => (finish = resolve)) });
        graph.sync([model({ src: ref('late') })]);

        // Act
        graph.clear();
        finish(fixture());
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Assert
        expect(graph.loadingModels).toBe(0);
        expect(graph.loadedModels).toBe(0);
        expect(settled).not.toHaveBeenCalled();
        expect(issues).toEqual([]);
    });
});
