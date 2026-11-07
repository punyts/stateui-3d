import { BufferGeometry, Box3, CanvasTexture, InterleavedBuffer, InterleavedBufferAttribute, SRGBColorSpace, Sprite, SpriteMaterial, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { ColorResolver, JsonValue } from './tree.js';

/** The height in texels of the font a label's text is drawn with on its canvas (its texture) */
export const LABEL_FONT_PX = 64;
/** The height of a label's box in ems: the text is drawn in the middle of it */
export const LABEL_LINE_HEIGHT = 1.4;
/** The room left and right of a label's text, in ems */
export const LABEL_PADDING = 0.2;
/**
 * The widest a label's canvas (its texture) is drawn, in texels: a longer text is cut off there (WebGL 2 guarantees
 * textures of 2,048 texels a side)
 */
export const LABEL_MAX_WIDTH = 2048;
/**
 * The characters of a text that are measured and drawn: a text this long is far wider than `LABEL_MAX_WIDTH` at
 * `LABEL_FONT_PX`, so cutting it here changes nothing on screen and keeps a very long text cheap
 */
export const LABEL_MAX_CHARS = 512;
/** The `fontSize` of a label that sets none, in scene units */
export const DEFAULT_LABEL_FONT_SIZE = 0.3;
/** The largest `fontSize`, in scene units (the `label3d` shape's range) */
export const MAX_LABEL_FONT_SIZE = 1000;
/** The colour of a label when neither its `color` nor the scene's `labelColor` resolves */
export const DEFAULT_LABEL_COLOR = '#000000';
/** The font family of a label when the host gives none */
export const DEFAULT_LABEL_FONT = 'sans-serif';

/**
 * The text a `label3d` draws from its `_text`: a string with its line breaks and tabs as spaces, cut at
 * `LABEL_MAX_CHARS`; anything else is no text. Pure
 */
export function labelText(value: JsonValue | undefined): string {
    if (typeof value !== 'string') return '';
    const text = value.replace(/[\r\n\t\f\v]+/g, ' ');
    return text.trim() === '' ? '' : Array.from(text).slice(0, LABEL_MAX_CHARS).join('');
}

/** A label's `fontSize` in scene units: a positive number up to `MAX_LABEL_FONT_SIZE`, else the default. Pure */
export function labelFontSize(value: JsonValue | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, MAX_LABEL_FONT_SIZE) : DEFAULT_LABEL_FONT_SIZE;
}

/**
 * The canvas a label's text is drawn on, in texels, for a text of `textWidth` texels at `LABEL_FONT_PX`: the line box
 * high and the text with its padding wide, at most `LABEL_MAX_WIDTH` (a wider text is cut off, not an error). Pure
 */
export function labelCanvasSize(textWidth: number): { readonly width: number; readonly height: number } {
    const padding = Math.ceil(LABEL_FONT_PX * LABEL_PADDING);
    const wide = Number.isFinite(textWidth) && textWidth > 0 ? Math.ceil(textWidth) : 0;
    return { width: Math.min(LABEL_MAX_WIDTH, Math.max(1, wide + 2 * padding)), height: Math.ceil(LABEL_FONT_PX * LABEL_LINE_HEIGHT) };
}

/** The CSS `font` a label's text is drawn with, for a font family */
export const labelFont = (family: string): string => `${LABEL_FONT_PX}px ${family}`;

/** What a label draws: its text, the font family and the CSS colour; a change of any of them draws its canvas again */
interface LabelLook {
    readonly text: string;
    readonly family: string;
    readonly color: string;
}

/** One `label3d` node: the group of its node, and once it has text the sprite and canvas it draws */
interface Label {
    readonly group: Object3D;
    properties: Readonly<Record<string, JsonValue>>;
    sprite?: Sprite;
    canvas?: HTMLCanvasElement;
    /** What the canvas shows, so the same text, font and colour are not drawn again */
    look?: LabelLook;
    /** The canvas's width over its height */
    aspect: number;
}

