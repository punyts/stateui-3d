import { AmbientLight, Color, DirectionalLight, Fog, Mesh, OrthographicCamera, PerspectiveCamera, PointLight, Texture } from 'three';
import type { MeshStandardMaterial } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { activeCamera } from './cameras.js';
import { createColorConverter } from './materials.js';
import { LIGHT_SCALE, SHADOW_MAP_SIZE, SceneGraph } from './scene.js';
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

    it('should set the background and the lights of the environment preset, and none for none', () => {
        // Arrange
        const scene = graph();

        // Act
        scene.applySettings({ background: '#102030', ambient: '#ff0000', environment: 'studio' });
        const studio = [...scene.environment.children];
        const background = (scene.scene.background as Color).getHexString();
        scene.applySettings({ ambient: '#ffffff', environment: 'none' });

        // Assert: studio's ambient light takes the scene's ambient colour
        expect(studio.map((light) => light.type)).toEqual(['AmbientLight', 'DirectionalLight', 'DirectionalLight']);
        expect((studio[0] as AmbientLight).color.getHexString()).toBe('ff0000');
        expect((studio[0] as AmbientLight).intensity).toBeCloseTo(0.4 * LIGHT_SCALE);
        expect((studio[1] as DirectionalLight).position.toArray()).toEqual([3, 5, 8]);
        expect(background).toBe('102030');
        expect(scene.scene.background).toBeNull();
        expect(scene.environment.children).toEqual([]);
        expect(scene.environmentPreset).toBe('none');
    });

    it('should take the preset background when the scene sets none, and studio when no environment is given', () => {
        // Arrange
        const scene = graph();

        // Act
        scene.applySettings({});
        const studio = { preset: scene.environmentPreset, background: (scene.scene.background as Color).getHexString(), ambient: (scene.environment.children[0] as AmbientLight).color.getHexString() };
        scene.applySettings({ environment: 'daylight' });

        // Assert: studio's ambient light is white while the scene's ambient colour is unset
        expect(studio).toEqual({ preset: 'studio', background: new Color('#e9ebee').getHexString(), ambient: 'ffffff' });
        expect((scene.scene.background as Color).getHexString()).toBe(new Color('#cfe6ff').getHexString());
        expect(scene.environment.children.map((light) => light.type)).toEqual(['HemisphereLight', 'DirectionalLight']);
    });

    it('should switch the environment without making any node again, and free the lights of the last preset', () => {
        // Arrange
        const scene = graph();
        scene.sync([node('mesh', 'box'), node('light', 'sun'), node('camera', 'eye')]);
        scene.applySettings({ environment: 'studio' });
        const objects = ['box', 'sun', 'eye'].map((key) => scene.objectOf(`$.app.children.${key}`));
        const studio = scene.environment.children[1] as DirectionalLight;
        const dispose = vi.spyOn(studio, 'dispose');

        // Act
        scene.applySettings({ environment: 'neutral' });
        const neutral = scene.environment.children[0];
        scene.applySettings({ environment: 'neutral', background: '#000000' });

        // Assert
        expect(['box', 'sun', 'eye'].map((key) => scene.objectOf(`$.app.children.${key}`))).toEqual(objects);
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(studio.parent).toBeNull();
        expect(scene.environment.children).toEqual([neutral]);
    });

    it('should draw fog of the given colour and distances, the background colour without one, and none again', () => {
        // Arrange
        const scene = graph();

        // Act
        scene.applySettings({ background: '#102030', environment: 'none', fog: { color: '#ff0000', near: 2, far: 30 } });
        const fog = scene.scene.fog as Fog;
        const first = { color: fog.color.getHexString(), near: fog.near, far: fog.far };
        scene.applySettings({ background: '#102030', environment: 'none', fog: { near: 5 } });
        const same = scene.scene.fog;
        const second = { color: fog.color.getHexString(), near: fog.near, far: fog.far };
        scene.applySettings({ background: '#102030', environment: 'none' });

        // Assert: one fog object while there is fog (a new one would compile the programs again)
        expect(first).toEqual({ color: 'ff0000', near: 2, far: 30 });
        expect(same).toBe(fog);
        expect(second).toEqual({ color: '102030', near: 5, far: 100 });
        expect(scene.scene.fog).toBeNull();
    });

    it('should keep every node when the active camera changes', () => {
        // Arrange
        const scene = graph();
        const tree = (active: 'a' | 'b') => [node('camera', 'a', { active: active === 'a' }), node('camera', 'b', { active: active === 'b' }), node('mesh', 'box')];
        scene.sync(tree('a'));
        const objects = ['a', 'b', 'box'].map((key) => scene.objectOf(`$.app.children.${key}`));

        // Act
        scene.sync(tree('b'));

        // Assert
        expect(['a', 'b', 'box'].map((key) => scene.objectOf(`$.app.children.${key}`))).toEqual(objects);
        expect(activeCamera(scene.tree)?.key).toBe('b');
    });

    it('should make a light with shadows cast them, never an ambient one, and want the shadow map while one does', () => {
        // Arrange
        const scene = graph();

        // Act
        scene.sync([node('light', 'sun', { shadows: true }), node('light', 'fill', { kind: 'ambient', shadows: true }), node('mesh', 'box', { castShadow: true, receiveShadow: true })]);
        const sun = scene.objectOf('$.app.children.sun') as DirectionalLight;
        const wanted = scene.wantsShadows;
        scene.sync([node('light', 'sun'), node('light', 'fill', { kind: 'ambient', shadows: true }), node('mesh', 'box', { castShadow: true, receiveShadow: true })]);

        // Assert
        expect(wanted).toBe(true);
        expect(sun.shadow.mapSize.toArray()).toEqual([SHADOW_MAP_SIZE, SHADOW_MAP_SIZE]);
        expect(scene.objectOf('$.app.children.fill')?.castShadow).toBe(false);
        expect(scene.objectOf('$.app.children.box')).toMatchObject({ castShadow: true, receiveShadow: true });
        expect(sun.castShadow).toBe(false);
        expect(scene.wantsShadows).toBe(false);
    });

    it('should resolve every colour again on restyle, keeping the objects', () => {
        // Arrange
        let accent = '#ff0000';
        const resolve = (value: JsonValue): string | undefined => (value === '{accent}' ? accent : literal(value));
        const scene = new SceneGraph(resolve, createColorConverter(undefined));
        scene.sync([node('mesh', 'box', { material: { color: '{accent}' } }), node('light', 'sun', { color: '{accent}' })]);
        scene.applySettings({ background: '{accent}', ambient: '{accent}', environment: 'studio', fog: { color: '{accent}' } });
        const box = scene.objectOf('$.app.children.box') as Mesh;
        const material = box.material as MeshStandardMaterial;

        // Act
        accent = '#00ff00';
        scene.restyle();

        // Assert
        expect(scene.objectOf('$.app.children.box')).toBe(box);
        expect(box.material).toBe(material);
        expect(material.color.getHexString()).toBe('00ff00');
        expect((scene.objectOf('$.app.children.sun') as DirectionalLight).color.getHexString()).toBe('00ff00');
        expect((scene.scene.background as Color).getHexString()).toBe('00ff00');
        expect((scene.environment.children[0] as AmbientLight).color.getHexString()).toBe('00ff00');
        expect((scene.scene.fog as Fog).color.getHexString()).toBe('00ff00');
    });

    it('should free every geometry, material and texture and the environment lights on clear', () => {
        // Arrange
        const scene = graph();
        scene.sync([node('mesh', 'a'), node('group3d', 'rig', {}, [node('mesh', 'b')])]);
        scene.applySettings({ environment: 'daylight', fog: {} });
        const meshes = ['$.app.children.a', '$.app.children.rig.children.b'].map((path) => scene.objectOf(path) as Mesh);
        const texture = new Texture();
        (meshes[0]?.material as MeshStandardMaterial).map = texture;
        const freed: string[] = [];
        meshes.forEach((mesh, index) => {
            mesh.geometry.addEventListener('dispose', () => freed.push(`geometry ${index}`));
            (mesh.material as MeshStandardMaterial).addEventListener('dispose', () => freed.push(`material ${index}`));
        });
        texture.addEventListener('dispose', () => freed.push('texture'));
        const lights = [...scene.environment.children].map((light) => vi.spyOn(light as DirectionalLight, 'dispose'));

        // Act
        scene.clear();

        // Assert
        expect(freed.sort()).toEqual(['geometry 0', 'geometry 1', 'material 0', 'material 1', 'texture']);
        expect(lights.every((spy) => spy.mock.calls.length === 1)).toBe(true);
        expect(scene.size).toBe(0);
        expect(scene.environment.children).toEqual([]);
        expect(scene.scene.fog).toBeNull();
    });
});
