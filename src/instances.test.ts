import { Group, InstancedMesh, Matrix4, Raycaster, Vector3 } from 'three';
import type { MeshStandardMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { flattenTree } from './diff.js';
import { INSTANCE_CAP, InstanceLayout, MAX_UPDATE_RANGES, MIN_INSTANCE_CAPACITY, RepeatInstances, instanceCapacity, instanceMatrix, instanceValues } from './instances.js';
import { createColorConverter } from './materials.js';
import { SceneGraph } from './scene.js';
import type { JsonValue, Scene3dTree } from './tree.js';

const REPEAT = '$.app.children.crates';

/** The copy of a repeat's row for one record, as the feeder binds it */
const copy = (key: string, properties: Record<string, JsonValue> = {}): Scene3dTree => ({
    kind: 'mesh',
    key,
    path: `${REPEAT}.rows.${key}`,
    properties: { geometry: { kind: 'box' }, ...properties },
    children: []
});

/** `count` copies keyed `r<n>`, one unit apart along x */
const copies = (count: number, color = '#ff0000'): Scene3dTree[] =>
    Array.from({ length: count }, (_, index) => copy(`r${index}`, { position: [index, 0, 0], material: { color } }));

const literal = (value: JsonValue): string | undefined => (typeof value === 'string' && value.startsWith('#') ? value : undefined);
const repeat = (): { group: Group; instances: RepeatInstances } => {
    const group = new Group();
    return { group, instances: new RepeatInstances(group, literal, createColorConverter(undefined)) };
};

describe('instanceCapacity (G3.6)', () => {
    it('should grow in powers of two from the minimum, capped at 20,000', () => {
        // Assert
        expect(instanceCapacity(0)).toBe(MIN_INSTANCE_CAPACITY);
        expect(instanceCapacity(1)).toBe(16);
        expect(instanceCapacity(17)).toBe(32);
        expect(instanceCapacity(10_000)).toBe(16_384);
        expect(instanceCapacity(20_000)).toBe(INSTANCE_CAP);
        expect(instanceCapacity(50_000)).toBe(INSTANCE_CAP);
    });

    it('should keep the buffer while the count fits and fills more than a quarter of it, and shrink below that', () => {
        // Assert
        expect(instanceCapacity(32, 32)).toBe(32);
        expect(instanceCapacity(33, 32)).toBe(64);
        expect(instanceCapacity(17, 64)).toBe(64);
        expect(instanceCapacity(16, 64)).toBe(16);
        expect(instanceCapacity(1, 16)).toBe(16);
    });

    it('should reallocate a few times, not once per record, while records are added one by one', () => {
        // Arrange
        let capacity = 0;
        let reallocations = 0;

        // Act
        for (let count = 1; count <= 10_000; count++) {
            const next = instanceCapacity(count, capacity);
            if (next !== capacity) reallocations += 1;
            capacity = next;
        }

        // Assert: 16, 32, ... 16,384
        expect(reallocations).toBe(11);
    });
});

describe('InstanceLayout (G3.6)', () => {
    it('should give each record an index in record order and the record key by index', () => {
        // Arrange
        const layout = new InstanceLayout();

        // Act
        const changes = layout.sync(copies(3));

        // Assert
        expect(changes).toEqual({ count: 3, matrices: [0, 1, 2], colors: [0, 1, 2] });
        expect([0, 1, 2].map((index) => layout.keyAt(index))).toEqual(['r0', 'r1', 'r2']);
        expect(layout.treeAt(1)?.path).toBe(`${REPEAT}.rows.r1`);
        expect(layout.indexOf('r2')).toBe(2);
        expect(layout.keyAt(3)).toBeUndefined();
    });

    it('should change one matrix when one record moves, and one colour when one record is recoloured', () => {
        // Arrange
        const layout = new InstanceLayout();
        const before = copies(4);
        layout.sync(before);
        const moved = before.map((tree) => (tree.key === 'r2' ? copy('r2', { position: [9, 9, 9], material: { color: '#ff0000' } }) : tree));
        const recoloured = moved.map((tree) => (tree.key === 'r1' ? copy('r1', { position: [1, 0, 0], material: { color: '#00ff00' } }) : tree));

        // Act
        const move = layout.sync(moved);
        const recolour = layout.sync(recoloured);
        const same = layout.sync(recoloured.map((tree) => ({ ...tree })));

        // Assert
        expect(move).toEqual({ count: 4, matrices: [2], colors: [] });
        expect(recolour).toEqual({ count: 4, matrices: [], colors: [1] });
        expect(same).toEqual({ count: 4, matrices: [], colors: [] });
    });

    it('should add a record at the next index and fill a removed record’s index with the last one', () => {
        // Arrange
        const layout = new InstanceLayout();
        layout.sync(copies(4));

        // Act: r1 goes, r4 comes
        const changes = layout.sync([...copies(4).filter((tree) => tree.key !== 'r1'), copy('r4', { position: [4, 0, 0] })]);

        // Assert: r3 moved into index 1, r4 took index 3
        expect(changes).toEqual({ count: 4, matrices: [1, 3], colors: [1, 3] });
        expect([0, 1, 2, 3].map((index) => layout.keyAt(index))).toEqual(['r0', 'r3', 'r2', 'r4']);
        expect(layout.indexOf('r1')).toBeUndefined();
        expect(layout.valuesAt(1)?.position).toEqual([3, 0, 0]);
    });

    it('should empty, removing the last record, and take the first copy of a key given twice', () => {
        // Arrange
        const layout = new InstanceLayout();
        layout.sync(copies(2));

        // Act
        const empty = layout.sync([]);
        const twice = layout.sync([copy('a', { position: [1, 0, 0] }), copy('a', { position: [2, 0, 0] })]);

        // Assert
        expect(empty).toEqual({ count: 0, matrices: [], colors: [] });
        expect(twice.count).toBe(1);
        expect(layout.valuesAt(0)?.position).toEqual([1, 0, 0]);
    });

    it('should take at most INSTANCE_CAP copies', () => {
        // Act
        const changes = new InstanceLayout().sync(Array.from({ length: INSTANCE_CAP + 5 }, (_, index) => copy(`k${index}`)));

        // Assert
        expect(changes.count).toBe(INSTANCE_CAP);
    });
});

describe('instanceValues and instanceMatrix (G3.6)', () => {
    it('should place, turn in degrees and scale an instance, and draw a hidden one at scale zero', () => {
        // Arrange
        const values = instanceValues(copy('a', { position: [1, 2, 3], rotation: [0, 90, 0], scale: [2, 2, 2] }));

        // Act
        const point = new Vector3(1, 0, 0).applyMatrix4(instanceMatrix(values));
        const hidden = instanceMatrix(instanceValues(copy('b', { position: [1, 2, 3], hidden: true })));

        // Assert: x turned 90 degrees about y points to -z, twice as long, then moved
        expect(point.x).toBeCloseTo(1);
        expect(point.y).toBeCloseTo(2);
        expect(point.z).toBeCloseTo(1);
        expect(new Vector3().setFromMatrixScale(hidden).toArray()).toEqual([0, 0, 0]);
        expect(instanceValues(copy('c', { visible: false })).shown).toBe(false);
        expect(instanceValues(copy('d')).color).toBeUndefined();
    });
});

describe('RepeatInstances (Node, no WebGL)', () => {
    it('should draw the copies as one instanced mesh with a white material and a colour per instance', () => {
        // Arrange
        const { group, instances } = repeat();

        // Act
        instances.sync([copy('a', { material: { color: '#ff0000', roughness: 0.5 } }), copy('b', { position: [2, 0, 0], material: { color: '#0000ff' } })]);

        // Assert
        const mesh = instances.instanced as InstancedMesh;
        expect(group.children).toEqual([mesh]);
        expect(mesh.count).toBe(2);
        expect(mesh.instanceMatrix.count).toBe(MIN_INSTANCE_CAPACITY);
        expect((mesh.material as MeshStandardMaterial).color.getHexString()).toBe('ffffff');
        expect((mesh.material as MeshStandardMaterial).roughness).toBe(0.5);
        expect(mesh.instanceColor?.getX(0)).toBeCloseTo(1);
        expect(mesh.instanceColor?.getZ(0)).toBeCloseTo(0);
        expect(mesh.instanceColor?.getZ(1)).toBeCloseTo(1);
        expect(new Vector3().setFromMatrixPosition(new Matrix4().fromArray(mesh.instanceMatrix.array, 16)).x).toBe(2);
    });

    it('should upload one matrix and one colour when one record changes', () => {
        // Arrange
        const { instances } = repeat();
        instances.sync(copies(100));
        const mesh = instances.instanced as InstancedMesh;
        // The renderer uploads the new buffers whole at the next frame
        mesh.instanceMatrix.onUploadCallback();
        mesh.instanceColor?.onUploadCallback();
        const matrixVersion = mesh.instanceMatrix.version;

        // Act
        const next = copies(100);
        next[42] = copy('r42', { position: [0, 5, 0], material: { color: '#00ff00' } });
        instances.sync(next);

        // Assert
        expect(instances.instanced).toBe(mesh);
        expect(mesh.instanceMatrix.version).toBe(matrixVersion + 1);
        expect(mesh.instanceMatrix.updateRanges).toEqual([{ start: 42 * 16, count: 16 }]);
        expect(mesh.instanceColor?.updateRanges).toEqual([{ start: 42 * 3, count: 3 }]);
    });

    it('should upload the whole buffer when more than MAX_UPDATE_RANGES records change before a frame', () => {
        // Arrange
        const { instances } = repeat();
        instances.sync(copies(200));
        const mesh = instances.instanced as InstancedMesh;
        mesh.instanceMatrix.onUploadCallback();

        // Act
        instances.sync(copies(200).map((tree, index) => (index <= MAX_UPDATE_RANGES ? copy(tree.key, { position: [index, 1, 0], material: { color: '#ff0000' } }) : tree)));

        // Assert
        expect(mesh.instanceMatrix.updateRanges).toEqual([]);
    });

    it('should keep the whole upload asked for when one record changes before the frame', () => {
        // Arrange: a new buffer is uploaded whole at its first frame
        const { instances } = repeat();
        instances.sync(copies(10));
        const mesh = instances.instanced as InstancedMesh;

        // Act
        instances.sync([copy('r0', { position: [7, 0, 0], material: { color: '#ff0000' } }), ...copies(10).slice(1)]);

        // Assert
        expect(mesh.instanceMatrix.updateRanges).toEqual([]);
    });

    it('should allocate a bigger buffer in steps as the count grows, freeing the old one', () => {
        // Arrange
        const { group, instances } = repeat();
        instances.sync(copies(16));
        const small = instances.instanced as InstancedMesh;
        let freed = false;
        small.addEventListener('dispose', () => (freed = true));

        // Act
        instances.sync(copies(17));
        const grown = instances.instanced as InstancedMesh;
        instances.sync(copies(30));

        // Assert
        expect(grown).not.toBe(small);
        expect(grown.instanceMatrix.count).toBe(32);
        expect(instances.instanced).toBe(grown);
        expect(grown.count).toBe(30);
        expect(freed).toBe(true);
        expect(group.children).toEqual([grown]);
        expect(grown.geometry).toBe(small.geometry);
    });

    it('should draw nothing and free the mesh, geometry and material for an empty set, and draw again after it', () => {
        // Arrange
        const { group, instances } = repeat();
        instances.sync(copies(3));
        const mesh = instances.instanced as InstancedMesh;
        const freed: string[] = [];
        mesh.geometry.addEventListener('dispose', () => freed.push('geometry'));
        (mesh.material as MeshStandardMaterial).addEventListener('dispose', () => freed.push('material'));
        mesh.addEventListener('dispose', () => freed.push('mesh'));

        // Act
        instances.sync([]);
        const empty = { children: group.children.length, count: instances.count };
        instances.sync(copies(1));

        // Assert
        expect(freed.sort()).toEqual(['geometry', 'material', 'mesh']);
        expect(empty).toEqual({ children: 0, count: 0 });
        expect(instances.count).toBe(1);
    });

    it('should share the first copy’s geometry, making it again when it changes', () => {
        // Arrange
        const { instances } = repeat();
        instances.sync([copy('a'), copy('b', { geometry: { kind: 'sphere' } })]);
        const mesh = instances.instanced as InstancedMesh;
        const box = mesh.geometry;

        // Act
        instances.sync([copy('a', { geometry: { kind: 'sphere' } }), copy('b', { geometry: { kind: 'sphere' } })]);

        // Assert
        expect(box.type).toBe('BoxGeometry');
        expect(mesh.geometry.type).toBe('SphereGeometry');
    });

    it('should give the record key of the instance a ray hits', () => {
        // Arrange
        const { group, instances } = repeat();
        instances.sync([copy('left', { position: [-2, 0, 0] }), copy('right', { position: [2, 0, 0], interactive: true })]);
        group.updateMatrixWorld(true);
        const raycaster = new Raycaster(new Vector3(2, 0, 5), new Vector3(0, 0, -1));

        // Act
        const [hit] = raycaster.intersectObject(group, true);

        // Assert
        expect(hit?.instanceId).toBe(1);
        expect(instances.layout.keyAt(hit?.instanceId ?? -1)).toBe('right');
        expect((hit?.object.userData.layout as InstanceLayout).treeAt(1)?.path).toBe(`${REPEAT}.rows.right`);
    });

    it('should give the world bounds of one instance by record key', () => {
        // Arrange
        const { group, instances } = repeat();
        group.position.set(0, 10, 0);
        instances.sync([copy('a', { position: [2, 0, 0] })]);

        // Act
        const bounds = instances.boundsOf('a');

        // Assert
        expect(bounds?.min.toArray()).toEqual([1.5, 9.5, -0.5]);
        expect(bounds?.max.toArray()).toEqual([2.5, 10.5, 0.5]);
        expect(instances.boundsOf('b')).toBeUndefined();
    });
});

describe('SceneGraph with a repeat3d (G3.6)', () => {
    const repeatNode = (children: Scene3dTree[], properties: Record<string, JsonValue> = {}): Scene3dTree => ({ kind: 'repeat3d', key: 'crates', path: REPEAT, properties, children });

    it('should make one object for the repeat, not one per copy, and draw the copies as its instances', () => {
        // Arrange
        const scene = new SceneGraph(literal, createColorConverter(undefined));

        // Act
        scene.sync([repeatNode(copies(50), { position: [0, 1, 0] })]);

        // Assert
        expect(flattenTree([repeatNode(copies(50))]).size).toBe(1);
        expect(scene.size).toBe(1);
        expect(scene.instances).toBe(50);
        expect(scene.objectOf(REPEAT)?.position.y).toBe(1);
        expect(scene.objectOf(`${REPEAT}.rows.r0`)).toBeUndefined();
        expect(scene.instanceBounds(`${REPEAT}.rows.r3`)?.getCenter(new Vector3()).toArray()).toEqual([3, 1, 0]);
    });

    it('should follow the copies on each sync, recolour on restyle and free the instances with the node', () => {
        // Arrange
        let red = '#ff0000';
        const scene = new SceneGraph((value) => (value === '{accent}' ? red : literal(value)), createColorConverter(undefined));
        scene.sync([repeatNode([copy('a', { material: { color: '{accent}' } })])]);
        const mesh = scene.repeatOf(REPEAT)?.instanced as InstancedMesh;
        let freed = false;
        mesh.addEventListener('dispose', () => (freed = true));

        // Act
        scene.sync([repeatNode([copy('a', { material: { color: '{accent}' } }), copy('b')])]);
        const count = scene.instances;
        red = '#00ff00';
        scene.restyle();
        const green = mesh.instanceColor?.getY(0);
        scene.sync([]);

        // Assert
        expect(count).toBe(2);
        expect(green).toBeCloseTo(1);
        expect(freed).toBe(true);
        expect(scene.instances).toBe(0);
        expect(scene.repeatOf(REPEAT)).toBeUndefined();
    });
});