/** What the labels of a scene are drawn with */
export interface LabelHooks {
    /** The document the canvases are made in; without it (no DOM) no label draws */
    readonly doc?: Document;
    /**
     * The font family labels are drawn in: the page font, as the host's computed `font-family`. Read once per redraw
     * of the labels (a `restyle`, a font that finished loading); unset or empty is `sans-serif`
     */
    readonly readFont?: () => string | undefined;
    /** The colour of a label with no `color` (the scene's `labelColor`, a literal or a token reference) */
    readonly defaultColor?: () => JsonValue | undefined;
}

/**
 * The quad of a label's sprite: as three.js's own sprite quad, but one per label, so it is freed with the label (the
 * shared one would stay counted on the GPU), and with bounds a cube as wide as the label: the sprite turns to face the
 * camera, so its bounds (the scene's `boundsOf`, its proxy, the default camera's framing) hold it from every side
 */
function spriteGeometry(): BufferGeometry {
    const geometry = new BufferGeometry();
    const buffer = new InterleavedBuffer(new Float32Array([-0.5, -0.5, 0, 0, 0, 0.5, -0.5, 0, 1, 0, 0.5, 0.5, 0, 1, 1, -0.5, 0.5, 0, 0, 1]), 5);
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute('position', new InterleavedBufferAttribute(buffer, 3, 0, false));
    geometry.setAttribute('uv', new InterleavedBufferAttribute(buffer, 2, 3, false));
    geometry.boundingBox = new Box3(new Vector3(-0.5, -0.5, -0.5), new Vector3(0.5, 0.5, 0.5));
    return geometry;
}

/**
 * The `label3d` nodes of a scene (G3.6b), by path: each draws its `_text` with `fillText` on a canvas, never as markup,
 * in the page font (`readFont`) and its `color` (else the scene's `labelColor`, else black), resolved with the scene's
 * colour resolver, and shows the canvas as an sRGB texture on a `Sprite` in its node's group, so it always faces the
 * camera. `fontSize` is the font's size in scene units; the sprite is `LABEL_LINE_HEIGHT` of it high and as wide as the
 * text, so the node's `position` is the middle of the text. The canvas is drawn again only when the text, the font or
 * the colour changes (a new texture: one of another size cannot be uploaded over the old), and the texture, the
 * sprite's material and its quad are freed when the label goes or its text empties. An empty `_text` draws nothing and
 * reports nothing; a text wider than `LABEL_MAX_WIDTH` texels is cut off there
 */
export class Labels {
    private readonly labels = new Map<string, Label>();
    /** The font family read for this pass, until the next `restyle` or `redraw` */
    private family: string | undefined;

    constructor(
        private readonly resolve: ColorResolver,
        private readonly hooks: LabelHooks = {}
    ) {}

    /** The labels that draw a text */
    get drawn(): number {
        let drawn = 0;
        for (const label of this.labels.values()) if (label.sprite !== undefined) drawn += 1;
        return drawn;
    }

    /** The number of `label3d` nodes */
    get size(): number {
        return this.labels.size;
    }

    /** The canvas the label with this path draws its text on, or undefined when it draws none (for tests) */
    canvasOf(path: string): HTMLCanvasElement | undefined {
        return this.labels.get(path)?.canvas;
    }

    /** The sprite of the label with this path, or undefined when it draws none (for tests) */
    spriteOf(path: string): Sprite | undefined {
        return this.labels.get(path)?.sprite;
    }

    /** Draws a label node's properties in its group: again only when its text, font or colour changed */
    set(path: string, group: Object3D, properties: Readonly<Record<string, JsonValue>>): void {
        let label = this.labels.get(path);
        if (label === undefined || label.group !== group) {
            this.release(path);
            label = { group, properties, aspect: 1 };
            this.labels.set(path, label);
        }
        label.properties = properties;
        this.draw(label);
    }

