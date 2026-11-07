import type { FrameTask, Scheduler } from './scheduler.js';
import type { JsonValue, Scene3dTree } from './tree.js';

/**
 * The named animations of a 3D node's `animate` (G3.9b of the graphics epic 3), the 3D twin of the component library's
 * 2D `animate.ts` (G1.8b): played by the renderer on the scene's scheduler and never written to the store. The
 * `motion3d` partial of `@punyts/stateui-components` lists the same names, so any other is `SUI-STATE-INVALID` there.
 * Pure: it touches no three.js object, so it runs in Node with a fake clock; the scene draws the tree it gives
 */
export const ANIMATION3D_NAMES = ['spin', 'bob', 'pulse'] as const;

export type Animation3dName = (typeof ANIMATION3D_NAMES)[number];

/** The length of one cycle in milliseconds when `animate` gives no `duration` (as in 2D) */
export const DEFAULT_ANIMATION_DURATION = 1000;

/** How far `pulse` grows a node at the middle of a cycle (a factor of the node's own `scale`, as the 2D `pulse`) */
export const PULSE_GROWTH = 0.15;

/** How high `bob` lifts a node at the middle of a cycle, in scene units along its parent's y axis */
export const BOB_HEIGHT = 0.25;

/** The kinds whose `animate` plays: a camera's is not played (it is aimed at its `target`, and the controls hold it) */
const ANIMATED_KINDS: ReadonlySet<Scene3dTree['kind']> = new Set(['light', 'mesh', 'model', 'group3d', 'repeat3d', 'label3d']);

/** The position of a light whose node sets none (the `light` shape's default, as `scene.ts` draws it) */
const LIGHT_POSITION: readonly number[] = [5, 10, 5];

/** A node's `animate`, read and checked */
export interface Animation3d {
    readonly name: Animation3dName;
    /** One cycle in milliseconds */
    readonly duration: number;
    /** True (the default) to repeat the cycle until the node loses its `animate`; false to play it once and rest */
    readonly loop: boolean;
    /** Milliseconds before the first cycle starts, during which the node rests */
    readonly delay: number;
}

const isRecord = (value: JsonValue | undefined): value is Record<string, JsonValue> => value !== null && typeof value === 'object' && !Array.isArray(value);

const nonNegative = (value: JsonValue | undefined, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback);

const isVector3 = (value: JsonValue | undefined): value is number[] =>
    Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number' && Number.isFinite(n));

/** The animation of an `animate` value; undefined when there is none or its name is not one of `ANIMATION3D_NAMES` */
export function readAnimation3d(value: JsonValue | undefined): Animation3d | undefined {
    if (!isRecord(value)) return undefined;
    const name = value.name;
    if (typeof name !== 'string' || !(ANIMATION3D_NAMES as readonly string[]).includes(name)) return undefined;
    return {
        name: name as Animation3dName,
        duration: nonNegative(value.duration, DEFAULT_ANIMATION_DURATION),
        loop: value.loop !== false,
        delay: nonNegative(value.delay, 0)
    };
}

/**
 * The properties an animation gives a node at progress `p` of a cycle (0 to 1), over the node's own values: `spin`
 * turns `rotation` a full turn about the node's y axis, `bob` lifts `position` by `BOB_HEIGHT` and back, and `pulse`
 * grows `scale` by `PULSE_GROWTH` and back. Each is at the node's resting values at 0 and 1
 */
export function animatedProperties3d(node: Scene3dTree, animation: Animation3d, p: number): Record<string, JsonValue> {
    const wave = Math.sin(Math.PI * p);
    switch (animation.name) {
        case 'spin': {
            const [x, y, z] = isVector3(node.properties.rotation) ? node.properties.rotation : [0, 0, 0];
            return { rotation: [x!, y! + 360 * p, z!] };
        }
        case 'bob': {
            const position = node.properties.position;
            const [x, y, z] = isVector3(position) ? position : node.kind === 'light' ? LIGHT_POSITION : [0, 0, 0];
            return { position: [x!, y! + BOB_HEIGHT * wave, z!] };
        }
        case 'pulse': {
            const factor = 1 + PULSE_GROWTH * wave;
            const scale = isVector3(node.properties.scale) ? node.properties.scale : [1, 1, 1];
            return { scale: scale.map((part) => part * factor) };
        }
    }
}

/** The animations of a scene's nodes */
export interface Animations3d {
    /**
     * Takes the tree of an update: a node that gains `animate`, or whose `animate` changed, starts its animation in the
     * next frame; one that lost it (or is hidden or gone) stops. Gives the tree with each animation where it is now (the
     * resting tree while motion is reduced or nothing animates)
     */
    follow(tree: readonly Scene3dTree[]): readonly Scene3dTree[];
    /** The tree with each animation where it is now; the same tree when none plays or motion is reduced */
    decorate(tree: readonly Scene3dTree[]): readonly Scene3dTree[];
    /** Starts every animation again from its beginning (reduced motion turned off) */
    restart(): void;
    /** The number of nodes whose animation plays now (not resting, not ended) */
    readonly playing: number;
    /** Stops every animation */
    dispose(): void;
}

