import { afterEach, describe, expect, inject, it } from 'vitest';
import type { Stateui3dGlobal } from '../src/index.ts';
import { VERSION } from '../src/version.ts';

/** A fresh page (a same-origin frame) to load the chunk into, with nothing of the test runner on its global */
function blankPage(): { frame: HTMLIFrameElement; view: Window & Record<string, unknown> } {
    const frame = document.createElement('iframe');
    frame.style.width = '200px';
    frame.style.height = '200px';
    document.body.append(frame);
    const view = frame.contentWindow as (Window & Record<string, unknown>) | null;
    if (!view) throw new Error('The frame has no window');
    return { frame, view };
}

/** Runs the chunk in the page as a classic script, as the runtime's `load3d` hook does with `<script src>` */
function loadChunk(view: Window): void {
    const script = view.document.createElement('script');
    script.textContent = inject('chunkScript');
    view.document.head.append(script);
}

describe('runtime chunk', () => {
    afterEach(() => {
        for (const frame of document.querySelectorAll('iframe')) frame.remove();
    });

    it('should add one global, __stateui3d, and nothing else', () => {
        // Arrange
        const { view } = blankPage();
        const before = new Set(Object.getOwnPropertyNames(view));

        // Act
        loadChunk(view);

        // Assert
        const added = Object.getOwnPropertyNames(view).filter((name) => !before.has(name));
        expect(added).toEqual(['__stateui3d']);
    });

    it('should keep a window.__THREE__ the page had before', () => {
        // Arrange
        const { view } = blankPage();
        view.__THREE__ = 'other';

        // Act
        loadChunk(view);

        // Assert
        expect(view.__THREE__).toBe('other');
    });

    it('should give the version and createScene3d, which draws in the page', () => {
        // Arrange
        const { view } = blankPage();
        loadChunk(view);
        const api = view.__stateui3d as Stateui3dGlobal;
        const host = view.document.createElement('div');
        host.style.width = '64px';
        host.style.height = '64px';
        view.document.body.append(host);

        // Act
        const scene = api.createScene3d(host);
        scene.update([{ kind: 'mesh', key: 'box', path: '$.app.children.box', properties: { material: { color: '#00ff00' } }, children: [] }]);

        // Assert
        expect(api.version).toBe(VERSION);
        expect(Object.isFrozen(api)).toBe(true);
        const canvas = host.querySelector('canvas');
        expect(canvas).not.toBeNull();
        expect(scene.boundsOf('$.app.children.box')).toEqual({ min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] });
        scene.dispose();
        expect(host.querySelector('canvas')).toBeNull();
    });
});
