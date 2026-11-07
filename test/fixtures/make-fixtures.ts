// Makes the model fixture of the tests (G3.7b): `box.glb`, a unit box whose six faces show one embedded PNG texture, the
// top half red and the bottom half green, with an unlit material, so a pixel above the centre of the front face is red
// and one below it green when the image is decoded the right way up. Run it with `node test/fixtures/make-fixtures.ts`
// (Node's type stripping); the file it writes is committed beside it.
//
// It also makes `box-clips.glb` (G3.9b): the same box with two animation clips of one second each that move its node,
// `slide` from x = 0 to x = 1 and `lift` from y = 0 to y = 1, both linear, so a clip's time shows in where the box is.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { decodeGlb, encodeGlb } from '../../src/glb.ts';

/** The colours of the texture's top and bottom halves */
export const TOP = [255, 0, 0] as const;
export const BOTTOM = [0, 255, 0] as const;

function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        let c = (crc ^ byte) & 0xff;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
}

/** An RGB PNG of `size` by `size` pixels, the top half `top` and the bottom half `bottom` */
function splitPng(size: number, top: readonly number[], bottom: readonly number[]): Buffer {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8;
    header[9] = 2;
    const rows: number[] = [];
    for (let y = 0; y < size; y += 1) {
        rows.push(0);
        for (let x = 0; x < size; x += 1) rows.push(...(y < size / 2 ? top : bottom));
    }
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return Buffer.concat([signature, pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(Buffer.from(rows))), pngChunk('IEND', Buffer.alloc(0))]);
}

type V3 = [number, number, number];
const add = (...vectors: V3[]): V3 => vectors.reduce<V3>((sum, v) => [sum[0] + v[0], sum[1] + v[1], sum[2] + v[2]], [0, 0, 0]);
const times = (v: V3, k: number): V3 => [v[0] * k, v[1] * k, v[2] * k];

/**
 * The faces of a unit box: outward normal, right and up, with right × up = normal, so the corners bottom-left,
 * bottom-right, top-right, top-left go counter-clockwise seen from outside and the image stands upright on each face
 */
const FACES: readonly [V3, V3, V3][] = [
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]]
];

/** The bytes of `box.glb` */
export function boxGlb(): ArrayBuffer {
    const positions: number[] = [];
    const normals: number[] = [];
    // glTF texture coordinates start at the image's top-left corner
    const uvs: number[] = [];
    const indices: number[] = [];
    for (const [normal, right, up] of FACES) {
        const base = positions.length / 3;
        const centre = times(normal, 0.5);
        const corners: [V3, [number, number]][] = [
            [add(centre, times(right, -0.5), times(up, -0.5)), [0, 1]],
            [add(centre, times(right, 0.5), times(up, -0.5)), [1, 1]],
            [add(centre, times(right, 0.5), times(up, 0.5)), [1, 0]],
            [add(centre, times(right, -0.5), times(up, 0.5)), [0, 0]]
        ];
        for (const [corner, uv] of corners) {
            positions.push(...corner);
            normals.push(...normal);
            uvs.push(...uv);
        }
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const pad = (bytes: Uint8Array): Uint8Array => {
        const out = new Uint8Array(Math.ceil(bytes.length / 4) * 4);
        out.set(bytes);
        return out;
    };
    const image = new Uint8Array(splitPng(8, TOP, BOTTOM));
    const parts = [new Uint8Array(new Float32Array(positions).buffer), new Uint8Array(new Float32Array(normals).buffer), new Uint8Array(new Float32Array(uvs).buffer), pad(new Uint8Array(new Uint16Array(indices).buffer)), pad(image)];
    const offsets: number[] = [];
    let at = 0;
    for (const part of parts) {
        offsets.push(at);
        at += part.length;
    }
    const bin = new Uint8Array(at);
    parts.forEach((part, index) => bin.set(part, offsets[index]));
    const vertices = positions.length / 3;
    const json = {
        asset: { version: '2.0', generator: '@punyts/stateui-3d test/fixtures/make-fixtures.ts' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0, name: 'box' }],
        meshes: [{ name: 'box', primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
        materials: [{ name: 'split', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 }, extensions: { KHR_materials_unlit: {} } }],
        extensionsUsed: ['KHR_materials_unlit'],
        textures: [{ source: 0, sampler: 0 }],
        samplers: [{ magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 }],
        images: [{ bufferView: 4, mimeType: 'image/png', name: 'split' }],
        buffers: [{ byteLength: bin.length }],
        bufferViews: [
            { buffer: 0, byteOffset: offsets[0], byteLength: parts[0]?.length, target: 34962 },
            { buffer: 0, byteOffset: offsets[1], byteLength: parts[1]?.length, target: 34962 },
            { buffer: 0, byteOffset: offsets[2], byteLength: parts[2]?.length, target: 34962 },
            { buffer: 0, byteOffset: offsets[3], byteLength: indices.length * 2, target: 34963 },
            { buffer: 0, byteOffset: offsets[4], byteLength: image.length }
        ],
        accessors: [
            { bufferView: 0, componentType: 5126, count: vertices, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
            { bufferView: 1, componentType: 5126, count: vertices, type: 'VEC3' },
            { bufferView: 2, componentType: 5126, count: vertices, type: 'VEC2' },
            { bufferView: 3, componentType: 5123, count: indices.length, type: 'SCALAR' }
        ]
    };
    return encodeGlb(json, bin);
}

/** The clips of `box-clips.glb`, in the order of the file, and how far each moves the box along its axis in its second */
export const CLIPS = [
    { name: 'slide', axis: 0 },
    { name: 'lift', axis: 1 }
] as const;
export const CLIP_DISTANCE = 1;
export const CLIP_SECONDS = 1;

/** The bytes of `box-clips.glb`: `box.glb` with the `CLIPS` on its one node */
export function clipsGlb(): ArrayBuffer {
    const { json, bin } = decodeGlb(boxGlb());
    const base = bin?.length ?? 0;
    const times = new Float32Array([0, CLIP_SECONDS]);
    const tracks = CLIPS.map(({ axis }) => {
        const end = [0, 0, 0];
        end[axis] = CLIP_DISTANCE;
        return new Float32Array([0, 0, 0, ...end]);
    });
    const parts = [times, ...tracks].map((part) => new Uint8Array(part.buffer));
    const extra = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(base + extra);
    if (bin !== undefined) out.set(bin);
    const views = json.bufferViews as unknown[];
    const accessors = json.accessors as unknown[];
    let at = base;
    const accessorOf = (part: Uint8Array, accessor: Record<string, unknown>): number => {
        out.set(part, at);
        views.push({ buffer: 0, byteOffset: at, byteLength: part.length });
        at += part.length;
        accessors.push({ bufferView: views.length - 1, componentType: 5126, ...accessor });
        return accessors.length - 1;
    };
    const input = accessorOf(parts[0]!, { count: 2, type: 'SCALAR', min: [0], max: [CLIP_SECONDS] });
    json.animations = CLIPS.map(({ name }, index) => {
        const output = accessorOf(parts[index + 1]!, { count: 2, type: 'VEC3' });
        return { name, samplers: [{ input, output, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] };
    });
    (json.buffers as { byteLength: number }[])[0]!.byteLength = out.length;
    return encodeGlb(json, out);
}

if (import.meta.main) {
    for (const [name, glb] of [
        ['box.glb', boxGlb()],
        ['box-clips.glb', clipsGlb()]
    ] as const) {
        const out = join(import.meta.dirname, name);
        writeFileSync(out, new Uint8Array(glb));
        console.log(`${out}: ${glb.byteLength} bytes`);
    }
}
