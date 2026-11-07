import { sameValue } from './diff.js';
import { DEFAULT_DURATIONS, durationToken, easingToken } from './scheduler.js';
import type { ReadToken, Scheduler, Timing, TweenValue } from './scheduler.js';
import type { JsonValue, Scene3dTree } from './tree.js';

/**
 * The `transition` of 3D nodes (G3.9 of the graphics epic 3): from each new node tree to the tree to draw, the values
 * that a state change gives a node with `transition` tweened on the scene's scheduler (`scheduler.ts`, the copy of the
 * component library's 2D scheduler). Pure: it touches no three.js object, so it runs in Node with a fake clock; the
 * scene draws the tree it gives (`SceneGraph.sync`), which changes only the properties that moved.
 */

/** A colour as red, green and blue in sRGB, 0 to 255 */
export type Rgb = readonly [number, number, number];

/**
 * The values a `transition` tweens, by channel: `position`, `rotation` and `scale` of every node (a camera's `rotation`
 * is not drawn, so it does not tween), a camera's `target`, a light's `intensity`, and a mesh's `material.color` and
 * `material.opacity`. Everything else a state change gives (a light's `color`, `fov`, `geometry`, `material.metalness`,
 * ...) jumps
 */
export const TWEENED_CHANNELS: Readonly<Record<Scene3dTree['kind'], readonly string[]>> = {
    camera: ['position', 'target'],
    light: ['position', 'rotation', 'scale', 'intensity'],
    mesh: ['position', 'rotation', 'scale', 'material.color', 'material.opacity'],
    model: ['position', 'rotation', 'scale'],
    group3d: ['position', 'rotation', 'scale'],
    repeat3d: ['position', 'rotation', 'scale'],
    label3d: ['position', 'rotation', 'scale']
};

/** The position of a light whose node sets none (the `light` shape's default, as `scene.ts` draws it) */
const LIGHT_POSITION: readonly number[] = [5, 10, 5];

const isObject = (value: JsonValue | undefined): value is { [key: string]: JsonValue } => typeof value === 'object' && value !== null && !Array.isArray(value);

const isVector3 = (value: JsonValue | undefined): value is number[] =>
    Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number' && Number.isFinite(n));

const finite = (value: JsonValue | undefined): value is number => typeof value === 'number' && Number.isFinite(value);

/** The raw value of a channel in a node's properties (`material.color` is the `color` of `material`) */
function rawOf(properties: Readonly<Record<string, JsonValue>>, channel: string): JsonValue | undefined {
    if (!channel.startsWith('material.')) return properties[channel];
    const material = properties.material;
    return isObject(material) ? material[channel.slice('material.'.length)] : undefined;
}

/** What `createMotion3d` needs */
export interface Motion3dOptions {
    readonly scheduler: Scheduler;
    /**
     * Reads a custom property of the scene's computed style: the motion tokens a `transition` names
     * (`--ui-motion-duration-fast`, `--ui-motion-easing-standard`); undefined when unset, and the shipped values apply
     */
    readonly read: ReadToken;
    /** A colour value (a literal or a token reference) as sRGB channels, or undefined when it names no colour */
    readonly colorOf: (value: JsonValue) => Rgb | undefined;
}

/** The transitions of a scene's nodes */
export interface Motion3d {
    /**
     * Takes the feeder's new tree: a tweened channel of a node with `transition` whose value changed starts a tween from
     * the value on screen (a running one from where it is); any other change jumps, and so does a node that is new,
     * hidden, or gains `transition` with its change. A node for which `still` is true jumps too (the camera during an
     * orbit gesture, which the controls hold). Gives the tree to draw now
     */
    apply(target: readonly Scene3dTree[], still?: (node: Scene3dTree) => boolean): readonly Scene3dTree[];
    /** The last tree `apply` took, with every running tween at its current value (the same tree when none runs) */
    current(): readonly Scene3dTree[];
    /**
     * Puts properties of a node at these values at once, as the values on screen (the camera an orbit gesture wrote):
     * their tweens stop, and the next tree that brings these values starts none
     */
    settle(path: string, values: Readonly<Record<string, JsonValue>>): void;
    /** Ends the tweens of the nodes `which` picks at once (they show the tree's values); true when one was running */
    finish(which: (node: Scene3dTree) => boolean): boolean;
    /** The number of tweens running */
    readonly running: number;
    /** Forgets everything */
    dispose(): void;
}

