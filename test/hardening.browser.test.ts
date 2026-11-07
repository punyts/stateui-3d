import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTEXT_RESTORE_TIMEOUT, createScene3d } from '../src/scene3d.ts';
import type { Scene3d, Scene3dStatus } from '../src/scene3d.ts';
import { ENVIRONMENT_NAMES, ENVIRONMENT_PRESETS } from '../src/environment.ts';
import type { JsonValue, Scene3dSettings, Scene3dTree } from '../src/tree.ts';
import { differs, draw, expectColor, front, node, pixelAt, rgbOf } from './pixels.ts';

/** A mid grey box: no preset lights it to white, so each preset's light shows */
const grey = (properties: Record<string, JsonValue> = {}): Scene3dTree => node('mesh', 'box', { geometry: { kind: 'box' }, material: { color: '#808080' }, ...properties });
const sun = (properties: Record<string, JsonValue> = {}): Scene3dTree => node('light', 'sun', { kind: 'directional', position: [0, 0, 10], target: [0, 0, 0], ...properties });
const BLACK: Scene3dSettings = { background: '#000000', environment: 'none' };

/** The WebGL context of the scene's canvas and its `WEBGL_lose_context` extension */
function loseContext(host: HTMLElement): { gl: WebGL2RenderingContext; extension: WEBGL_lose_context } {
    const gl = host.querySelector('canvas')?.getContext('webgl2');
    const extension = gl?.getExtension('WEBGL_lose_context');
    if (!gl || !extension) throw new Error('No WEBGL_lose_context');
    return { gl, extension };
}

/**
 * Resolves on the next event of this type on the scene's canvas, a task after it: Chromium allows `restoreContext` only
 * once the dispatch of `webglcontextlost` is over, and a promise settled in the listener resumes during that dispatch
 */
const next = (host: HTMLElement, type: string): Promise<void> =>
    new Promise((resolve) => host.querySelector('canvas')?.addEventListener(type, () => void setTimeout(resolve, 0), { once: true }));

/**
 * Holds back the scene's restore timer (a `setTimeout` of `CONTEXT_RESTORE_TIMEOUT`) so a test fires it at once; other
 * timers run as they are (the browser test runner needs its own, so fake timers would stop it)
 */
function restoreTimers(): { fire(): void; waiting(): number; made(): number } {
    const held = new Map<number, () => void>();
    let made = 0;
    let id = -1;
    const setTimeoutOf = window.setTimeout.bind(window);
    const clearTimeoutOf = window.clearTimeout.bind(window);
    vi.spyOn(window, 'setTimeout').mockImplementation(((handler: () => void, delay?: number, ...rest: unknown[]) => {
        if (delay !== CONTEXT_RESTORE_TIMEOUT) return setTimeoutOf(handler, delay, ...rest);
        made += 1;
        id -= 1;
        held.set(id, handler);
        return id;
    }) as typeof window.setTimeout);
    vi.spyOn(window, 'clearTimeout').mockImplementation(((timer?: number) => {
        if (timer !== undefined && held.delete(timer)) return;
        clearTimeoutOf(timer);
    }) as typeof window.clearTimeout);
    return {
        fire() {
            const handlers = [...held.values()];
            held.clear();
            for (const handler of handlers) handler();
        },
        waiting: () => held.size,
        made: () => made
    };
}

/**
 * Resolves after the frame a restored context asks for, in the task of that frame (the drawing buffer is not kept after
 * it): the scene's own listener ran first and asked for the frame
 */
const redrawn = (host: HTMLElement, scene: Scene3d): Promise<void> =>
    new Promise((resolve) => host.querySelector('canvas')?.addEventListener('webglcontextrestored', () => void scene.drawn().then(resolve), { once: true }));

/** True when the promise settles within `ms` */
const settlesWithin = (promise: Promise<unknown>, ms: number): Promise<boolean> =>
    Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);