    /** Resolves each label's font and colour again (a theme or mode change) and draws those that changed */
    restyle(): void {
        this.family = undefined;
        for (const label of this.labels.values()) this.draw(label);
    }

    /** Draws every label's canvas again, the same text too (a font finished loading: the same family draws other glyphs) */
    redraw(): void {
        this.family = undefined;
        for (const label of this.labels.values()) {
            label.look = undefined;
            this.draw(label);
        }
    }

    /** Frees a label's texture, material and quad and forgets it */
    release(path: string): void {
        const label = this.labels.get(path);
        if (label === undefined) return;
        this.labels.delete(path);
        this.empty(label);
    }

    /** Frees every label */
    clear(): void {
        for (const path of [...this.labels.keys()]) this.release(path);
    }

    private fontFamily(): string {
        this.family ??= this.hooks.readFont?.()?.trim() || DEFAULT_LABEL_FONT;
        return this.family;
    }

    private colorOf(properties: Readonly<Record<string, JsonValue>>): string {
        const own = properties.color;
        const css = own === undefined || own === null || own === '' ? undefined : this.resolve(own);
        if (css !== undefined) return css;
        const fallback = this.hooks.defaultColor?.();
        return (fallback === undefined || fallback === null || fallback === '' ? undefined : this.resolve(fallback)) ?? DEFAULT_LABEL_COLOR;
    }

    private draw(label: Label): void {
        const text = labelText(label.properties._text);
        const doc = this.hooks.doc;
        if (text === '' || doc === undefined) {
            this.empty(label);
            return;
        }
        const look: LabelLook = { text, family: this.fontFamily(), color: this.colorOf(label.properties) };
        const same = label.look !== undefined && label.look.text === look.text && label.look.family === look.family && label.look.color === look.color;
        if (!same) this.paint(label, look, doc);
        const sprite = label.sprite;
        if (sprite === undefined) return;
        const height = labelFontSize(label.properties.fontSize) * LABEL_LINE_HEIGHT;
        // z as wide as x: the bounds are a cube that holds the sprite however it turns (`spriteGeometry`)
        sprite.scale.set(height * label.aspect, height, height * label.aspect);
    }

    /** Draws the text on a new canvas and puts it on the sprite as a new texture, freeing the old one */
    private paint(label: Label, look: LabelLook, doc: Document): void {
        const canvas = doc.createElement('canvas');
        const context = canvas.getContext('2d');
        if (context === null) {
            this.empty(label);
            return;
        }
        const font = labelFont(look.family);
        context.font = font;
        const { width, height } = labelCanvasSize(context.measureText(look.text).width);
        canvas.width = width;
        canvas.height = height;
        // Setting the size resets the context: the font again, and the text is never markup
        context.font = font;
        context.textAlign = 'left';
        context.textBaseline = 'middle';
        context.fillStyle = DEFAULT_LABEL_COLOR;
        context.fillStyle = look.color;
        context.fillText(look.text, Math.ceil(LABEL_FONT_PX * LABEL_PADDING), height / 2);
        const texture = new CanvasTexture(canvas);
        texture.colorSpace = SRGBColorSpace;
        if (label.sprite === undefined) {
            const material = new SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
            const sprite = new Sprite(material);
            sprite.geometry = spriteGeometry();
            label.sprite = sprite;
            label.group.add(sprite);
        } else {
            const material = label.sprite.material;
            material.map?.dispose();
            material.map = texture;
        }
        label.canvas = canvas;
        label.look = look;
        label.aspect = width / height;
    }

    /** Takes a label's sprite off its group and frees its texture, material and quad */
    private empty(label: Label): void {
        const { sprite } = label;
        label.sprite = undefined;
        label.canvas = undefined;
        label.look = undefined;
        if (sprite === undefined) return;
        sprite.removeFromParent();
        sprite.material.map?.dispose();
        sprite.material.dispose();
        sprite.geometry.dispose();
    }
}
