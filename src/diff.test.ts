import { describe, expect, it } from 'vitest';
import { changedProperties, diffTrees, flattenTree, sameValue } from './diff.js';
import type { JsonValue, Node3dKind, Scene3dTree } from './tree.js';

function node(kind: Node3dKind, key: string, properties: Record<string, JsonValue> = {}, children: Scene3dTree[] = [], parent = '$.app.children'): Scene3dTree {
    const path = `${parent}.${key}`;
    return { kind, key, path, properties, children: children.map((child) => ({ ...child, path: `${path}.children.${child.key}` })) };
}

describe('sameValue and changedProperties', () => {
    it('should compare JSON values deeply, objects whatever their key order', () => {
        // Assert
        expect(sameValue({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
        expect(sameValue([1, 2, 3], [1, 2])).toBe(false);
        expect(sameValue({ a: 1 }, { a: 1, b: 2 })).toBe(false);
        expect(sameValue(null, {})).toBe(false);
        expect(sameValue(undefined, undefined)).toBe(true);
    });

    it('should list the properties that were set, changed or unset', () => {
        // Act
        const names = changedProperties({ position: [0, 0, 0], material: { color: '#fff' }, visible: true }, { position: [0, 1, 0], material: { color: '#fff' }, scale: [2, 2, 2] });

        // Assert
        expect(names.sort()).toEqual(['position', 'scale', 'visible']);
    });
});

describe('diffTrees', () => {
    it('should list nodes by path, parents before children', () => {
        // Act
        const flat = flattenTree([node('group3d', 'rig', {}, [node('mesh', 'a'), node('mesh', 'b')]), node('light', 'sun')]);

        // Assert
        expect([...flat.keys()]).toEqual(['$.app.children.rig', '$.app.children.rig.children.a', '$.app.children.rig.children.b', '$.app.children.sun']);
        expect(flat.get('$.app.children.rig.children.a')?.parent).toBe('$.app.children.rig');
        expect(flat.get('$.app.children.sun')?.parent).toBeUndefined();
    });

    it('should touch only the node whose position changed, and only its position', () => {
        // Arrange
        const before = [node('mesh', 'box', { position: [0, 0, 0], material: { color: '#ff0000' } }), node('light', 'sun')];
        const after = [node('mesh', 'box', { position: [1, 0, 0], material: { color: '#ff0000' } }), node('light', 'sun')];

        // Act
        const diff = diffTrees(before, after);

        // Assert
        expect(diff.added).toEqual([]);
        expect(diff.removed).toEqual([]);
        expect([...diff.changed]).toEqual([['$.app.children.box', ['position']]]);
    });

    it('should add and remove nodes, and make a node of another kind again', () => {
        // Arrange
        const before = [node('mesh', 'box'), node('light', 'gone'), node('mesh', 'swap')];
        const after = [node('mesh', 'box'), node('group3d', 'swap', {}, [node('mesh', 'inner')]), node('camera', 'eye')];

        // Act
        const diff = diffTrees(before, after);

        // Assert
        expect(diff.removed).toEqual(['$.app.children.gone', '$.app.children.swap']);
        expect(diff.added).toEqual(['$.app.children.swap', '$.app.children.swap.children.inner', '$.app.children.eye']);
        expect(diff.changed.size).toBe(0);
    });

    it('should find nothing to do for the same tree', () => {
        // Arrange
        const tree = [node('group3d', 'rig', { position: [0, 1, 0] }, [node('mesh', 'a', { geometry: { kind: 'sphere' } })])];

        // Act
        const diff = diffTrees(tree, structuredClone(tree));

        // Assert
        expect(diff).toEqual({ added: [], removed: [], changed: new Map() });
    });
});