describe('the 3D renderer hardening in Chromium (G3.5b)', () => {
    let host: HTMLElement;
    let scene: Scene3d;
    let statuses: Scene3dStatus[];

    beforeEach(() => {
        host = document.createElement('div');
        host.style.width = '120px';
        host.style.height = '80px';
        document.body.append(host);
        statuses = [];
        const resolveColor = (value: JsonValue): string | undefined => {
            if (typeof value !== 'string') return undefined;
            if (!value.startsWith('{')) return value;
            const name = `--ui-${value.slice(1, -1).replaceAll('.', '-')}`;
            return getComputedStyle(host).getPropertyValue(name).trim() || undefined;
        };
        scene = createScene3d(host, { resolveColor, onStatus: (status) => statuses.push(status) });
    });

    afterEach(() => {
        scene.dispose();
        host.remove();
        vi.restoreAllMocks();
    });

    describe('environment presets', () => {
        it('should light the same box differently with each preset, and not at all with none', async () => {
            // Act
            const centres: Record<string, number[]> = {};
            for (const environment of ENVIRONMENT_NAMES) {
                await draw(scene, [front(), grey()], { background: '#000000', environment });
                centres[environment] = pixelAt(host);
            }

            // Assert: every pair differs, and the values are the presets' (a regression shows)
            expectColor(centres.none ?? [], [0, 0, 0, 255]);
            for (const [i, a] of ENVIRONMENT_NAMES.entries()) {
                for (const b of ENVIRONMENT_NAMES.slice(i + 1)) expect(differs(centres[a] ?? [], centres[b] ?? []), `${a} and ${b}: ${centres[a]} ${centres[b]}`).toBe(true);
            }
            expectColor(centres.studio ?? [], [131, 131, 131, 255]);
            expectColor(centres.daylight ?? [], [120, 120, 117, 255]);
            expectColor(centres.neutral ?? [], [92, 92, 92, 255]);
        });

        it('should draw the preset background when the scene sets none', async () => {
            // Act
            const corners: Record<string, number[]> = {};
            for (const environment of ENVIRONMENT_NAMES) {
                await draw(scene, [front(), grey()], { environment });
                corners[environment] = pixelAt(host, 0.02, 0.02);
            }

            // Assert
            expectColor(corners.none ?? [], [0, 0, 0, 0]);
            for (const environment of ['studio', 'daylight', 'neutral'] as const) {
                expectColor(corners[environment] ?? [], [...rgbOf(ENVIRONMENT_PRESETS[environment].background ?? ''), 255]);
            }
        });

        it('should colour the studio ambient light with the scene ambient colour', async () => {
            // Act
            await draw(scene, [front(), node('mesh', 'box', { material: { color: '#ffffff' } })], { background: '#000000', ambient: '#ff0000', environment: 'studio' });
            const red = pixelAt(host);
            await draw(scene, [front(), node('mesh', 'box', { material: { color: '#ffffff' } })], { background: '#000000', ambient: '#0000ff', environment: 'studio' });
            const blue = pixelAt(host);

            // Assert: the key light is white, the ambient light adds its colour
            expect(red[0]).toBeGreaterThan((red[2] ?? 0) + 12);
            expect(blue[2]).toBeGreaterThan((blue[0] ?? 0) + 12);
        });
    });

    describe('fog', () => {
        it('should draw fog over a mesh beyond its far distance, none before near, and none once removed', async () => {
            // Act
            await draw(scene, [front(), sun(), grey()], { ...BLACK, fog: { color: '#ff0000', near: 1, far: 3 } });
            const fogged = pixelAt(host);
            const background = pixelAt(host, 0.02, 0.02);
            await draw(scene, [front(), sun(), grey()], { ...BLACK, fog: { color: '#ff0000', near: 10, far: 20 } });
            const clear = pixelAt(host);
            await draw(scene, [front(), sun(), grey()], { ...BLACK, fog: { near: 2, far: 7 } });
            const halfway = pixelAt(host);
            await draw(scene, [front(), sun(), grey()], BLACK);
            const removed = pixelAt(host);

            // Assert: the box's front face is 4.5 from the camera; fog does not paint the background
            expectColor(fogged, [255, 0, 0, 255]);
            expectColor(background, [0, 0, 0, 255]);
            expect(differs(clear, [255, 0, 0, 255])).toBe(true);
            expectColor(clear, removed);
            expect(differs(removed, [0, 0, 0, 255])).toBe(true);
            // Fog of the background's colour (black) between near and far darkens the box
            expect(halfway[0]).toBeLessThan((removed[0] ?? 0) - 12);
            expect(halfway[0]).toBeGreaterThan(12);
        });
    });

    describe('theme', () => {
        it('should recolour the background, the environment and the nodes on restyle, without an update', async () => {
            // Arrange
            host.style.setProperty('--ui-scene3d-background', '#000080');
            host.style.setProperty('--ui-scene3d-ambient', '#ffffff');
            host.style.setProperty('--ui-color-accent-base', '#ff0000');
            const settings: Scene3dSettings = { background: '{scene3d.background}', ambient: '{scene3d.ambient}', environment: 'neutral' };
            await draw(scene, [front(), node('mesh', 'box', { material: { color: '{color.accent.base}' } }), node('light', 'sun', { kind: 'ambient', color: '{color.accent.base}', intensity: 0.2 })], settings);
            const light = { centre: pixelAt(host), corner: pixelAt(host, 0.02, 0.02) };
            const update = vi.spyOn(scene, 'update');

            // Act: a dark mode gives the same tokens other values
            host.style.setProperty('--ui-scene3d-background', '#101010');
            host.style.setProperty('--ui-color-accent-base', '#00ff00');
            scene.restyle();
            await scene.drawn();
            const dark = { centre: pixelAt(host), corner: pixelAt(host, 0.02, 0.02) };

            // Assert
            expectColor(light.corner, [0, 0, 128, 255]);
            expectColor(dark.corner, [16, 16, 16, 255]);
            expect(light.centre[0]).toBeGreaterThan(200);
            expect(dark.centre[1]).toBeGreaterThan(200);
            expect(dark.centre[0]).toBeLessThan(12);
            expect(update).not.toHaveBeenCalled();
        });

        it('should ask for one frame on restyle and none at rest', async () => {
            // Arrange
            await draw(scene, [front(), grey()], BLACK);
            const frames = vi.spyOn(window, 'requestAnimationFrame');

            // Act
            scene.restyle();
            scene.restyle();
            await scene.drawn();
            await new Promise((resolve) => setTimeout(resolve, 100));

            // Assert
            expect(frames).toHaveBeenCalledTimes(1);
        });
    });

    describe('cameras', () => {
        it('should switch the camera when active changes, and back, keeping every node', async () => {
            // Arrange
            const tree = (active: 'a' | 'b'): Scene3dTree[] => [
                node('light', 'fill', { kind: 'ambient' }),
                node('mesh', 'left', { position: [-10, 0, 0], material: { color: '#ff0000' } }),
                node('mesh', 'right', { position: [10, 0, 0], material: { color: '#00ff00' } }),
                node('camera', 'a', { position: [-10, 0, 5], target: [-10, 0, 0], active: active === 'a' }),
                node('camera', 'b', { position: [10, 0, 5], target: [10, 0, 0], active: active === 'b' })
            ];
            await draw(scene, tree('a'), BLACK);
            const first = pixelAt(host);
            const bounds = scene.boundsOf('$.app.children.left');
            const programs = scene.info().programs;

            // Act
            await draw(scene, tree('b'));
            const second = pixelAt(host);
            await draw(scene, tree('a'));
            const back = pixelAt(host);

            // Assert: no new program, nothing made again
            expectColor(first, [255, 0, 0, 255]);
            expectColor(second, [0, 255, 0, 255]);
            expectColor(back, [255, 0, 0, 255]);
            expect(scene.boundsOf('$.app.children.left')).toEqual(bounds);
            expect(scene.info().programs).toBe(programs);
        });
    });

    describe('shadows', () => {
        /** A white floor facing the camera, a box standing on it and a light from the right at 45° */
        const floor = (shadows: boolean): Scene3dTree[] => [
            front(),
            node('mesh', 'floor', { geometry: { kind: 'plane', width: 10, height: 10 }, material: { color: '#ffffff' }, receiveShadow: true }),
            node('mesh', 'box', { position: [0, 0, 1], material: { color: '#ffffff' }, castShadow: true }),
            node('light', 'sun', { kind: 'directional', position: [4, 0, 4], target: [0, 0, 0], shadows })
        ];

        it('should draw no shadow map until a light has shadows, then turn it on once and draw the shadow', async () => {
            // Act: the floor at x = -1.25 is behind the box, seen from the light
            await draw(scene, floor(false), BLACK);
            const lit = pixelAt(host, 0.32, 0.5);
            const before = scene.info().shadowMap;
            await draw(scene, floor(true));
            const shadowed = pixelAt(host, 0.32, 0.5);
            const open = pixelAt(host, 0.85, 0.5);
            const during = scene.info().shadowMap;
            await draw(scene, floor(false));
            const after = { pixel: pixelAt(host, 0.32, 0.5), shadowMap: scene.info().shadowMap };

            // Assert: cos 45° of white where the light reaches, black in the shadow
            expectColor(lit, [218, 218, 218, 255]);
            expect(before).toBe(false);
            expect(during).toBe(true);
            expectColor(shadowed, [0, 0, 0, 255]);
            expectColor(open, [218, 218, 218, 255]);
            expectColor(after.pixel, [218, 218, 218, 255]);
            expect(after.shadowMap).toBe(true);
        });
    });

    describe('dispose', () => {
        it('should hold as many geometries and textures after 100 nodes come and go as before', async () => {
            // Arrange
            await draw(scene, [front(), sun(), grey()], BLACK);
            const start = scene.info().memory;
            const many = Array.from({ length: 100 }, (_, index) =>
                node('mesh', `m${index}`, { position: [(index % 10) - 4.5, Math.floor(index / 10) - 4.5, -10], geometry: { kind: index % 2 === 0 ? 'box' : 'sphere' }, material: { color: '#ff0000' } })
            );

            // Act
            await draw(scene, [front(), sun({ shadows: true }), grey(), ...many]);
            const full = scene.info().memory;
            await draw(scene, [front(), sun(), grey()]);
            const end = scene.info().memory;

            // Assert
            expect(full.geometries).toBe(start.geometries + 100);
            expect(end).toEqual({ geometries: start.geometries, textures: full.textures });
            expect(end.geometries).toBe(start.geometries);
        });

        it('should free the renderer and lose its context on dispose', async () => {
            // Arrange
            await draw(scene, [front(), sun({ shadows: true }), grey()], BLACK);
            const { gl } = loseContext(host);

            // Act
            scene.dispose();

            // Assert
            expect(gl.isContextLost()).toBe(true);
            expect(host.querySelector('canvas')).toBeNull();
            expect(statuses).toEqual([]);
        });
    });

    describe('context loss', () => {
        it('should stop drawing on a lost context and draw the same picture again on its restore', async () => {
            // Arrange
            await draw(scene, [front(), sun(), node('mesh', 'box', { material: { color: '#ff0000' } })], BLACK);
            const before = pixelAt(host);
            const { extension } = loseContext(host);
            const frames = vi.spyOn(window, 'requestAnimationFrame');

            // Act
            const lost = next(host, 'webglcontextlost');
            extension.loseContext();
            await lost;
            scene.update([front(), sun(), node('mesh', 'box', { material: { color: '#ff0000' }, position: [0, 0, 0.001] })]);
            const drawnWhileLost = await settlesWithin(scene.drawn(), 100);
            const framesWhileLost = frames.mock.calls.length;
            const info = scene.info();
            const restored = redrawn(host, scene);
            extension.restoreContext();
            await restored;
            const after = pixelAt(host);

            // Assert
            expect(info.contextLost).toBe(true);
            expect(drawnWhileLost).toBe(false);
            expect(framesWhileLost).toBe(0);
            expect(statuses).toEqual(['lost', 'pending']);
            expectColor(before, [252, 27, 27, 255]);
            expectColor(after, before);
            expect(scene.info().contextLost).toBe(false);
        });

        it(`should tell failed when the context is not back within ${CONTEXT_RESTORE_TIMEOUT} ms, and draw if it comes back later`, async () => {
            // Arrange
            await draw(scene, [front(), sun(), node('mesh', 'box', { material: { color: '#00ff00' } })], BLACK);
            const { extension } = loseContext(host);
            const timers = restoreTimers();

            // Act
            const lost = next(host, 'webglcontextlost');
            extension.loseContext();
            await lost;
            const early = [...statuses];
            timers.fire();
            const late = [...statuses];
            const restored = redrawn(host, scene);
            extension.restoreContext();
            await restored;

            // Assert
            expect(early).toEqual(['lost']);
            expect(late).toEqual(['lost', 'failed']);
            expect(statuses).toEqual(['lost', 'failed', 'pending']);
            expectColor(pixelAt(host), [27, 252, 27, 255]);
        });

        it('should not tell failed once the context is restored in time', async () => {
            // Arrange
            await draw(scene, [front(), sun(), grey()], BLACK);
            const { extension } = loseContext(host);
            const timers = restoreTimers();

            // Act
            const lost = next(host, 'webglcontextlost');
            extension.loseContext();
            await lost;
            const restored = next(host, 'webglcontextrestored');
            extension.restoreContext();
            await restored;
            const waiting = timers.waiting();
            timers.fire();

            // Assert: the timer was made on the loss and cleared on the restore
            expect(timers.made()).toBe(1);
            expect(waiting).toBe(0);
            expect(statuses).toEqual(['lost', 'pending']);
        });
    });

    describe('resize', () => {
        it('should tell pending when a resize asks for a frame, and draw it', async () => {
            // Arrange
            await draw(scene, [front(), sun(), grey()], BLACK);

            // Act
            host.style.width = '60px';
            await new Promise((resolve) => setTimeout(resolve, 100));
            const told = [...statuses];
            await scene.drawn();

            // Assert
            expect(told).toEqual(['pending']);
            expect(host.querySelector('canvas')?.width).toBe(60 * Math.min(devicePixelRatio, 2));
        });
    });
});
