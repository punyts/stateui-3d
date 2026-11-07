import { Color, MeshStandardMaterial } from 'three';
import type { ColorResolver, JsonValue } from './tree.js';

/** The colour of a `mesh` whose material sets none, or one that resolves to nothing */
export const DEFAULT_MESH_COLOR = '#ffffff';
/** The metalness and roughness of a material that sets none: a matte, non-metal surface */
export const DEFAULT_METALNESS = 0;
export const DEFAULT_ROUGHNESS = 1;

/** A `mesh`'s `material` with defaults, numbers clamped to 0..1 and colours resolved to CSS colours */
export interface MaterialParams {
    readonly color: string;
    readonly metalness: number;
    readonly roughness: number;
    readonly opacity: number;
    /** The colour the surface gives off by itself; undefined for none (black) */
    readonly emissive: string | undefined;
}

const isObject = (value: JsonValue | undefined): value is { [key: string]: JsonValue } => typeof value === 'object' && value !== null && !Array.isArray(value);

const unit = (value: JsonValue | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;

/**
 * The parameters of a `mesh`'s `material` value: `color` resolved by `resolve` (white when unset or unresolved),
 * `metalness`, `roughness` and `opacity` kept in 0..1 (defaults 0, 1 and 1), `emissive` resolved (none when unset).
 * `map` (a texture file) is G3.7c and is not read here. Pure, apart from what `resolve` does
 */
export function materialParams(value: JsonValue | undefined, resolve: ColorResolver): MaterialParams {
    const material = isObject(value) ? value : {};
    const colour = (name: string): string | undefined => {
        const raw = material[name];
        return raw === undefined || raw === null || raw === '' ? undefined : resolve(raw);
    };
    return {
        color: colour('color') ?? DEFAULT_MESH_COLOR,
        metalness: unit(material.metalness, DEFAULT_METALNESS),
        roughness: unit(material.roughness, DEFAULT_ROUGHNESS),
        opacity: unit(material.opacity, 1),
        emissive: colour('emissive')
    };
}

/** Makes the physically based material of a mesh */
export function createMaterial(params: MaterialParams, convert: (css: string) => Color | undefined): MeshStandardMaterial {
    const material = new MeshStandardMaterial();
    applyMaterial(material, params, convert);
    return material;
}

/** Sets a mesh's material from its parameters; a change of transparency recompiles its program */
export function applyMaterial(material: MeshStandardMaterial, params: MaterialParams, convert: (css: string) => Color | undefined): void {
    material.color.copy(convert(params.color) ?? new Color(DEFAULT_MESH_COLOR));
    material.metalness = params.metalness;
    material.roughness = params.roughness;
    material.opacity = params.opacity;
    const transparent = params.opacity < 1;
    if (material.transparent !== transparent) {
        material.transparent = transparent;
        material.needsUpdate = true;
    }
    material.emissive.copy((params.emissive === undefined ? undefined : convert(params.emissive)) ?? new Color(0x000000));
}

const SIMPLE_COLOR = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-z]+)$/i;

/**
 * Turns CSS colours into three.js colours (in its linear working space; the alpha is dropped). Hex, `rgb()`, `hsl()`
 * and names are parsed by three.js; any other form a theme may hold (`oklch()`, `color-mix()`, `#rrggbbaa`) is drawn
 * once on a 1 by 1 canvas of `doc` and read back. Gives undefined for a value that is no colour. Remembers each answer
 */
export function createColorConverter(doc: Document | undefined): (css: string) => Color | undefined {
    const known = new Map<string, Color | undefined>();
    let ctx: CanvasRenderingContext2D | null | undefined;
    const viaCanvas = (css: string): Color | undefined => {
        if (doc === undefined) return undefined;
        if (ctx === undefined) {
            const canvas = doc.createElement('canvas');
            canvas.width = 1;
            canvas.height = 1;
            ctx = canvas.getContext('2d', { willReadFrequently: true });
        }
        if (ctx === null) return undefined;
        // A value that is no colour leaves fillStyle as it was; the sentinel shows that
        ctx.fillStyle = '#010203';
        ctx.fillStyle = css;
        if (ctx.fillStyle === '#010203' && css.trim().toLowerCase() !== '#010203') return undefined;
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillRect(0, 0, 1, 1);
        const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
        return new Color().setRGB(r / 255, g / 255, b / 255, 'srgb');
    };
    return (css) => {
        const value = css.trim();
        if (known.has(value)) return known.get(value)?.clone();
        let colour: Color | undefined;
        if (SIMPLE_COLOR.test(value)) {
            const parsed = new Color(-1, -1, -1);
            // setStyle warns and leaves the colour as it was for a value it does not know
            const warn = console.warn;
            console.warn = () => undefined;
            try {
                parsed.setStyle(value);
            } finally {
                console.warn = warn;
            }
            colour = parsed.r === -1 ? viaCanvas(value) : parsed;
        } else {
            colour = viaCanvas(value);
        }
        known.set(value, colour);
        return colour?.clone();
    };
}
