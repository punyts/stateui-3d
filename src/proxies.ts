import type { ScreenBox } from './interaction.js';
import type { Scene3dTree } from './tree.js';

/** What the proxies of a scene tell it */
export interface ProxyHooks {
    /** A proxy was clicked (`element.click()`, as `ui_interact` does), or Enter or Space went down on a focused one */
    press(path: string): void;
}

/** The proxy buttons of a scene's interactive nodes (`createProxies`) */
export interface Proxies {
    /** The number of proxies */
    readonly size: number;
    /** Makes, removes and orders the proxies to follow these nodes (in this order) */
    sync(nodes: readonly Scene3dTree[]): void;
    /** Puts each proxy over its node's box on the canvas, and hides one whose node has none (`boxOf` undefined) */
    place(boxOf: (path: string) => ScreenBox | undefined): void;
    /** The proxy of a node by its path; undefined when the node has none */
    elementOf(path: string): HTMLButtonElement | undefined;
    /** Removes the layer and stops listening */
    dispose(): void;
}

interface Proxy {
    readonly element: HTMLButtonElement;
    label: string;
    kind: string;
    box: string;
    hidden: boolean;
}

/**
 * The proxy buttons of a 3D scene's interactive nodes (G3.8 of the graphics epic 3), as the 2D canvas renderer makes
 * them (G1.7c): a layer of no height (class `proxies`) right before the canvas in `host`, holding a `type="button"` per
 * node in the order `sync` gives (tree order), with `data-shape-path` (the node's state path, `<repeat>.rows.<recordKey>`
 * for a `repeat3d` copy), `data-shape-kind` (its component; `mesh` for a copy) and `aria-label` from `_label`, kept in
 * step with the tree (added, removed and moved, never made again). `place` sets each over the box its node covers on
 * the canvas, in CSS pixels from the canvas's corner, with `opacity: 0` and `pointer-events: none`: a screen reader and
 * the tab order reach it, `ui_interact` measures a real box, and the pointer goes through to the canvas, where the scene
 * casts its ray. A proxy whose node is off the canvas is hidden. A click on a proxy, or Enter or Space on a focused one
 * (once per key press, held keys do not repeat it), is told to `press`. Every value is set through the CSSOM, never a
 * `style` attribute (the frame's policy refuses one written as text)
 */
export function createProxies(host: Element, hooks: ProxyHooks): Proxies {
    const document = host.ownerDocument;
    const layer = document.createElement('div');
    layer.setAttribute('class', 'proxies');
    layer.style.position = 'relative';
    layer.style.blockSize = '0';
    layer.style.margin = '0';
    host.prepend(layer);

    const proxies = new Map<string, Proxy>();
    const paths = new WeakMap<Element, string>();
    let disposed = false;

    let template: HTMLButtonElement | undefined;
    /** The button every proxy is copied from: a `type="button"` with no box of its own, invisible and taking no pointer events */
    const proxyTemplate = (): HTMLButtonElement => {
        if (template !== undefined) return template;
        template = document.createElement('button');
        template.type = 'button';
        const style = template.style;
        style.position = 'absolute';
        style.margin = '0';
        style.padding = '0';
        style.border = '0';
        style.boxSizing = 'border-box';
        style.opacity = '0';
        style.pointerEvents = 'none';
        style.left = '0px';
        style.top = '0px';
        style.width = '0px';
        style.height = '0px';
        return template;
    };

    /** The path of the visible proxy an event came from */
    const pathOf = (event: Event): string | undefined => {
        const path = event.target instanceof Element ? paths.get(event.target) : undefined;
        if (disposed || path === undefined) return undefined;
        const proxy = proxies.get(path);
        return proxy === undefined || proxy.hidden ? undefined : path;
    };

    const onClick = (event: MouseEvent): void => {
        const path = pathOf(event);
        if (path !== undefined) hooks.press(path);
    };

    const onKey = (event: KeyboardEvent): void => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const path = pathOf(event);
        if (path === undefined) return;
        // The button's own activation would click it too (and Enter repeats while held), so the key is handled here alone
        event.preventDefault();
        if (!event.repeat) hooks.press(path);
    };

    layer.addEventListener('click', onClick);
    layer.addEventListener('keydown', onKey);

    return {
        get size() {
            return proxies.size;
        },
        sync(nodes) {
            if (disposed) return;
            const wanted = new Set(nodes.map((node) => node.path));
            for (const [path, proxy] of proxies) {
                if (wanted.has(path)) continue;
                proxy.element.remove();
                proxies.delete(path);
            }
            let previous: ChildNode | null = null;
            for (const node of nodes) {
                let proxy = proxies.get(node.path);
                if (proxy === undefined) {
                    const element = proxyTemplate().cloneNode() as HTMLButtonElement;
                    element.setAttribute('data-shape-path', node.path);
                    // Hidden until it is placed over its node
                    element.hidden = true;
                    paths.set(element, node.path);
                    proxy = { element, label: '', kind: '', box: '', hidden: true };
                    proxies.set(node.path, proxy);
                }
                const { element } = proxy;
                if (proxy.kind !== node.kind) {
                    element.setAttribute('data-shape-kind', node.kind);
                    proxy.kind = node.kind;
                }
                const label = typeof node.properties._label === 'string' ? node.properties._label : '';
                if (proxy.label !== label) {
                    if (label === '') element.removeAttribute('aria-label');
                    else element.setAttribute('aria-label', label);
                    proxy.label = label;
                }
                const expected: ChildNode | null = previous === null ? layer.firstChild : previous.nextSibling;
                if (expected !== element) layer.insertBefore(element, expected);
                previous = element;
            }
        },
        place(boxOf) {
            if (disposed) return;
            for (const [path, proxy] of proxies) {
                const box = boxOf(path);
                const hidden = box === undefined;
                if (proxy.hidden !== hidden) {
                    proxy.element.hidden = hidden;
                    proxy.hidden = hidden;
                }
                if (box === undefined) continue;
                const key = `${box.left} ${box.top} ${box.width} ${box.height}`;
                if (proxy.box === key) continue;
                const style = proxy.element.style;
                style.left = `${box.left}px`;
                style.top = `${box.top}px`;
                style.width = `${box.width}px`;
                style.height = `${box.height}px`;
                proxy.box = key;
            }
        },
        elementOf(path) {
            return disposed ? undefined : proxies.get(path)?.element;
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            layer.removeEventListener('click', onClick);
            layer.removeEventListener('keydown', onKey);
            layer.remove();
            proxies.clear();
        }
    };
}
