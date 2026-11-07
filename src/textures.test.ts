import { Mesh } from 'three';
import type { MeshStandardMaterial } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { createColorConverter } from './materials.js';
import { SceneGraph } from './scene.js';
import type { Scene3dIssue } from './scene.js';
import { MAP_BITMAP_OPTIONS, TEXTURE_FILE_TYPES, mapSource } from './textures.js';
import type { JsonValue, Scene3dTree } from './tree.js';

const PATH = '$.app.children.wall';
const picture = (id: string, type = 'image/png'): JsonValue => ({ id, name: `${id}.png`, size: 10, type });
const wall = (material: Record<string, JsonValue>): Scene3dTree => ({ kind: 'mesh', key: 'wall', path: PATH, properties: { geometry: { kind: 'plane' }, material }, children: [] });

describe('mapSource (G3.7c)', () => {
    it('should take a reference of a png, jpeg, gif or webp file', () => {
        // Act / Assert
        expect(TEXTURE_FILE_TYPES).toEqual(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
        for (const type of TEXTURE_FILE_TYPES) expect(mapSource({ map: picture('a', type) })).toEqual({ kind: 'file', id: 'a', type });
    });

    it('should give none for no material, no map, null and an empty string', () => {
        // Act / Assert
        for (const material of [undefined, null, {}, { map: null }, { map: '' }, { color: '#ff0000' }] as (JsonValue | undefined)[]) {
            expect(mapSource(material)).toEqual({ kind: 'none' });
        }
    });

    it('should refuse a GLB, a text file, a data: URL and a reference without an id', () => {
        // Act / Assert
        for (const map of [picture('a', 'model/gltf-binary'), picture('a', 'text/plain'), picture('a', 'image/svg+xml'), 'data:image/png;base64,iVBORw0KGgo=', { name: 'a.png', type: 'image/png' }, 5]) {
            expect(mapSource({ map: map as JsonValue })).toEqual({ kind: 'refused' });
        }
    });

    it('should decode the picture upside down and as stored', () => {
        // Assert: three.js's primitives have v = 1 at the top, and WebGL does not flip an ImageBitmap
        expect(MAP_BITMAP_OPTIONS).toEqual({ imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    });
});

describe('SceneGraph material.map (G3.7c)', () => {
    function graphWith(files: Record<string, ArrayBuffer>, read = true) {
        const issues: Scene3dIssue[] = [];
        const settled = vi.fn();
        const reads: { id: string; signal: AbortSignal }[] = [];
        const graph = new SceneGraph(() => undefined, createColorConverter(undefined), {
            readFile: read
                ? (id, signal) => {
                      reads.push({ id, signal });
                      const data = files[id];
                      return data === undefined ? Promise.reject({ code: 'not_found' }) : Promise.resolve(data.slice(0));
                  }
                : undefined,
            onIssue: (issue) => issues.push(issue),
            onSettled: settled
        });
        return { graph, issues, settled, reads };
    }

    const settledMaps = async (graph: SceneGraph): Promise<void> => {
        for (let i = 0; i < 200 && graph.loadingMaps > 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    };

    it('should tell a map of another type once, read nothing and leave the material without a map', () => {
        // Arrange
        const { graph, issues, reads } = graphWith({});

        // Act
        graph.sync([wall({ map: picture('a', 'model/gltf-binary') })]);
        graph.sync([wall({ map: picture('a', 'model/gltf-binary'), color: '#ff0000' })]);
        graph.restyle();

        // Assert
        expect(issues).toEqual([{ kind: 'file', path: PATH, node: 'mesh', reason: 'unsupported_type' }]);
        expect(reads).toEqual([]);
        expect(((graph.objectOf(PATH) as Mesh).material as MeshStandardMaterial).map).toBeNull();
        expect(graph.loading).toBe(0);
    });

    it('should tell a missing file with the read code and settle, and a scene without readFile as offline', async () => {
        // Arrange
        const missing = graphWith({});
        const offline = graphWith({}, false);

        // Act
        missing.graph.sync([wall({ map: picture('gone') })]);
        const loading = missing.graph.loading;
        await settledMaps(missing.graph);
        offline.graph.sync([wall({ map: picture('gone') })]);

        // Assert
        expect(loading).toBe(1);
        expect(missing.issues).toEqual([{ kind: 'file', path: PATH, node: 'mesh', reason: 'not_found' }]);
        expect(missing.settled).toHaveBeenCalledTimes(1);
        expect(offline.issues).toEqual([{ kind: 'file', path: PATH, node: 'mesh', reason: 'offline' }]);
        expect(offline.graph.loading).toBe(0);
    });

    it('should read the same file once, and abort the read when the map changes or the node goes', () => {
        // Arrange
        const { graph, reads } = graphWith({});

        // Act
        graph.sync([wall({ map: picture('a') })]);
        graph.sync([wall({ map: picture('a'), color: '#00ff00' })]);
        graph.sync([wall({ map: picture('b') })]);
        graph.sync([]);

        // Assert
        expect(reads.map(({ id }) => id)).toEqual(['a', 'b']);
        expect(reads.map(({ signal }) => signal.aborted)).toEqual([true, true]);
        expect(graph.loading).toBe(0);
    });
});
