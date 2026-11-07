import { AmbientLight, DirectionalLight, Mesh, OrthographicCamera, PerspectiveCamera, PointLight } from 'three';
import type { MeshStandardMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { createColorConverter } from './materials.js';
import { LIGHT_SCALE, SceneGraph } from './scene.js';
import type { JsonValue, Node3dKind, Scene3dTree } from './tree.js';

function node(kind: Node3dKind, key: string, properties: Record<string, JsonValue> = {}, children: Scene3dTree[] = []): Scene3dTree {
    const path = `$.app.children.${key}`;
    return { kind, key, path, properties, children: children.map((child) => ({ ...child, path: `${path}.children.${child.key}` })) };
}

const literal = (value: JsonValue): string | undefined => (typeof value === 'string' && value.startsWith('#') ? value : undefined);
const graph = (): SceneGraph => new SceneGraph(literal, createColorConverter(undefined));

describe('SceneGraph (Node, no WebGL)', () => {
    it('should make one object per node, under its parent', () => {
        // Arrange
        const scene = graph();

        // Act
        scene.sync([node('group3d', 'rig', { position: [1, 0, 0] }, [node('mesh', 'box')]), node('light', 'sun'), node('camera', 'eye'), node('model', 'chair')]);

        // Assert
        const rig = scene.objectOf('$.app.children.rig');
        const box = scene.objectOf('$.app.children.rig.children.box');
        expect(scene.size).toBe(5);
        expect(box).toBeInstanceOf(Mesh);
        expect(box?.parent).toBe(rig);
        expect(rig?.position.toArray()).toEqual([1, 0, 0]);
        expect(scene.objectOf('$.app.children.sun')).toBeInstanceOf(DirectionalLight);
        expect(scene.objectOf('$.app.children.eye')).toBeInstanceOf(PerspectiveCamera);
        expect(scene.objectOf('$.app.children.chair')?.children).toEqual([]);
    });

    it('should touch only the object whose position changed, keeping its geometry and material', () => {
        // Arrange
        const scene = graph();
        scene.sync([node('mesh', 'a', { material: { color: '#ff0000' } }), node('mesh', 'b')]);
        const a = scene.objectOf('$.app.children.a') as Mesh;
        const b = scene.objectOf('$.app.children.b') as Mesh;
        const geometry = a.geometry;
        const material = a.material;
        const bGeometry = b.geometry;

        // Act
        scene.sync([node('mesh', 'a', { material: { color: '#ff0000' }, position: [0, 2, 0] }), node('mesh', 'b')]);

        // Assert
        expect(scene.objectOf('$.app.children.a')).toBe(a);
        expect(a.position.y).toBe(2);
        expect(a.geometry).toBe(geometry);
        expect(a.material).toBe(material);
        expect(b.geometry).toBe(bGeometry);
    });

    it('should make a new geometry when the geometry changes, and change the material in place', () => {
        // Arrange
        const scene = graph();
        scene.sync([node('mesh', 'a')]);
        const a = scene.objectOf('$.app.children.a') as Mesh;
        const geometry = a.geometry;
        const material = a.material as MeshStandardMaterial;
        let disposed = false;
        geometry.addEventListener('dispose', () => (disposed = true));

        // Act
        scene.sync([node('mesh', 'a', { geometry: { kind: 'sphere' }, material: { color: '#00ff00', opacity: 0.5 } })]);

        // Assert
        expect(a.geometry).not.toBe(geometry);
        expect(a.geometry.type).toBe('SphereGeometry');
        expect(disposed).toBe(true);
        expect(a.material).toBe(material);
        expect(material.color.getHexString()).toBe('00ff00');
        expect(material.transparent).toBe(true);
    });

    it('should make a light or camera again when its kind changes, and a node again when its component changes', () => {
        // Arrange
        const scene = graph();
        scene.sync([node('light', 'sun'), node('camera', 'eye'), node('group3d', 'rig', {}, [node('mesh', 'box')])]);
        const box = scene.objectOf('$.app.children.rig.children.box');

        // Act
        scene.sync([node('light', 'sun', { kind: 'point' }), node('camera', 'eye', { kind: 'orthographic' }), node('model', 'rig', {}, []), node('group3d', 'other', {}, [])]);
        const sunKind = scene.objectOf('$.app.children.sun');
        scene.sync([node('light', 'sun', { kind: 'point' }), node('group3d', 'rig', {}, [node('mesh', 'box')])]);

        // Assert
        expect(sunKind).toBeInstanceOf(PointLight);
        expect(scene.objectOf('$.app.children.eye')).toBeUndefined();
        expect(scene.objectOf('$.app.children.rig.children.box')).not.toBe(box);
        expect(scene.objectOf('$.app.children.rig.children.box')?.parent).toBe(scene.objectOf('$.app.children.rig'));
    });

    it('should make an orthographic camera and set lights from their colour and intensity', () => {
        // Arrange
        const scene = graph();

        // Act
        scene.sync([node('camera', 'eye', { kind: 'orthographic' }), node('light', 'fill', { kind: 'ambient', color: '#ff0000', intensity: 0.5 })]);

        // Assert
        const fill = scene.objectOf('$.app.children.fill') as AmbientLight;
        expect(scene.objectOf('$.app.children.eye')).toBeInstanceOf(OrthographicCamera);
        expect(fill).toBeInstanceOf(AmbientLight);
        expect(fill.color.getHexString()).toBe('ff0000');
        expect(fill.intensity).toBeCloseTo(0.5 * LIGHT_SCALE);
    });

    it('should hide a node with visible: false or the shared hidden: true, and show it again', () => {
        // Arrange
        const scene = graph();

        // Act
        scene.sync([node('mesh', 'a', { visible: false }), node('mesh', 'b', { hidden: true }), node('mesh', 'c')]);
        const before = ['a', 'b', 'c'].map((key) => scene.objectOf(`$.app.children.${key}`)?.visible);
        scene.sync([node('mesh', 'a'), node('mesh', 'b', { hidden: false }), node('mesh', 'c')]);
        const after = ['a', 'b', 'c'].map((key) => scene.objectOf(`$.app.children.${key}`)?.visible);

        // Assert
        expect(before).toEqual([false, false, true]);
        expect(after).toEqual([true, true, true]);
    });

    it('should remove the nodes that went and free their geometry', () => {
        // Arrange
        const scene = graph();
        scene.sync([node('mesh', 'a'), node('mesh', 'b')]);
        const a = scene.objectOf('$.app.children.a') as Mesh;
        let disposed = false;
        a.geometry.addEventListener('dispose', () => (disposed = true));

        // Act
        scene.sync([node('mesh', 'b')]);

        // Assert
        expect(scene.size).toBe(1);
        expect(a.parent).toBeNull();
        expect(disposed).toBe(true);
    });

    it('should set the background and add the ambient light of an environment other than none', () => {
        // Arrange
        const scene = graph();

        // Act
        scene.applySettings({ background: '#102030', ambient: '#ffffff', environment: 'studio' });
        const lit = scene.scene.children.some((child) => child instanceof AmbientLight);
        scene.applySettings({ ambient: '#ffffff', environment: 'none' });

        // Assert
        expect(lit).toBe(true);
        expect(scene.scene.background).toBeNull();
        expect(scene.scene.children.some((child) => child instanceof AmbientLight)).toBe(false);
    });
});
