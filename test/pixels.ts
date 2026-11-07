import { expect } from 'vitest';
import type { Scene3d } from '../src/scene3d.ts';
import type { JsonValue, Node3dKind, Scene3dSettings, Scene3dTree } from '../src/tree.ts';

/** The owner's tolerance for pixels drawn by software WebGL: 12 per channel (epic 3 Decisions) */
export const TOLERANCE = 12;
export const ROOT = '$.app.children';

/** A node of the scene's top level, its children's paths under it */
export function node(kind: Node3dKind, key: string, properties: Record<string, JsonValue> = {}, children: Scene3dTree[] = []): Scene3dTree {
    const path = `${ROOT}.${key}`;
    return { kind, key, path, properties, children: children.map((child) => ({ ...child, path: `${path}.children.${child.key}` })) };
}

/** A camera at z = 5 looking at the origin */
export const front = (properties: Record<string, JsonValue> = {}): Scene3dTree => node('camera', 'eye', { position: [0, 0, 5], target: [0, 0, 0], ...properties });

/** Every pixel of the canvas as RGBA rows from the bottom, read in the task of the frame (the buffer is not kept after it) */
export function pixels(host: HTMLElement): { width: number; height: number; data: Uint8Array } {
    const canvas = host.querySelector('canvas');
    const gl = canvas?.getContext('webgl2');
    if (!canvas || !gl) throw new Error('No WebGL canvas');
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const data = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return { width, height, data };
}

/** The colour at a point of the canvas, as fractions of its width and height from the top-left */
export function pixelAt(host: HTMLElement, fx = 0.5, fy = 0.5): number[] {
    const { width, height, data } = pixels(host);
    const x = Math.min(width - 1, Math.floor(width * fx));
    const y = Math.min(height - 1, Math.floor(height * (1 - fy)));
    const at = (y * width + x) * 4;
    return [...data.slice(at, at + 4)];
}

export function expectColor(actual: readonly number[], expected: readonly number[]): void {
    expect(actual.length, `got ${actual.join(', ')}`).toBeGreaterThanOrEqual(expected.length);
    expected.forEach((value, channel) => {
        expect(Math.abs((actual[channel] ?? 0) - value), `channel ${channel} of [${actual.join(', ')}], expected [${expected.join(', ')}]`).toBeLessThanOrEqual(TOLERANCE);
    });
}

/** True when two colours differ by more than the tolerance in some channel */
export const differs = (a: readonly number[], b: readonly number[]): boolean => a.some((value, channel) => Math.abs(value - (b[channel] ?? 0)) > TOLERANCE);

/** Updates the scene and waits for the frame it asked for */
export async function draw(scene: Scene3d, tree: Scene3dTree[], settings?: Scene3dSettings): Promise<void> {
    scene.update(tree, settings);
    await scene.drawn();
}

/** The channels of a CSS colour, drawn on a 2D canvas */
export function rgbOf(css: string): number[] {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) throw new Error('No 2D canvas');
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
}