interface Playing {
    readonly animation: Animation3d;
    readonly signature: string;
    /** The scheduler time the animation started at, set in its first frame; undefined until then */
    start: number | undefined;
}

/**
 * Follows the nodes with `animate` and plays them through one frame task of the scheduler (`request`), which asks for
 * frames only while an animation plays: none when no node animates, none while motion is reduced (the scheduler runs
 * no tasks then, and every node shows its resting values), and none after an animation with `loop: false` ended. The
 * copies of a `repeat3d` (its instances, G3.6) are not followed: the repeat's own `animate` moves them all, a copy's
 * own does not play. A camera's `animate` does not play. Nothing is written to the store: the values exist only in the
 * tree the scene draws
 */
export function createAnimations3d(scheduler: Scheduler): Animations3d {
    const playing = new Map<string, Playing>();
    let cancel: (() => void) | undefined;
    let disposed = false;

    /** True while an animation has frames left at `now` (its delay or a cycle to play, or it has not started) */
    const running = (entry: Playing, now: number): boolean =>
        entry.start === undefined || entry.animation.loop || now - entry.start - entry.animation.delay < entry.animation.duration;

    const task: FrameTask = (now) => {
        let any = false;
        for (const entry of playing.values()) {
            entry.start ??= now;
            if (running(entry, now)) any = true;
        }
        if (!any) cancel = undefined;
        return any;
    };

    const ensureTask = (): void => {
        if (disposed || cancel !== undefined) return;
        const now = scheduler.now();
        if ([...playing.values()].some((entry) => running(entry, now))) cancel = scheduler.request(task);
    };

    const collect = (nodes: readonly Scene3dTree[], seen: Set<string>): void => {
        for (const node of nodes) {
            if (node.properties.hidden === true || node.properties.visible === false) continue;
            const animation = ANIMATED_KINDS.has(node.kind) ? readAnimation3d(node.properties.animate) : undefined;
            if (animation !== undefined) {
                const signature = JSON.stringify(animation);
                seen.add(node.path);
                if (playing.get(node.path)?.signature !== signature) playing.set(node.path, { animation, signature, start: undefined });
            }
            // A repeat's copies are its instances (G3.6): their own `animate` does not play
            if (node.kind !== 'repeat3d') collect(node.children, seen);
        }
    };

    /** The progress in the cycle of an animation at `now`, or undefined when the node rests */
    const progress = (entry: Playing, now: number): number | undefined => {
        if (entry.start === undefined) return undefined;
        const { duration, delay, loop } = entry.animation;
        const elapsed = now - entry.start - delay;
        if (elapsed < 0 || duration <= 0) return undefined;
        if (!loop && elapsed >= duration) return undefined;
        return (elapsed % duration) / duration;
    };

    const decorateNodes = (nodes: readonly Scene3dTree[], now: number): readonly Scene3dTree[] => {
        let changed = false;
        const result = nodes.map((node) => {
            const entry = playing.get(node.path);
            const p = entry === undefined ? undefined : progress(entry, now);
            const properties = p === undefined ? node.properties : { ...node.properties, ...animatedProperties3d(node, entry!.animation, p) };
            const children = node.children.length === 0 || node.kind === 'repeat3d' ? node.children : decorateNodes(node.children, now);
            if (properties === node.properties && children === node.children) return node;
            changed = true;
            return { ...node, properties, children };
        });
        return changed ? result : nodes;
    };

    const decorate = (tree: readonly Scene3dTree[]): readonly Scene3dTree[] =>
        disposed || playing.size === 0 || scheduler.reduced ? tree : decorateNodes(tree, scheduler.now());

    return {
        follow(tree) {
            if (disposed) return tree;
            const seen = new Set<string>();
            collect(tree, seen);
            for (const path of [...playing.keys()]) if (!seen.has(path)) playing.delete(path);
            // While motion is reduced every node rests; when it is turned off each animation starts from its beginning
            if (scheduler.reduced) for (const entry of playing.values()) entry.start = undefined;
            if (playing.size === 0) {
                cancel?.();
                cancel = undefined;
            } else ensureTask();
            return decorate(tree);
        },
        decorate,
        restart() {
            if (disposed) return;
            for (const entry of playing.values()) entry.start = undefined;
            ensureTask();
        },
        get playing() {
            if (disposed || scheduler.reduced) return 0;
            const now = scheduler.now();
            let count = 0;
            for (const entry of playing.values()) if (entry.start !== undefined && progress(entry, now) !== undefined) count += 1;
            return count;
        },
        dispose() {
            disposed = true;
            cancel?.();
            cancel = undefined;
            playing.clear();
        }
    };
}
