import type { JsonValue, Scene3dTree } from './tree.js';

/** One node of a tree with the path of its parent node (undefined at the top), as `flattenTree` lists it */
export interface FlatNode {
    readonly tree: Scene3dTree;
    readonly parent: string | undefined;
}

/** What changed between two trees, by node path */
export interface TreeDiff {
    /** The paths of nodes that are new, or whose kind changed (made again), parents before their children */
    readonly added: readonly string[];
    /** The paths of nodes that are gone, or whose kind changed */
    readonly removed: readonly string[];
    /** The nodes kept, with the names of the properties whose values differ (set, changed or unset) */
    readonly changed: ReadonlyMap<string, readonly string[]>;
}

/**
 * The nodes of a tree by path, parents before their children, in the order of the tree. A `repeat3d`'s `children` (its
 * copies, one per record) are not nodes: the repeat draws them as instances and compares them itself (G3.6)
 */
export function flattenTree(trees: readonly Scene3dTree[], parent?: string, into = new Map<string, FlatNode>()): Map<string, FlatNode> {
    for (const tree of trees) {
        if (into.has(tree.path)) continue;
        into.set(tree.path, { tree, parent });
        if (tree.kind !== 'repeat3d') flattenTree(tree.children, tree.path, into);
    }
    return into;
}

/** True when two JSON values are equal, objects compared key by key whatever their order */
export function sameValue(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        return a.every((item, index) => sameValue(item, b[index]));
    }
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
}

/** The names of the properties whose values differ between two property sets: set, changed or unset */
export function changedProperties(before: Readonly<Record<string, JsonValue>>, after: Readonly<Record<string, JsonValue>>): string[] {
    const names = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...names].filter((name) => !sameValue(before[name], after[name]));
}

/**
 * Compares two trees node by node (a node is its path): a node of another kind at the same path is removed and added
 * again; a kept node lists the properties that changed, so the scene touches only those. Pure
 */
export function diffTrees(before: readonly Scene3dTree[], after: readonly Scene3dTree[]): TreeDiff {
    const old = flattenTree(before);
    const next = flattenTree(after);
    const added: string[] = [];
    const removed: string[] = [];
    const changed = new Map<string, readonly string[]>();
    for (const [path, { tree }] of old) {
        const kept = next.get(path);
        if (kept === undefined || kept.tree.kind !== tree.kind) removed.push(path);
    }
    for (const [path, { tree }] of next) {
        const was = old.get(path);
        if (was === undefined || was.tree.kind !== tree.kind) {
            added.push(path);
            continue;
        }
        const names = changedProperties(was.tree.properties, tree.properties);
        if (names.length > 0) changed.set(path, names);
    }
    return { added, removed, changed };
}
