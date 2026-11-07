import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { createScene3d } from '../src/scene3d.ts';
import type { Scene3d } from '../src/scene3d.ts';
import { decodeGlb, encodeGlb } from '../src/glb.ts';
import type { GltfJson } from '../src/glb.ts';
import { BITMAP_OPTIONS } from '../src/models.ts';
import type { Scene3dIssue } from '../src/scene.ts';
import type { JsonValue, Scene3dSettings, Scene3dTree } from '../src/tree.ts';
import { draw, expectColor, node, pixelAt } from './pixels.ts';

/** The fixture `test/fixtures/box.glb`: a unit box whose faces show an unlit texture, red above and green below */
const FIXTURE = Uint8Array.from(atob(inject('modelFixture')), (c) => c.charCodeAt(0)).buffer;
const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const BLUE_SKY: Scene3dSettings = { background: '#0000ff', environment: 'none' };
const CHAIR = '$.app.children.chair';

const ref = (id: string): JsonValue => ({ id, name: `${id}.glb`, size: FIXTURE.byteLength, type: 'model/gltf-binary' });
/** A camera at z = 3 looking at the front face of the unit box */
const eye = (): Scene3dTree => node('camera', 'eye', { position: [0, 0, 3], target: [0, 0, 0] });
const chair = (properties: Record<string, JsonValue> = {}): Scene3dTree => node('model', 'chair', properties);

/** The fixture with its JSON changed */
function variant(change: (json: GltfJson) => void): ArrayBuffer {
    const { json, bin } = decodeGlb(FIXTURE);
    change(json);
    return encodeGlb(json, bin);
}

