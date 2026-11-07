import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { boxGlb } from '../test/fixtures/make-fixtures.ts';
import { decodeDataUri, decodeGlb, encodeGlb, inspectGlb } from './glb.js';
import type { GltfJson } from './glb.js';

const FIXTURE = join(import.meta.dirname, '..', 'test', 'fixtures', 'box.glb');
const fixture = (): ArrayBuffer => new Uint8Array(readFileSync(FIXTURE)).buffer;

/** The fixture with its JSON changed */
function variant(change: (json: GltfJson) => void): ArrayBuffer {
    const { json, bin } = decodeGlb(fixture());
    change(json);
    return encodeGlb(json, bin);
}

const refusalOf = (data: ArrayBuffer): string | undefined => {
    const inspection = inspectGlb(data);
    return inspection.ok ? undefined : inspection.refusal.code;
};

describe('the model fixture (G3.7b)', () => {
    it('should be the file the committed maker writes, under 20 KB', () => {
        // Act
        const committed = readFileSync(FIXTURE);
        const made = new Uint8Array(boxGlb());

        // Assert
        expect(committed.length).toBeLessThan(20 * 1024);
        expect(new Uint8Array(committed)).toEqual(made);
    });

    it('should hold one embedded PNG texture in a bufferView', () => {
        // Act
        const { json } = decodeGlb(fixture());

        // Assert
        expect(json.images).toEqual([{ bufferView: 4, mimeType: 'image/png', name: 'split' }]);
        expect(json.textures).toHaveLength(1);
    });
});

describe('inspectGlb', () => {
    it('should accept the fixture and give its JSON', () => {
        // Act
        const inspection = inspectGlb(fixture());

        // Assert
        expect(inspection.ok).toBe(true);
        expect(inspection.ok && inspection.json.asset).toMatchObject({ version: '2.0' });
    });

    it('should refuse bytes that are not a GLB of version 2 whose header length is its size', () => {
        // Arrange
        const wrongVersion = fixture();
        new DataView(wrongVersion).setUint32(4, 1, true);
        const wrongLength = fixture();
        new DataView(wrongLength).setUint32(8, 99, true);
        const notJson = encodeGlb({}, undefined);
        new Uint8Array(notJson)[20] = 0x7b + 1;

        // Act and assert
        expect(refusalOf(new TextEncoder().encode('<html><body>not a model</body></html>').buffer)).toBe('not_glb');
        expect(refusalOf(new ArrayBuffer(4))).toBe('not_glb');
        expect(refusalOf(wrongVersion)).toBe('not_glb');
        expect(refusalOf(wrongLength)).toBe('not_glb');
        expect(refusalOf(fixture().slice(0, 100))).toBe('not_glb');
        expect(refusalOf(notJson)).toBe('not_glb');
    });

    it.each([
        ['KHR_draco_mesh_compression', 'draco'],
        ['EXT_meshopt_compression', 'meshopt'],
        ['KHR_meshopt_compression', 'meshopt'],
        ['KHR_texture_basisu', 'ktx2']
    ])('should refuse a model that uses %s as %s, used or required', (extension, code) => {
        // Act
        const used = variant((json) => (json.extensionsUsed = ['KHR_materials_unlit', extension]));
        const required = variant((json) => (json.extensionsRequired = [extension]));

        // Assert
        expect(refusalOf(used)).toBe(code);
        expect(refusalOf(required)).toBe(code);
        expect(inspectGlb(used)).toMatchObject({ ok: false, refusal: { detail: `it uses ${extension}` } });
    });

    it('should refuse a KTX2 image', () => {
        // Act and assert
        expect(refusalOf(variant((json) => ((json.images as GltfJson[])[0] = { bufferView: 4, mimeType: 'image/ktx2' })))).toBe('ktx2');
    });

    it('should refuse a buffer or an image outside the file, and accept data: URIs', () => {
        // Arrange
        const externalBuffer = variant((json) => (json.buffers as GltfJson[]).push({ uri: 'parts.bin', byteLength: 4 }));
        const externalImage = variant((json) => ((json.images as GltfJson[])[0] = { uri: 'https://example.com/a.png' }));
        const dataBuffer = variant((json) => (json.buffers as GltfJson[]).push({ uri: 'data:application/octet-stream;base64,AAAAAA==', byteLength: 4 }));
        const dataImage = variant((json) => ((json.images as GltfJson[])[0] = { uri: 'data:image/png;base64,iVBORw0KGgo=' }));

        // Act and assert
        expect(inspectGlb(externalBuffer)).toEqual({ ok: false, refusal: { code: 'external_uri', detail: 'buffers[1].uri names a file outside the GLB' } });
        expect(inspectGlb(externalImage)).toEqual({ ok: false, refusal: { code: 'external_uri', detail: 'images[0].uri names a file outside the GLB' } });
        expect(inspectGlb(dataBuffer).ok).toBe(true);
        expect(inspectGlb(dataImage).ok).toBe(true);
    });
});

describe('decodeDataUri', () => {
    it('should decode a base64 data: URI with its type, and a plain one', () => {
        // Act and assert
        expect(decodeDataUri('data:application/octet-stream;base64,AAEC/w==')).toEqual({ type: 'application/octet-stream', bytes: new Uint8Array([0, 1, 2, 255]) });
        expect(decodeDataUri('data:,a%20b')).toEqual({ type: 'application/octet-stream', bytes: new TextEncoder().encode('a b') });
        expect(decodeDataUri('parts.bin')).toBeUndefined();
        expect(decodeDataUri('data:image/png;base64,***')).toBeUndefined();
    });
});

describe('encodeGlb and decodeGlb', () => {
    it('should give back the JSON and the binary chunk, padded to four bytes', () => {
        // Act
        const glb = encodeGlb({ asset: { version: '2.0' } }, new Uint8Array([1, 2, 3]));
        const { json, bin } = decodeGlb(glb);

        // Assert
        expect(glb.byteLength % 4).toBe(0);
        expect(json).toEqual({ asset: { version: '2.0' } });
        expect(bin).toEqual(new Uint8Array([1, 2, 3, 0]));
        expect(inspectGlb(glb).ok).toBe(true);
    });
});
