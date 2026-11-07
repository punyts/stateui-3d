import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createScene3d } from '../src/scene3d.ts';
import type { Scene3d, Scene3dEvent } from '../src/scene3d.ts';
import type { CameraMove } from '../src/controls.ts';
import type { JsonValue, Scene3dSettings, Scene3dTree } from '../src/tree.ts';
import { ROOT, draw, front, node } from './pixels.ts';

/** The host is 120 by 80 CSS pixels; the camera at z = 5 sees 3.5 units each side of the centre at z = 0 */
const WIDTH = 120;
const HEIGHT = 80;
const REPEAT = `${ROOT}.crates`;

const sun = (): Scene3dTree => node('light', 'sun', { kind: 'directional', position: [0, 0, 10], target: [0, 0, 0] });
/** A unit box at the origin, interactive with a label unless told otherwise */
const box = (properties: Record<string, JsonValue> = {}): Scene3dTree => node('mesh', 'box', { geometry: { kind: 'box' }, interactive: true, _label: 'Box', ...properties });
const settings = (controls: JsonValue = 'none'): Scene3dSettings => ({ background: '#000000', environment: 'none', controls });

/** The copy of a repeat's row for one record, as the feeder binds it */
const copy = (key: string, properties: Record<string, JsonValue> = {}): Scene3dTree => ({
    kind: 'mesh',
    key,
    path: `${REPEAT}.rows.${key}`,
    properties: { geometry: { kind: 'box' }, ...properties },
    children: []
});

/** Dispatches a mouse pointer event on the canvas at a point in CSS pixels of the host */
function pointer(host: HTMLElement, type: string, x: number, y: number, buttons = type === 'pointerdown' || type === 'pointermove-pressed' ? 1 : 0): void {
    const canvas = host.querySelector('canvas') as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const name = type === 'pointermove-pressed' ? 'pointermove' : type;
    canvas.dispatchEvent(new PointerEvent(name, { bubbles: true, composed: true, cancelable: true, clientX: rect.left + x, clientY: rect.top + y, pointerId: 1, button: 0, buttons, pointerType: 'mouse', isPrimary: true }));
}

/** A click of the primary button at a point: down and up with no move */
function click(host: HTMLElement, x: number, y: number): void {
    pointer(host, 'pointerdown', x, y);
    pointer(host, 'pointerup', x, y);
}

/** The proxy's box in CSS pixels from the canvas's corner */
function boxOf(host: HTMLElement, proxy: Element): { left: number; top: number; width: number; height: number } {
    const canvas = (host.querySelector('canvas') as HTMLCanvasElement).getBoundingClientRect();
    const rect = proxy.getBoundingClientRect();
    return { left: rect.left - canvas.left, top: rect.top - canvas.top, width: rect.width, height: rect.height };
}

