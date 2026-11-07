// What a GLB file holds, read without three.js: its header, its JSON chunk and what in it the frame cannot load. Pure,
// so the checks run in Node as well as in the page

/** The first four bytes of a GLB (`glTF` in ASCII, little-endian) */
export const GLB_MAGIC = 0x46546c67;
/** The type of a GLB's JSON chunk (`JSON`) and of its binary chunk (`BIN\0`) */
export const GLB_JSON_CHUNK = 0x4e4f534a;
export const GLB_BIN_CHUNK = 0x004e4942;
/** The size of a GLB's header and of a chunk's header, in bytes */
const HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;

/**
 * Why a model is not drawn, before three.js parses it (each is the start of the `SUI-RUN-3D` reason):
 * - `not_glb`: the bytes are not a GLB of version 2 whose header length is its size, or its JSON chunk is not a JSON object;
 * - `draco`, `meshopt`, `ktx2`: the model is compressed (`KHR_draco_mesh_compression`, `EXT_meshopt_compression` or
 *   `KHR_meshopt_compression`, `KHR_texture_basisu` or an `image/ktx2` image), which needs a worker or WebAssembly that
 *   the frame's policy refuses;
 * - `external_uri`: a buffer or an image names a file outside the GLB (a `uri` that is not a `data:` URI), which the frame
 *   cannot fetch
 */
export type ModelRefusalCode = 'not_glb' | 'draco' | 'meshopt' | 'ktx2' | 'external_uri';

/** A model the frame cannot draw: the code and what in the file it is about */
export interface ModelRefusal {
    readonly code: ModelRefusalCode;
    readonly detail: string;
}

/** The glTF JSON of a GLB, as far as the checks read it */
export type GltfJson = Record<string, unknown>;

/** What `inspectGlb` finds: the JSON of a GLB the frame can load, or why it cannot */
export type GlbInspection = { readonly ok: true; readonly json: GltfJson } | { readonly ok: false; readonly refusal: ModelRefusal };

