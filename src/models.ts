import {
    ClampToEdgeWrapping,
    LinearFilter,
    LinearMipmapLinearFilter,
    LinearMipmapNearestFilter,
    MirroredRepeatWrapping,
    NearestFilter,
    NearestMipmapLinearFilter,
    NearestMipmapNearestFilter,
    RepeatWrapping,
    Texture
} from 'three';
import type { BufferGeometry, Material, Object3D, SkinnedMesh, TextureFilter, Wrapping } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTFLoaderPlugin, GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { decodeDataUri, inspectGlb, isDataUri } from './glb.js';
import type { ModelRefusal } from './glb.js';

/** The name of the `GLTFLoader` plug-in that decodes a model's images without a URL (`bitmapImages`) */
export const BITMAP_IMAGES_PLUGIN = 'stateui_bitmap_images';

/** The options `createImageBitmap` decodes a model's images with (G3.1): as stored, so three.js uploads them unchanged */
export const BITMAP_OPTIONS: ImageBitmapOptions = { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' };

/** The texture filters and wrap modes of a glTF sampler, by their WebGL numbers (as `GLTFLoader` maps them) */
const FILTERS: Readonly<Record<number, TextureFilter>> = {
    9728: NearestFilter,
    9729: LinearFilter,
    9984: NearestMipmapNearestFilter,
    9985: LinearMipmapNearestFilter,
    9986: NearestMipmapLinearFilter,
    9987: LinearMipmapLinearFilter
};
const WRAPPINGS: Readonly<Record<number, Wrapping>> = { 33071: ClampToEdgeWrapping, 33648: MirroredRepeatWrapping, 10497: RepeatWrapping };

/** Why a model was not drawn after its bytes were read: refused before parsing (`ModelRefusal`) or not parsed (`invalid_glb`) */
export class ModelError extends Error {
    override readonly name = 'ModelError';

    constructor(
        readonly code: ModelRefusal['code'] | 'invalid_glb',
        readonly detail: string
    ) {
        super(`${code}: ${detail}`);
    }
}

type JsonRecord = Record<string, unknown>;
const isObject = (value: unknown): value is JsonRecord => typeof value === 'object' && value !== null && !Array.isArray(value);
const entryOf = (list: unknown, index: unknown): JsonRecord | undefined => (Array.isArray(list) && typeof index === 'number' && isObject(list[index]) ? list[index] : undefined);

/**
 * A `GLTFLoader` plug-in that loads a model's images and `data:` buffers with no URL, so nothing is fetched (the frame's
 * policy has `connect-src 'none'` and `img-src data:`, and the loader's own route for an image inside a GLB is a `blob:`
 * URL it fetches). G3.1's route (c): an image's bytes (its `bufferView`, or a base64 `data:` URI) are wrapped in a
 * `Blob` and decoded with `createImageBitmap` (`BITMAP_OPTIONS`), which neither `img-src` nor `connect-src` governs, and
 * the `Texture` is made from the `ImageBitmap` with `flipY = false` and the texture's sampler, as the loader makes it. A
 * `data:` buffer is decoded in place of the loader's fetch. An image that does not decode leaves its texture out (the
 * loader does the same), so the model draws without it.
 *
 * Textures that name their image through `EXT_texture_webp` or `EXT_texture_avif` are taken by the loader's own
 * plug-ins first and draw without their image
 */
export function bitmapImages(parser: GLTFParser): GLTFLoaderPlugin {
    const json = parser.json as JsonRecord;
    /** One decode per image, shared by the textures that use it with other samplers */
    const bitmaps = new Map<number, Promise<ImageBitmap>>();

    const bytesOf = (image: JsonRecord): Promise<{ bytes: BlobPart; type: string }> => {
        if (typeof image.bufferView === 'number') {
            return (parser.getDependency('bufferView', image.bufferView) as Promise<ArrayBuffer>).then((bytes) => ({ bytes, type: typeof image.mimeType === 'string' ? image.mimeType : '' }));
        }
        const decoded = typeof image.uri === 'string' ? decodeDataUri(image.uri) : undefined;
        if (decoded === undefined) return Promise.reject(new Error('The image is neither in a bufferView nor a data: URI'));
        return Promise.resolve({ bytes: decoded.bytes as Uint8Array<ArrayBuffer>, type: typeof image.mimeType === 'string' ? image.mimeType : decoded.type });
    };

    const bitmapOf = (sourceIndex: number, image: JsonRecord): Promise<ImageBitmap> => {
        let bitmap = bitmaps.get(sourceIndex);
        if (bitmap === undefined) {
            bitmap = bytesOf(image).then(({ bytes, type }) => createImageBitmap(new Blob([bytes], { type }), BITMAP_OPTIONS));
            bitmaps.set(sourceIndex, bitmap);
        }
        return bitmap;
    };

    return {
        name: BITMAP_IMAGES_PLUGIN,
        loadBufferView(index) {
            const view = entryOf(json.bufferViews, index);
            const buffer = entryOf(json.buffers, view?.buffer);
            if (view === undefined || buffer === undefined || typeof buffer.uri !== 'string' || !isDataUri(buffer.uri)) return null;
            const decoded = decodeDataUri(buffer.uri);
            if (decoded === undefined) return Promise.reject(new Error(`buffers[${String(view.buffer)}] is not a base64 data: URI`));
            const start = typeof view.byteOffset === 'number' ? view.byteOffset : 0;
            const length = typeof view.byteLength === 'number' ? view.byteLength : 0;
            return Promise.resolve(decoded.bytes.slice(start, start + length).buffer);
        },
        loadTexture(textureIndex) {
            const textureDef = entryOf(json.textures, textureIndex);
            const sourceIndex = textureDef?.source;
            const image = entryOf(json.images, sourceIndex);
            if (textureDef === undefined || typeof sourceIndex !== 'number' || image === undefined) return null;
            const sampler = entryOf(json.samplers, textureDef.sampler) ?? {};
            const texture = bitmapOf(sourceIndex, image).then(
                (bitmap) => {
                    const texture = new Texture(bitmap);
                    texture.flipY = false;
                    texture.name = (typeof textureDef.name === 'string' && textureDef.name) || (typeof image.name === 'string' && image.name) || '';
                    texture.magFilter = (FILTERS[sampler.magFilter as number] ?? LinearFilter) as typeof texture.magFilter;
                    texture.minFilter = FILTERS[sampler.minFilter as number] ?? LinearMipmapLinearFilter;
                    texture.wrapS = WRAPPINGS[sampler.wrapS as number] ?? RepeatWrapping;
                    texture.wrapT = WRAPPINGS[sampler.wrapT as number] ?? RepeatWrapping;
                    texture.generateMipmaps = texture.minFilter !== NearestFilter && texture.minFilter !== LinearFilter;
                    texture.userData.mimeType = image.mimeType;
                    texture.needsUpdate = true;
                    parser.associations.set(texture, { textures: textureIndex });
                    return texture;
                },
                () => null
            );
            return texture as Promise<Texture>;
        }
    };
}

/**
 * Parses a GLB's bytes into a three.js object, with `GLTFLoader.parse` (no URL, so no fetch) and the `bitmapImages`
 * plug-in. The model is checked first (`inspectGlb`): one the frame cannot load rejects with a `ModelError` naming why
 * (`not_glb`, `draco`, `meshopt`, `ktx2`, `external_uri`), and one three.js cannot parse with `invalid_glb`. The
 * object is the file's default scene as it is: nothing is centred or scaled. Its animation clips are kept in
 * `userData.animations` for the clips of G3.9b
 */
export async function parseModel(data: ArrayBuffer): Promise<Object3D> {
    const inspection = inspectGlb(data);
    if (!inspection.ok) throw new ModelError(inspection.refusal.code, inspection.refusal.detail);
    const loader = new GLTFLoader();
    loader.register(bitmapImages);
    let gltf;
    try {
        gltf = await loader.parseAsync(data, '');
    } catch (error) {
        throw new ModelError('invalid_glb', error instanceof Error ? error.message : String(error));
    }
    const { scene } = gltf;
    scene.userData.animations = gltf.animations;
    return scene;
}

/**
 * Frees what a parsed model holds: every geometry, material and texture below it (each once, as a model may share
 * them), the bone textures of its skins, and the `ImageBitmap`s its textures were made from
 */
export function disposeModel(model: Object3D): void {
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    model.traverse((object) => {
        const drawn = object as Object3D & { geometry?: BufferGeometry; material?: Material | Material[] };
        if (drawn.geometry?.isBufferGeometry === true) geometries.add(drawn.geometry);
        for (const material of Array.isArray(drawn.material) ? drawn.material : drawn.material === undefined ? [] : [drawn.material]) materials.add(material);
        if ((object as SkinnedMesh).isSkinnedMesh === true) (object as SkinnedMesh).skeleton.dispose();
    });
    const textures = new Set<Texture>();
    for (const material of materials) {
        for (const value of Object.values(material) as unknown[]) {
            if ((value as Texture | null)?.isTexture === true) textures.add(value as Texture);
        }
        material.dispose();
    }
    for (const geometry of geometries) geometry.dispose();
    for (const texture of textures) {
        texture.dispose();
        const image = texture.image as { close?: () => void } | null;
        if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close?.();
    }
    model.removeFromParent();
}