/** What a node's `transition` asks for, or undefined when it has none; the same reading as the 2D `timingOf` (G1.8) */
export function timingOf(transition: JsonValue | undefined, read: ReadToken): Timing | undefined {
    if (!isObject(transition)) return undefined;
    const { duration, easing } = transition;
    let ms: number | undefined;
    if (typeof duration === 'number') ms = duration;
    else if (typeof duration === 'string') ms = durationToken(duration, read);
    ms ??= durationToken('base', read) ?? DEFAULT_DURATIONS.base!;
    const curve = (typeof easing === 'string' ? easingToken(easing, read) : undefined) ?? easingToken('standard', read)!;
    return { duration: ms, easing: curve };
}

/** A colour tween value as a CSS colour the scene's resolver and converter take */
export function formatRgb(value: readonly number[]): string {
    const [r, g, b] = value.map((part) => Math.min(255, Math.max(0, Math.round(part))));
    return `rgb(${r}, ${g}, ${b})`;
}

/** The key of a channel of a node in the scheduler */
const keyOf = (path: string, channel: string): string => `${path}\u0000${channel}`;

/**
 * Follows the nodes with `transition` from tree to tree and runs the changes of their tweened channels
 * (`TWEENED_CHANNELS`) through the scheduler. Vectors and numbers tween as numbers; `material.color` tweens in sRGB when
 * both colours resolve (literals or tokens, through `colorOf`). With reduced motion the scheduler jumps every change.
 * The copies of a `repeat3d` (its instances, G3.6) are not followed: a record's change jumps
 */
