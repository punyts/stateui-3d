import { describe, expect, it } from 'vitest';
import { GEOMETRY_KINDS, MAX_SEGMENTS, MAX_SIZE, MIN_SEGMENTS, createGeometry, geometryParams } from './geometries.js';
import { materialParams } from './materials.js';

describe('geometryParams', () => {
    it('should be a unit box for no geometry, a value that is not an object or an unknown kind', () => {
        // Act and assert
        for (const value of [undefined, null, 'box', [1], { kind: 'teapot' }]) {
            expect(geometryParams(value)).toEqual({ kind: 'box', width: 1, height: 1, depth: 1 });
        }
    });

    it('should keep the sizes given and fill in the rest with defaults', () => {
        // Act and assert
        expect(geometryParams({ kind: 'box', width: 2, depth: 0 })).toEqual({ kind: 'box', width: 2, height: 1, depth: 0 });
        expect(geometryParams({ kind: 'sphere', radius: 3 })).toEqual({ kind: 'sphere', radius: 3, segments: 32 });
        expect(geometryParams({ kind: 'cylinder', radius: 2, radiusTop: 1 })).toEqual({ kind: 'cylinder', radiusTop: 1, radiusBottom: 2, height: 1, segments: 32 });
        expect(geometryParams({ kind: 'cone' })).toEqual({ kind: 'cone', radius: 0.5, height: 1, segments: 32 });
        expect(geometryParams({ kind: 'plane', width: 4, height: 3 })).toEqual({ kind: 'plane', width: 4, height: 3 });
        expect(geometryParams({ kind: 'torus', tube: 0.3 })).toEqual({ kind: 'torus', radius: 0.4, tube: 0.3, segments: 48 });
        expect(geometryParams({ kind: 'capsule', radius: 0.5, height: 2 })).toEqual({ kind: 'capsule', radius: 0.5, height: 2, segments: 16 });
    });

    it('should cap the segments between the fewest and the most, rounded', () => {
        // Act and assert
        expect(geometryParams({ kind: 'sphere', segments: 100_000 })).toMatchObject({ segments: MAX_SEGMENTS });
        expect(geometryParams({ kind: 'sphere', segments: 1 })).toMatchObject({ segments: MIN_SEGMENTS });
        expect(geometryParams({ kind: 'cone', segments: 7.6 })).toMatchObject({ segments: 8 });
        expect(geometryParams({ kind: 'torus', segments: Number.NaN })).toMatchObject({ segments: 48 });
    });

    it('should take the default for a size that is negative or not a number, and cut a huge one', () => {
        // Act and assert
        expect(geometryParams({ kind: 'box', width: -2, height: 'tall', depth: 1e9 })).toEqual({ kind: 'box', width: 1, height: 1, depth: MAX_SIZE });
        expect(geometryParams({ kind: 'sphere', radius: Number.POSITIVE_INFINITY })).toMatchObject({ radius: 0.5 });
    });

    it.each(GEOMETRY_KINDS)('should make a %s geometry with vertices', (kind) => {
        // Act
        const geometry = createGeometry(geometryParams({ kind, segments: 8 }));

        // Assert
        expect(geometry.getAttribute('position').count).toBeGreaterThan(0);
        geometry.dispose();
    });
});

describe('materialParams', () => {
    const resolve = (value: unknown): string | undefined => (value === '{color.accent.base}' ? '#3b82f6' : typeof value === 'string' && value.startsWith('#') ? value : undefined);

    it('should be a matte white for no material', () => {
        // Act and assert
        expect(materialParams(undefined, resolve)).toEqual({ color: '#ffffff', metalness: 0, roughness: 1, opacity: 1, emissive: undefined });
    });

    it('should resolve colours and tokens and keep numbers in 0..1', () => {
        // Act
        const params = materialParams({ color: '{color.accent.base}', metalness: 2, roughness: -1, opacity: 0.5, emissive: '#110000' }, resolve);

        // Assert
        expect(params).toEqual({ color: '#3b82f6', metalness: 1, roughness: 0, opacity: 0.5, emissive: '#110000' });
    });

    it('should be white for a colour that resolves to nothing', () => {
        // Act and assert
        expect(materialParams({ color: '{color.missing}' }, resolve).color).toBe('#ffffff');
    });
});
