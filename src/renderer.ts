import { WebGLRenderer } from 'three';

/** The highest device pixel ratio a scene draws at; a denser screen is drawn at 2 and scaled */
export const MAX_PIXEL_RATIO = 2;
/** The size of the canvas while the host has none (the default size of a canvas element) */
export const FALLBACK_SIZE = { width: 300, height: 150 } as const;

/** Why a scene cannot be made: `no_webgl` when the browser gives no WebGL context */
export type Scene3dErrorCode = 'no_webgl';

/**
 * The error `createScene3d` throws when it cannot draw. The `scene3d` component turns it into its `_fallback` text and
 * one `SUI-RUN-3D` with the code as the reason. Its `name` is `Scene3dError`, so a feeder that loaded the package as
 * the runtime chunk (another realm of classes) knows it with `isScene3dError`
 */
export class Scene3dError extends Error {
    override readonly name = 'Scene3dError';

    constructor(
        readonly code: Scene3dErrorCode,
        message: string
    ) {
        super(message);
    }
}

/** True for a `Scene3dError`, also one made by another copy of the package */
export function isScene3dError(value: unknown): value is Scene3dError {
    if (value instanceof Scene3dError) return true;
    const error = value as { name?: unknown; code?: unknown } | null;
    return typeof error === 'object' && error !== null && error.name === 'Scene3dError' && typeof error.code === 'string';
}

/** The canvas of a scene and the WebGL renderer that draws into it */
export interface SceneRenderer {
    readonly canvas: HTMLCanvasElement;
    readonly webgl: WebGLRenderer;
    /** The size last set, in CSS pixels */
    readonly size: { readonly width: number; readonly height: number };
    /** Sets the drawing buffer to a size in CSS pixels (at most `MAX_PIXEL_RATIO` device pixels each); true when it changed */
    resize(width: number, height: number): boolean;
    /** Frees the renderer and its context (a page keeps at most 16, G3.1) and removes the canvas */
    dispose(): void;
}

/**
 * Makes a canvas in `host` and a `WebGLRenderer` on it: antialiased, with an alpha channel (a scene with no background
 * shows the host's), pixel ratio the device's but at most `MAX_PIXEL_RATIO`. The canvas fills the host through CSSOM
 * writes, and `resize` calls `setSize(w, h, false)`, which writes no `style` attribute (the frame's policy refuses one
 * written as text). Throws a `Scene3dError` (`no_webgl`) and removes the canvas when the browser gives no WebGL context
 */
export function createRenderer(host: Element): SceneRenderer {
    const doc = host.ownerDocument;
    const view = doc.defaultView;
    const canvas = doc.createElement('canvas');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    host.append(canvas);

    let webgl: WebGLRenderer;
    try {
        webgl = new WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch (error) {
        canvas.remove();
        throw new Scene3dError('no_webgl', `WebGL is not available: ${error instanceof Error ? error.message : String(error)}`);
    }
    webgl.setPixelRatio(Math.min(view?.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    let size: { width: number; height: number } = { width: 0, height: 0 };

    return {
        canvas,
        webgl,
        get size() {
            return size;
        },
        resize(width, height) {
            const next = width > 0 && height > 0 ? { width, height } : FALLBACK_SIZE;
            const ratio = Math.min(view?.devicePixelRatio || 1, MAX_PIXEL_RATIO);
            if (next.width === size.width && next.height === size.height && ratio === webgl.getPixelRatio()) return false;
            size = { width: next.width, height: next.height };
            webgl.setPixelRatio(ratio);
            // false: the canvas size in CSS is the host's (set above through CSSOM), never a style attribute
            webgl.setSize(size.width, size.height, false);
            return true;
        },
        dispose() {
            webgl.dispose();
            // Frees the context now, not when the canvas is collected: a page keeps at most 16 (G3.1)
            webgl.forceContextLoss();
            canvas.remove();
        }
    };
}