describe('model from a GLB file in Chromium (G3.7b)', () => {
    let host: HTMLElement;
    let scene: Scene3d;
    let issues: Scene3dIssue[];
    let files: Record<string, ArrayBuffer>;
    let reads: string[];

    beforeEach(() => {
        host = document.createElement('div');
        host.style.width = '100px';
        host.style.height = '100px';
        document.body.append(host);
        issues = [];
        reads = [];
        files = { chair: FIXTURE, other: FIXTURE };
        scene = createScene3d(host, {
            readFile: (id) => {
                reads.push(id);
                const data = files[id];
                return data === undefined ? Promise.reject({ code: 'not_found' }) : Promise.resolve(data.slice(0));
            },
            onIssue: (issue) => issues.push(issue)
        });
    });

    afterEach(() => {
        scene.dispose();
        host.remove();
        vi.restoreAllMocks();
    });

    it('should draw the fixture model with its embedded texture the right way up, through createImageBitmap and no blob: URL', async () => {
        // Arrange
        const blobUrls = vi.spyOn(URL, 'createObjectURL');
        const decode = vi.spyOn(window, 'createImageBitmap');

        // Act
        await draw(scene, [eye(), chair({ src: ref('chair') })], BLUE_SKY);

        // Assert: the top half of the texture above the centre, its bottom half below, the background around
        expectColor(pixelAt(host, 0.5, 0.42), RED);
        expectColor(pixelAt(host, 0.5, 0.58), GREEN);
        expectColor(pixelAt(host, 0.03, 0.03), BLUE);
        expect(blobUrls).not.toHaveBeenCalled();
        expect(decode).toHaveBeenCalledTimes(1);
        expect(decode.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
        expect(decode.mock.calls[0]?.[1]).toEqual(BITMAP_OPTIONS);
        expect(issues).toEqual([]);
        expect(scene.info().models).toEqual({ loading: 0, loaded: 1 });
    });

    it('should place the model by the node position and scale, and frame it with the default camera', async () => {
        // Act: no camera, the model moved and made smaller
        await draw(scene, [chair({ src: ref('chair'), position: [5, 0, 0], scale: [0.5, 0.5, 0.5] })], BLUE_SKY);

        // Assert
        expect(scene.boundsOf(CHAIR)).toEqual({ min: [4.75, -0.25, -0.25], max: [5.25, 0.25, 0.25] });
        expectColor(pixelAt(host, 0.5, 0.45), RED);
        expectColor(pixelAt(host, 0.5, 0.55), GREEN);
    });

    it('should stay waiting in drawn() while the file is read, and resolve after the frame with the model', async () => {
        // Arrange
        let finish: (data: ArrayBuffer) => void = () => undefined;
        files = {};
        scene.dispose();
        scene = createScene3d(host, { readFile: () => new Promise<ArrayBuffer>((resolve) => (finish = resolve)), onIssue: (issue) => issues.push(issue) });
        let done = false;

        // Act
        scene.update([eye(), chair({ src: ref('chair') })], BLUE_SKY);
        const drawn = scene.drawn().then(() => {
            done = true;
            return pixelAt(host, 0.5, 0.42);
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const waited = !done && scene.info().models.loading === 1;
        finish(FIXTURE.slice(0));

        // Assert
        expect(waited).toBe(true);
        expectColor(await drawn, RED);
    });

    it('should report a missing file and an empty src as file issues, draw nothing for them and draw the other nodes', async () => {
        // Arrange: a thin white post behind where the box would be
        const post = node('mesh', 'post', { geometry: { kind: 'box', width: 0.2, height: 2, depth: 0.2 }, material: { color: '#ffffff' }, position: [0, 0, -2] });

        // Act
        await draw(scene, [eye(), chair({ src: ref('gone') }), node('model', 'empty', { src: null }), post], { ...BLUE_SKY, environment: 'studio' });

        // Assert: the empty src is told at once, the missing file once its read fails
        expect(issues).toEqual([
            { kind: 'file', path: '$.app.children.empty', reason: 'no_file' },
            { kind: 'file', path: CHAIR, reason: 'not_found' }
        ]);
        expectColor(pixelAt(host, 0.35, 0.42), BLUE);
        expect(pixelAt(host, 0.5, 0.5).slice(0, 3)).not.toEqual(BLUE);
        expect(scene.boundsOf(CHAIR)).toBeUndefined();
    });

    it.each([
        ['Draco', (json: GltfJson) => (json.extensionsRequired = ['KHR_draco_mesh_compression']), 'draco: it uses KHR_draco_mesh_compression'],
        ['Meshopt', (json: GltfJson) => (json.extensionsUsed = ['EXT_meshopt_compression']), 'meshopt: it uses EXT_meshopt_compression'],
        ['KTX2', (json: GltfJson) => (json.extensionsUsed = ['KHR_texture_basisu']), 'ktx2: it uses KHR_texture_basisu'],
        ['an external image', (json: GltfJson) => ((json.images as GltfJson[])[0] = { uri: 'texture.png' }), 'external_uri: images[0].uri names a file outside the GLB']
    ])('should refuse a model with %s as a model issue that names the reason, and draw the other nodes', async (_, change, reason) => {
        // Arrange
        files.packed = variant(change);

        // Act
        await draw(scene, [eye(), chair({ src: ref('packed') }), node('model', 'good', { src: ref('chair'), position: [0, 0, -2] })], BLUE_SKY);

        // Assert: the refused model draws nothing; the good one behind it shows
        expect(issues).toEqual([{ kind: 'model', path: CHAIR, reason }]);
        expect(scene.info().models).toEqual({ loading: 0, loaded: 1 });
        expect(scene.boundsOf(CHAIR)).toBeUndefined();
        expect(scene.boundsOf('$.app.children.good')).toBeDefined();
    });

    it('should free the old model when src changes, and every model when the node goes (memory count)', async () => {
        // Arrange
        await draw(scene, [eye()], BLUE_SKY);
        const start = scene.info().memory;
        await draw(scene, [eye(), chair({ src: ref('chair') })], BLUE_SKY);
        const one = scene.info().memory;

        // Act
        await draw(scene, [eye(), chair({ src: ref('other') })], BLUE_SKY);
        const changed = scene.info().memory;
        await draw(scene, [eye()], BLUE_SKY);
        const gone = scene.info().memory;

        // Assert
        expect(reads).toEqual(['chair', 'other']);
        expect(one.geometries).toBe(start.geometries + 1);
        expect(one.textures).toBe(start.textures + 1);
        expect(changed).toEqual(one);
        expect(gone).toEqual(start);
        expect(scene.info().models).toEqual({ loading: 0, loaded: 0 });
    });

    it('should report a model that is not a GLB, and nothing when the same file is set again', async () => {
        // Arrange
        files.page = new TextEncoder().encode('<html><body>not a model</body></html>').buffer;
        await draw(scene, [eye(), chair({ src: ref('chair') })], BLUE_SKY);

        // Act
        await draw(scene, [eye(), chair({ src: ref('chair'), position: [0, 0.1, 0] })], BLUE_SKY);
        await draw(scene, [eye(), chair({ src: ref('page') })], BLUE_SKY);

        // Assert
        expect(reads).toEqual(['chair', 'page']);
        expect(issues).toEqual([{ kind: 'model', path: CHAIR, reason: 'not_glb: the file does not start with glTF' }]);
        expectColor(pixelAt(host, 0.5, 0.42), BLUE);
    });
});
