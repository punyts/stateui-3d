import { SRGBColorSpace, Texture } from 'three';
import type { MeshStandardMaterial } from 'three';
import { BITMAP_OPTIONS } from './models.js';
import type { ModelHooks } from './scene.js';
import type { JsonValue, Node3dKind } from './tree.js';

/** The types of the app's files a `material.map` may be: the pictures the `mesh` shape's `fileRef` validator takes */
export const TEXTURE_FILE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/**
 * The options `createImageBitmap` decodes a `material.map` picture with: as stored (`BITMAP_OPTIONS`), but turned upside
 * down, since three.js's primitives put `v = 1` at the top and WebGL does not flip an `ImageBitmap` on upload (its
 * `flipY` is ignored for one), so the texture is made with `flipY = false` from a bitmap already flipped
 */
export const MAP_BITMAP_OPTIONS: ImageBitmapOptions = { ...BITMAP_OPTIONS, imageOrientation: 'flipY' };

/**
 * What a `material.map` value asks for: nothing (unset), a picture file (`file`, by its id and type), or a value the
 * renderer does not read (`refused`: not a file reference, or a file of another type)
 */
export type MapSource = { readonly kind: 'none' } | { readonly kind: 'file'; readonly id: string; readonly type: string } | { readonly kind: 'refused' };

/** The source of a `material` value's `map` (G3.7c). Pure */
export function mapSource(material: JsonValue | undefined): MapSource {
    const map = typeof material === 'object' && material !== null && !Array.isArray(material) ? material.map : undefined;
    if (map === undefined || map === null || map === '') return { kind: 'none' };
    if (typeof map !== 'object' || Array.isArray(map) || typeof map.id !== 'string' || map.id === '') return { kind: 'refused' };
    const type = typeof map.type === 'string' ? map.type.toLowerCase() : '';
    return TEXTURE_FILE_TYPES.includes(type) ? { kind: 'file', id: map.id, type } : { kind: 'refused' };
}

/** One `map` read or drawn for one owner: what it asked for, the material it goes on, the abort of its read and its texture */
interface MapLoad {
    /** The id of the file, or `refused` for a value that is not read */
    readonly key: string;
    readonly abort: AbortController;
    material: MeshStandardMaterial;
    texture?: Texture;
    done: boolean;
}

/** The code of a failed file read: its own `code` when it has one, else `internal` */
const readCode = (error: unknown): string => {
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
    return typeof code === 'string' && code !== '' ? code : 'internal';
};

/**
 * The textures of the `material.map`s of a scene (G3.7c), one per owner: a `mesh` node by its path, or a `repeat3d`
 * by its path, whose instances share one material and so the first copy's map. A map's file is read with the scene's
 * `readFile` (no URL), decoded to an `ImageBitmap` (`MAP_BITMAP_OPTIONS`) and made into an sRGB `Texture` set as the
 * material's `map`. Until it is drawn, and when it cannot be, the material shows its colour only. The same file again
 * changes nothing; another file, or none, frees the texture and its bitmap (and aborts a read under way). A map that is
 * not a picture file, a failed read (its code: `not_found`, `offline`, ...) and bytes that do not decode
 * (`not_an_image`) are told to `onIssue` as `file` issues once per value, and the scene draws on
 */
export class MapTextures {
    private readonly loads = new Map<string, MapLoad>();

    constructor(private readonly hooks: ModelHooks = {}) {}

    /** The maps whose file is being read or decoded: the scene's `drawn()` waits for them */
    get loading(): number {
        let loading = 0;
        for (const load of this.loads.values()) if (!load.done) loading += 1;
        return loading;
    }

    /** The maps drawn */
    get loaded(): number {
        let loaded = 0;
        for (const load of this.loads.values()) if (load.texture !== undefined) loaded += 1;
        return loaded;
    }

    /**
     * Sets the `map` of an owner's material from its `material` value: keeps the texture of the same file (and puts it
     * on `material`, which may be another object than before), else frees it and reads the new file
     */
    set(owner: string, node: Node3dKind, value: JsonValue | undefined, material: MeshStandardMaterial): void {
        const source = mapSource(value);
        const key = source.kind === 'file' ? source.id : source.kind;
        const current = this.loads.get(owner);
        if (current !== undefined && current.key === key) {
            current.material = material;
            setMap(material, current.texture ?? null);
            return;
        }
        this.release(owner);
        setMap(material, null);
        if (source.kind === 'none') return;
        const { readFile, onIssue, onSettled } = this.hooks;
        const load: MapLoad = { key, abort: new AbortController(), material, done: true };
        this.loads.set(owner, load);
        if (source.kind === 'refused') {
            onIssue?.({ kind: 'file', path: owner, node, reason: 'unsupported_type' });
            return;
        }
        if (readFile === undefined) {
            onIssue?.({ kind: 'file', path: owner, node, reason: 'offline' });
            return;
        }
        load.done = false;
        const wanted = (): boolean => !load.abort.signal.aborted && this.loads.get(owner) === load;
        const settle = (reason?: string): void => {
            if (reason !== undefined) onIssue?.({ kind: 'file', path: owner, node, reason });
            load.done = true;
            onSettled?.();
        };
        new Promise<ArrayBuffer>((resolve) => resolve(readFile(source.id, load.abort.signal))).then(
            (data) =>
                createImageBitmap(new Blob([data], { type: source.type }), MAP_BITMAP_OPTIONS).then(
                    (bitmap) => {
                        if (!wanted()) {
                            bitmap.close();
                            return;
                        }
                        const texture = new Texture(bitmap);
                        texture.flipY = false;
                        texture.colorSpace = SRGBColorSpace;
                        texture.needsUpdate = true;
                        load.texture = texture;
                        setMap(load.material, texture);
                        settle();
                    },
                    () => {
                        if (wanted()) settle('not_an_image');
                    }
                ),
            (error: unknown) => {
                if (wanted()) settle(readCode(error));
            }
        );
    }

    /** Stops the read of an owner's map and frees its texture and bitmap, taking it off the material */
    release(owner: string): void {
        const load = this.loads.get(owner);
        if (load === undefined) return;
        this.loads.delete(owner);
        load.abort.abort();
        if (load.texture === undefined) return;
        if (load.material.map === load.texture) setMap(load.material, null);
        disposeTexture(load.texture);
    }

    /** Frees every map */
    clear(): void {
        for (const owner of [...this.loads.keys()]) this.release(owner);
    }
}

/** Puts a texture on a material, or takes it off; a map coming or going compiles the material's program again */
function setMap(material: MeshStandardMaterial, texture: Texture | null): void {
    if (material.map === texture) return;
    if ((material.map === null) !== (texture === null)) material.needsUpdate = true;
    material.map = texture;
}

/** Frees a texture on the GPU and closes the `ImageBitmap` it was made from */
function disposeTexture(texture: Texture): void {
    texture.dispose();
    const image = texture.image as { close?: () => void } | null;
    if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close?.();
}