describe('press and hover on 3D nodes, and their proxies, in Chromium (G3.8)', () => {
    let host: HTMLElement;
    let scene: Scene3d;
    let events: Scene3dEvent[];
    let moves: CameraMove[];

    beforeEach(() => {
        host = document.createElement('div');
        host.style.width = `${WIDTH}px`;
        host.style.height = `${HEIGHT}px`;
        document.body.append(host);
        events = [];
        moves = [];
        scene = createScene3d(host, { onEvent: (event) => events.push(event), onCamera: (move) => moves.push(move) });
    });

    afterEach(() => {
        scene.dispose();
        host.remove();
    });

    it('should raise press for a click at a known pixel, with the node, its key and the point the ray hit', async () => {
        // Arrange
        await draw(scene, [front(), sun(), box()], settings());

        // Act
        click(host, WIDTH / 2, HEIGHT / 2);

        // Assert: the front face of the unit box is at z = 0.5
        expect(events).toHaveLength(1);
        const [event] = events;
        expect(event?.name).toBe('press');
        expect(event?.shape).toBe(`${ROOT}.box`);
        expect(event?.key).toBe('box');
        expect(event?.point[0]).toBeCloseTo(0, 3);
        expect(event?.point[1]).toBeCloseTo(0, 3);
        expect(event?.point[2]).toBeCloseTo(0.5, 3);
    });

    it('should raise nothing for a click on empty space or on a node that is not interactive', async () => {
        // Arrange
        await draw(scene, [front(), sun(), box({ interactive: false })], settings());

        // Act
        click(host, 5, 5);
        click(host, WIDTH / 2, HEIGHT / 2);

        // Assert
        expect(events).toEqual([]);
        expect(scene.elementOf(`${ROOT}.box`)).toBeUndefined();
    });

    it('should press the nearest interactive ancestor of a node that is not interactive', async () => {
        // Arrange
        const group = node('group3d', 'rig', { interactive: true }, [node('mesh', 'part', { geometry: { kind: 'box' } })]);
        await draw(scene, [front(), sun(), group], settings());

        // Act
        click(host, WIDTH / 2, HEIGHT / 2);

        // Assert
        expect(events.map((event) => [event.name, event.shape])).toEqual([['press', `${ROOT}.rig`]]);
    });

    it('should not press when the pointer moved past the slop between down and up', async () => {
        // Arrange
        await draw(scene, [front(), sun(), box()], settings());

        // Act
        pointer(host, 'pointerdown', 60, 40);
        pointer(host, 'pointermove-pressed', 70, 40);
        pointer(host, 'pointermove-pressed', 60, 40);
        pointer(host, 'pointerup', 60, 40);

        // Assert
        expect(events).toEqual([]);
    });

    it('should raise hover once on entering an interactive node, and again only after leaving it', async () => {
        // Arrange
        await draw(scene, [front(), sun(), box()], settings());

        // Act
        pointer(host, 'pointermove', 60, 40);
        pointer(host, 'pointermove', 61, 41);
        pointer(host, 'pointermove', 5, 5);
        pointer(host, 'pointermove', 60, 40);
        const canvas = host.querySelector('canvas') as HTMLCanvasElement;
        const cursor = canvas.style.cursor;

        // Assert
        expect(events.map((event) => [event.name, event.shape])).toEqual([
            ['hover', `${ROOT}.box`],
            ['hover', `${ROOT}.box`]
        ]);
        expect(events[0]?.point[2]).toBeCloseTo(0.5, 3);
        expect(cursor).toBe('pointer');
    });

    it('should raise no hover while a button is down', async () => {
        // Arrange
        await draw(scene, [front(), sun(), box()], settings());

        // Act
        pointer(host, 'pointermove-pressed', 60, 40);

        // Assert
        expect(events).toEqual([]);
    });

    it('should raise no press for an orbit drag that starts and ends on the node, and write the camera once', async () => {
        // Arrange
        await draw(scene, [front(), sun(), box()], settings('orbit'));

        // Act: the pointer turns the camera and comes back to where it went down
        pointer(host, 'pointerdown', 60, 40);
        pointer(host, 'pointermove-pressed', 62, 40);
        pointer(host, 'pointermove-pressed', 64, 40);
        pointer(host, 'pointermove-pressed', 60, 40);
        pointer(host, 'pointermove-pressed', 59, 40);
        pointer(host, 'pointerup', 59, 40);
        await scene.drawn();

        // Assert
        expect(events.filter((event) => event.name === 'press')).toEqual([]);
        expect(moves).toHaveLength(1);
    });

    it('should press with a plain click in a scene with orbit controls, and show the move cursor there', async () => {
        // Arrange
        await draw(scene, [front(), sun(), box()], settings('orbit'));

        // Act
        pointer(host, 'pointermove', 60, 40);
        const cursor = (host.querySelector('canvas') as HTMLCanvasElement).style.cursor;
        click(host, 60, 40);
        await scene.drawn();

        // Assert
        expect(events.map((event) => event.name)).toEqual(['hover', 'press']);
        expect(moves).toEqual([]);
        expect(cursor).toBe('move');
    });

    it('should give each interactive node a proxy button in tree order over its projected box, named by its label', async () => {
        // Arrange
        const tree = [front(), sun(), box(), node('mesh', 'side', { position: [2, 0, 0], geometry: { kind: 'box' }, interactive: true, _label: 'Side' }), node('mesh', 'plain', { position: [-2, 0, 0], geometry: { kind: 'box' } })];

        // Act
        await draw(scene, tree, settings());

        // Assert
        const proxies = Array.from(host.querySelectorAll('.proxies > button'));
        expect(proxies.map((proxy) => proxy.getAttribute('data-shape-path'))).toEqual([`${ROOT}.box`, `${ROOT}.side`]);
        const proxy = scene.elementOf(`${ROOT}.box`) as HTMLButtonElement;
        expect(proxy).toBe(proxies[0]);
        expect(proxy.type).toBe('button');
        expect(proxy.getAttribute('data-shape-kind')).toBe('mesh');
        expect(proxy.getAttribute('aria-label')).toBe('Box');
        expect(proxy.hidden).toBe(false);
        expect(getComputedStyle(proxy).opacity).toBe('0');
        expect(getComputedStyle(proxy).pointerEvents).toBe('none');
        expect(proxy.hasAttribute('style')).toBe(true);
        const placed = boxOf(host, proxy);
        expect(placed.left + placed.width / 2).toBeCloseTo(WIDTH / 2, 0);
        expect(placed.top + placed.height / 2).toBeCloseTo(HEIGHT / 2, 0);
        // The unit box's near face, 4.5 units away, is about 19 pixels across on a canvas that shows 4.66 units in 80
        expect(placed.width).toBeGreaterThan(17);
        expect(placed.width).toBeLessThan(22);
        expect(boxOf(host, proxies[1] as Element).left).toBeGreaterThan(placed.left + placed.width);
        // The layer sits before the canvas
        expect(host.firstElementChild?.className).toBe('proxies');
    });

    it('should move a proxy with its node and with the camera, and hide it when the node is off the canvas or not drawn', async () => {
        // Arrange
        await draw(scene, [front(), sun(), box()], settings());
        const proxy = scene.elementOf(`${ROOT}.box`) as HTMLButtonElement;
        const before = boxOf(host, proxy);

        // Act
        await draw(scene, [front(), sun(), box({ position: [1, 0, 0] })], settings());
        const moved = boxOf(host, proxy);
        await draw(scene, [front({ position: [-1, 0, 5], target: [-1, 0, 0] }), sun(), box({ position: [1, 0, 0] })], settings());
        const turned = boxOf(host, proxy);
        await draw(scene, [front(), sun(), box({ position: [20, 0, 0] })], settings());
        const offCanvas = proxy.hidden;
        await draw(scene, [front(), sun(), box({ visible: false })], settings());

        // Assert
        expect(moved.left).toBeGreaterThan(before.left + 10);
        expect(turned.left).toBeGreaterThan(moved.left + 10);
        expect(offCanvas).toBe(true);
        expect(scene.elementOf(`${ROOT}.box`)).toBeUndefined();
        expect(proxy.isConnected).toBe(false);
    });

    it('should press through the proxy with a click and with Enter or Space, once per key press, at the centre of the node', async () => {
        // Arrange
        await draw(scene, [front(), sun(), box({ position: [1, 0, 0] })], settings('orbit'));
        const proxy = scene.elementOf(`${ROOT}.box`) as HTMLButtonElement;

        // Act
        proxy.click();
        proxy.focus();
        const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, composed: true });
        proxy.dispatchEvent(enter);
        proxy.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true, composed: true }));
        proxy.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true, composed: true }));
        proxy.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true, composed: true }));

        // Assert
        expect(document.activeElement).toBe(proxy);
        expect(enter.defaultPrevented).toBe(true);
        expect(events.map((event) => [event.name, event.shape, event.key])).toEqual([
            ['press', `${ROOT}.box`, 'box'],
            ['press', `${ROOT}.box`, 'box'],
            ['press', `${ROOT}.box`, 'box']
        ]);
        expect(events[0]?.point).toEqual([1, 0, 0]);
    });

    it('should press a repeat3d copy by its record key, and give the interactive copies proxies with their own labels', async () => {
        // Arrange: the left copy is interactive, the right one is not
        const crates: Scene3dTree = {
            kind: 'repeat3d',
            key: 'crates',
            path: REPEAT,
            properties: {},
            children: [copy('left', { position: [-1.75, 0, 0], interactive: true, _label: 'Left crate' }), copy('right', { position: [1.75, 0, 0], interactive: false })]
        };
        await draw(scene, [front(), sun(), crates], settings());

        // Act
        click(host, WIDTH * 0.25, HEIGHT / 2);
        click(host, WIDTH * 0.75, HEIGHT / 2);
        const proxies = Array.from(host.querySelectorAll('.proxies > button'));
        const left = boxOf(host, proxies[0] as Element);
        (proxies[0] as HTMLButtonElement).click();

        // Assert
        expect(events.map((event) => [event.name, event.shape, event.key])).toEqual([
            ['press', `${REPEAT}.rows.left`, 'left'],
            ['press', `${REPEAT}.rows.left`, 'left']
        ]);
        expect(proxies.map((proxy) => [proxy.getAttribute('data-shape-path'), proxy.getAttribute('data-shape-kind'), proxy.getAttribute('aria-label')])).toEqual([[`${REPEAT}.rows.left`, 'mesh', 'Left crate']]);
        // Seen from the side, the box's near corners stand out on the far side: its box is about centred
        expect(Math.abs(left.left + left.width / 2 - WIDTH * 0.25)).toBeLessThan(2);
        expect(events[1]?.point).toEqual([-1.75, 0, 0]);
    });

    it('should remove the proxies and stop listening when disposed', async () => {
        // Arrange
        await draw(scene, [front(), sun(), box()], settings());
        const canvas = host.querySelector('canvas') as HTMLCanvasElement;

        // Act
        scene.dispose();
        canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, clientX: 0, clientY: 0 }));
        canvas.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 1, clientX: 0, clientY: 0 }));

        // Assert
        expect(host.querySelector('.proxies')).toBeNull();
        expect(events).toEqual([]);
    });
});