export function createMotion3d(options: Motion3dOptions): Motion3d {
    const { scheduler, read } = options;
    /** The properties of each node with `transition` in the last tree, by path */
    let previous = new Map<string, Record<string, JsonValue>>();
    /** The nodes of the last tree, by path */
    let nodes = new Map<string, Scene3dTree>();
    /** The running tweens of each node, by path: their channels */
    const active = new Map<string, Set<string>>();
    let target: readonly Scene3dTree[] = [];

    /** A channel's value as the tween takes it, with the default the scene draws for an unset one; undefined when it cannot tween */
    const valueOf = (node: Scene3dTree, channel: string, raw: JsonValue | undefined): TweenValue | undefined => {
        switch (channel) {
            case 'position':
                return isVector3(raw) ? raw : node.kind === 'light' ? LIGHT_POSITION : [0, 0, 0];
            case 'rotation':
            case 'target':
                return isVector3(raw) ? raw : [0, 0, 0];
            case 'scale':
                return isVector3(raw) ? raw : [1, 1, 1];
            case 'intensity':
                return finite(raw) ? Math.min(100, Math.max(0, raw)) : 1;
            case 'material.opacity':
                return finite(raw) ? Math.min(1, Math.max(0, raw)) : 1;
            case 'material.color':
                return options.colorOf(raw === undefined || raw === null || raw === '' ? '#ffffff' : raw);
            default:
                return undefined;
        }
    };

    const stop = (path: string, channel: string): void => {
        const running = active.get(path);
        if (running === undefined || !running.delete(channel)) return;
        if (running.size === 0) active.delete(path);
        scheduler.cancel(keyOf(path, channel));
    };

    const stopAll = (path: string): boolean => {
        const running = active.get(path);
        if (running === undefined) return false;
        for (const channel of [...running]) stop(path, channel);
        return true;
    };

    const start = (path: string, channel: string, from: TweenValue, to: TweenValue, timing: Timing): void => {
        const key = keyOf(path, channel);
        scheduler.tween(key, from, to, timing);
        if (scheduler.valueOf(key) === undefined) {
            stop(path, channel);
            return;
        }
        let running = active.get(path);
        if (running === undefined) {
            running = new Set();
            active.set(path, running);
        }
        running.add(channel);
    };

    /** Starts or stops the tweens of one node against its values in the last tree */
    const follow = (node: Scene3dTree, next: Map<string, Record<string, JsonValue>>, still: boolean): void => {
        const { transition } = node.properties;
        if (!isObject(transition) || node.properties.hidden === true || node.properties.visible === false) {
            stopAll(node.path);
            return;
        }
        const values: Record<string, JsonValue> = { ...node.properties };
        next.set(node.path, values);
        const before = previous.get(node.path);
        if (before === undefined) return;
        let timing: Timing | undefined;
        for (const channel of TWEENED_CHANNELS[node.kind]) {
            const was = rawOf(before, channel);
            const now = rawOf(values, channel);
            if (sameValue(was, now)) continue;
            const from = still ? undefined : valueOf(node, channel, was);
            const to = from === undefined ? undefined : valueOf(node, channel, now);
            if (from === undefined || to === undefined) {
                stop(node.path, channel);
                continue;
            }
            timing ??= timingOf(transition, read);
            if (timing === undefined) stop(node.path, channel);
            else start(node.path, channel, from, to, timing);
        }
    };

    const walk = (trees: readonly Scene3dTree[], next: Map<string, Record<string, JsonValue>>, seen: Map<string, Scene3dTree>, still: (node: Scene3dTree) => boolean): void => {
        for (const node of trees) {
            if (seen.has(node.path)) continue;
            seen.set(node.path, node);
            follow(node, next, still(node));
            // A repeat's copies are instances it compares itself (G3.6): they jump
            if (node.kind !== 'repeat3d') walk(node.children, next, seen, still);
        }
    };

    /** The properties of a node with its running tweens at their values; the same object when none moved */
    const tweenedProperties = (node: Scene3dTree): Readonly<Record<string, JsonValue>> => {
        const running = active.get(node.path);
        if (running === undefined) return node.properties;
        let values: Record<string, JsonValue> | undefined;
        for (const channel of [...running]) {
            const value = scheduler.valueOf(keyOf(node.path, channel));
            if (value === undefined) {
                // Ended: the node shows the value of the tree
                running.delete(channel);
                continue;
            }
            values ??= { ...node.properties };
            if (channel.startsWith('material.')) {
                const material = isObject(values.material) ? { ...values.material } : {};
                material[channel.slice('material.'.length)] = channel === 'material.color' ? formatRgb(value as readonly number[]) : (value as number);
                values.material = material;
            } else {
                values[channel] = typeof value === 'number' ? value : [...value];
            }
        }
        if (running.size === 0) active.delete(node.path);
        return values ?? node.properties;
    };

    /** The trees with every running tween at its value; the same objects where nothing runs */
    const tweened = (trees: readonly Scene3dTree[]): readonly Scene3dTree[] => {
        let changed = false;
        const result = trees.map((node) => {
            const properties = tweenedProperties(node);
            const children = node.children.length === 0 || node.kind === 'repeat3d' ? node.children : tweened(node.children);
            if (properties === node.properties && children === node.children) return node;
            changed = true;
            return { ...node, properties, children };
        });
        return changed ? result : trees;
    };

    return {
        apply(next, still = () => false) {
            target = next;
            const values = new Map<string, Record<string, JsonValue>>();
            const seen = new Map<string, Scene3dTree>();
            walk(next, values, seen, still);
            for (const path of [...active.keys()]) if (!values.has(path)) stopAll(path);
            previous = values;
            nodes = seen;
            return active.size === 0 ? next : tweened(next);
        },
        current() {
            return active.size === 0 ? target : tweened(target);
        },
        settle(path, values) {
            const known = previous.get(path);
            for (const [name, value] of Object.entries(values)) {
                stop(path, name);
                if (known !== undefined) known[name] = value;
            }
        },
        finish(which) {
            let ended = false;
            for (const path of [...active.keys()]) {
                const node = nodes.get(path);
                if (node !== undefined && which(node) && stopAll(path)) ended = true;
            }
            return ended;
        },
        get running() {
            let count = 0;
            for (const [path, channels] of active) for (const channel of channels) if (scheduler.valueOf(keyOf(path, channel)) !== undefined) count += 1;
            return count;
        },
        dispose() {
            for (const path of [...active.keys()]) stopAll(path);
            previous = new Map();
            nodes = new Map();
            target = [];
        }
    };
}
