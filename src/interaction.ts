import { Vector4 } from 'three';
import type { Box3, Camera } from 'three';
import type { Scene3dTree } from './tree.js';

/**
 * The pure parts of `press` and `hover` on 3D nodes (G3.8 of the graphics epic 3): which nodes get a proxy, where a
 * node's box is on screen, and when a pointer gesture is a press. They run in Node, with no canvas and no WebGL; the
 * scene (`scene3d.ts`) and its proxies (`proxies.ts`) use them.
 */

/**
 * How far, in CSS pixels, the pointer may move between its press and its release for that to still be a press: a
 * pointer that moves farther is a drag (with orbit or pan controls, a drag that moves the camera), which raises nothing
 */
export const PRESS_SLOP = 4;

/** A box on the canvas in CSS pixels from its top-left corner */
export interface ScreenBox {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
}

/** True when a node is drawn: neither `visible: false` nor `hidden: true` (what `scene.ts` and `instances.ts` draw) */
export const isShownNode = (tree: Scene3dTree): boolean => tree.properties.visible !== false && tree.properties.hidden !== true;

/**
 * The nodes that get a proxy button, in tree order (a `group3d` before the nodes inside it, a `repeat3d` before its
 * copies, in record order): every node with `interactive: true` that is drawn. A node that is not drawn hides what is
 * below it too, as it does on screen. Pure
 */
export function interactiveNodes(trees: readonly Scene3dTree[]): Scene3dTree[] {
    const found: Scene3dTree[] = [];
    const walk = (nodes: readonly Scene3dTree[]): void => {
        for (const node of nodes) {
            if (!isShownNode(node)) continue;
            if (node.properties.interactive === true) found.push(node);
            walk(node.children);
        }
    };
    walk(trees);
    return found;
}

/**
 * The box on a canvas of `width` by `height` CSS pixels that a box in world space covers, seen through `camera` (its
 * matrices up to date): the eight corners projected, cut to the canvas. A box with a corner behind the camera (it
 * crosses the camera's plane or holds the camera) covers the whole canvas; one wholly behind it, or wholly beside the
 * canvas, gives undefined, as does an empty box. Pure
 */
export function screenBox(box: Box3, camera: Camera, width: number, height: number): ScreenBox | undefined {
    if (box.isEmpty() || width <= 0 || height <= 0) return undefined;
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    let behind = 0;
    const corner = new Vector4();
    for (let index = 0; index < 8; index += 1) {
        corner.set(index & 1 ? box.max.x : box.min.x, index & 2 ? box.max.y : box.min.y, index & 4 ? box.max.z : box.min.z, 1);
        corner.applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
        if (corner.w <= 1e-9) {
            behind += 1;
            continue;
        }
        const x = ((corner.x / corner.w + 1) / 2) * width;
        const y = ((1 - corner.y / corner.w) / 2) * height;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
    }
    if (behind === 8) return undefined;
    if (behind > 0) return { left: 0, top: 0, width, height };
    const clampX = (value: number): number => Math.min(width, Math.max(0, value));
    const clampY = (value: number): number => Math.min(height, Math.max(0, value));
    const x0 = clampX(left);
    const x1 = clampX(right);
    const y0 = clampY(top);
    const y1 = clampY(bottom);
    if (x1 <= x0 || y1 <= y0) return undefined;
    return { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Tells a press of the pointer from a drag. A press is a primary pointer that goes down and up again on the canvas
 * within `PRESS_SLOP` CSS pixels, while the camera did not move (`cameraMoved`: the orbit or pan controls moved it, so
 * the gesture was a drag to rotate, never a click). Only one pointer at a time: a second one down cancels the press
 * (a pinch is not a press). Pure
 */
export class PressGesture {
    private start: { readonly id: number; readonly x: number; readonly y: number } | undefined;
    private moved = false;

    /** True between a pointer's press and its release */
    get pressing(): boolean {
        return this.start !== undefined;
    }

    /** A pointer went down at a point of the canvas */
    down(id: number, x: number, y: number): void {
        if (this.start !== undefined && this.start.id !== id) {
            this.cancel();
            return;
        }
        this.start = { id, x, y };
        this.moved = false;
    }

    /** The pointer moved: farther than `PRESS_SLOP` from where it went down makes the gesture a drag */
    move(id: number, x: number, y: number): void {
        const start = this.start;
        if (start === undefined || start.id !== id) return;
        if (Math.hypot(x - start.x, y - start.y) > PRESS_SLOP) this.moved = true;
    }

    /** The controls moved the camera during the gesture: it is a drag */
    cameraMoved(): void {
        if (this.start !== undefined) this.moved = true;
    }

    /** The pointer went up: true when the gesture was a press */
    up(id: number, x: number, y: number): boolean {
        const start = this.start;
        if (start === undefined || start.id !== id) return false;
        this.move(id, x, y);
        const pressed = !this.moved;
        this.cancel();
        return pressed;
    }

    /** Forgets the gesture (a pointer cancel, a second pointer) */
    cancel(): void {
        this.start = undefined;
        this.moved = false;
    }
}