/** The extensions that compress a model, by the refusal they give */
const COMPRESSIONS: Readonly<Record<string, ModelRefusalCode>> = {
    KHR_draco_mesh_compression: 'draco',
    EXT_meshopt_compression: 'meshopt',
    KHR_meshopt_compression: 'meshopt',
    KHR_texture_basisu: 'ktx2'
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const listOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

/** True for a `data:` URI, which a model may carry inside it */
export const isDataUri = (uri: string): boolean => /^data:/i.test(uri.trim());

/** The media type and bytes of a base64 `data:` URI (a buffer or an image inside the glTF JSON); undefined for any other */
export function decodeDataUri(uri: string): { readonly type: string; readonly bytes: Uint8Array } | undefined {
    const match = /^data:([^,]*?)(;base64)?,(.*)$/is.exec(uri.trim());
    if (match === null) return undefined;
    const type = (match[1] ?? '').split(';')[0]?.trim() || 'application/octet-stream';
    const body = match[3] ?? '';
    try {
        if (match[2] === undefined) return { type, bytes: new TextEncoder().encode(decodeURIComponent(body)) };
        const text = atob(body.replace(/\s+/g, ''));
        const bytes = new Uint8Array(text.length);
        for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
        return { type, bytes };
    } catch {
        return undefined;
    }
}

const refuse = (code: ModelRefusalCode, detail: string): GlbInspection => ({ ok: false, refusal: { code, detail } });

/**
 * Reads a GLB's header and JSON chunk and tells whether the frame can load it: a GLB of version 2 whose header length
 * is its size (as the file store checks on upload), with no compression and no buffer or image outside the file
 * (`ModelRefusalCode`). It reads no mesh and decodes no image
 */
export function inspectGlb(data: ArrayBuffer): GlbInspection {
    if (data.byteLength < HEADER_BYTES + CHUNK_HEADER_BYTES) return refuse('not_glb', `${data.byteLength} bytes are too few for a GLB`);
    const view = new DataView(data);
    if (view.getUint32(0, true) !== GLB_MAGIC) return refuse('not_glb', 'the file does not start with glTF');
    const version = view.getUint32(4, true);
    if (version !== 2) return refuse('not_glb', `the GLB is version ${version}, not 2`);
    const length = view.getUint32(8, true);
    if (length !== data.byteLength) return refuse('not_glb', `the header says ${length} bytes and the file has ${data.byteLength}`);
    const jsonLength = view.getUint32(HEADER_BYTES, true);
    if (view.getUint32(HEADER_BYTES + 4, true) !== GLB_JSON_CHUNK || HEADER_BYTES + CHUNK_HEADER_BYTES + jsonLength > data.byteLength) {
        return refuse('not_glb', 'the first chunk is not its JSON');
    }
    let json: unknown;
    try {
        json = JSON.parse(new TextDecoder().decode(new Uint8Array(data, HEADER_BYTES + CHUNK_HEADER_BYTES, jsonLength)));
    } catch {
        return refuse('not_glb', 'its JSON chunk is not JSON');
    }
    if (!isObject(json)) return refuse('not_glb', 'its JSON chunk is not an object');
    for (const name of [...listOf(json.extensionsUsed), ...listOf(json.extensionsRequired)]) {
        const code = typeof name === 'string' ? COMPRESSIONS[name] : undefined;
        if (code !== undefined) return refuse(code, `it uses ${name as string}`);
    }
    for (const [index, image] of listOf(json.images).entries()) {
        if (!isObject(image)) continue;
        if (image.mimeType === 'image/ktx2') return refuse('ktx2', `images[${index}] is a KTX2 image`);
        if (typeof image.uri === 'string' && !isDataUri(image.uri)) return refuse('external_uri', `images[${index}].uri names a file outside the GLB`);
    }
    for (const [index, buffer] of listOf(json.buffers).entries()) {
        if (isObject(buffer) && typeof buffer.uri === 'string' && !isDataUri(buffer.uri)) return refuse('external_uri', `buffers[${index}].uri names a file outside the GLB`);
    }
    return { ok: true, json };
}

/** The bytes padded with `fill` to a multiple of four, as GLB chunks are */
function padded(bytes: Uint8Array, fill: number): Uint8Array {
    const length = Math.ceil(bytes.length / 4) * 4;
    if (length === bytes.length) return bytes;
    const out = new Uint8Array(length).fill(fill);
    out.set(bytes);
    return out;
}

/**
 * A GLB of version 2 from its glTF JSON and, when given, the bytes of its binary chunk (buffer 0). The test fixtures are
 * made with it (`test/fixtures/make-fixtures.ts`), and the tests make variants of them (a compressed or external model)
 */
export function encodeGlb(json: GltfJson, bin?: Uint8Array): ArrayBuffer {
    const jsonBytes = padded(new TextEncoder().encode(JSON.stringify(json)), 0x20);
    const binBytes = bin === undefined ? undefined : padded(bin, 0);
    const total = HEADER_BYTES + CHUNK_HEADER_BYTES + jsonBytes.length + (binBytes === undefined ? 0 : CHUNK_HEADER_BYTES + binBytes.length);
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    view.setUint32(0, GLB_MAGIC, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, total, true);
    view.setUint32(HEADER_BYTES, jsonBytes.length, true);
    view.setUint32(HEADER_BYTES + 4, GLB_JSON_CHUNK, true);
    out.set(jsonBytes, HEADER_BYTES + CHUNK_HEADER_BYTES);
    if (binBytes !== undefined) {
        const at = HEADER_BYTES + CHUNK_HEADER_BYTES + jsonBytes.length;
        view.setUint32(at, binBytes.length, true);
        view.setUint32(at + 4, GLB_BIN_CHUNK, true);
        out.set(binBytes, at + CHUNK_HEADER_BYTES);
    }
    return out.buffer;
}

/** The glTF JSON and the binary chunk of a GLB (for tests that change a fixture); throws when it is not a GLB */
export function decodeGlb(data: ArrayBuffer): { json: GltfJson; bin?: Uint8Array } {
    const view = new DataView(data);
    if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('Not a GLB');
    const jsonLength = view.getUint32(HEADER_BYTES, true);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(data, HEADER_BYTES + CHUNK_HEADER_BYTES, jsonLength))) as GltfJson;
    const at = HEADER_BYTES + CHUNK_HEADER_BYTES + jsonLength;
    if (at + CHUNK_HEADER_BYTES > data.byteLength) return { json };
    const binLength = view.getUint32(at, true);
    return { json, bin: new Uint8Array(data.slice(at + CHUNK_HEADER_BYTES, at + CHUNK_HEADER_BYTES + binLength)) };
}
