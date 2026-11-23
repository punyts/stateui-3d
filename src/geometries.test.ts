import { describe, expect, it } from 'vitest';
import { GEOMETRY_KINDS, MAX_EDIT_FACES, MAX_EDIT_VERTICES, MAX_FACE_SIDES, MAX_SEGMENTS, MAX_SIZE, MIN_SEGMENTS, createGeometry, geometryParams } from './geometries.js';
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

    it.each(GEOMETRY_KINDS.filter((kind) => kind !== 'custom'))('should make a %s geometry with vertices', (kind) => {
        // Act
        const geometry = createGeometry(geometryParams({ kind, segments: 8 }));

        // Assert
        expect(geometry.getAttribute('position').count).toBeGreaterThan(0);
        geometry.dispose();
    });
});

describe('custom geometry', () => {
    /** A unit cube about the origin: eight corners and six square faces, counter-clockwise from outside */
    const cube = {
        kind: 'custom',
        vertices: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5], [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]],
        faces: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]]
    };

    it('should read the vertices, the faces and flat shading by default', () => {
        // Act
        const params = geometryParams(cube);

        // Assert
        expect(params).toEqual({ kind: 'custom', vertices: cube.vertices, faces: cube.faces, shading: 'flat' });
    });

    it('should leave out the faces that cannot be drawn and name the first', () => {
        // Arrange
        const value = { ...cube, vertices: [...cube.vertices, [0, 'up', 0]], faces: [[0, 1], [0, 3, 2, 1], [0, 1, 8], [0, 1, 1], [0, 1, 99], [1, 2, 2.5]] };

        // Act
        const params = geometryParams(value);

        // Assert
        expect(params).toMatchObject({ kind: 'custom', faces: [[0, 3, 2, 1]], bad: 0 });
    });

    it('should keep at most the limits of vertices, faces and sides, and cut coordinates to the largest size', () => {
        // Arrange
        const vertices = Array.from({ length: MAX_EDIT_VERTICES + 5 }, () => [0, 0, 1e9]);
        const faces = Array.from({ length: MAX_EDIT_FACES + 1 }, () => [0, 1, 2]);
        const wide = Array.from({ length: MAX_FACE_SIDES + 1 }, (_, index) => index);

        // Act
        const params = geometryParams({ kind: 'custom', vertices, faces: [...faces.slice(1), wide] });
        const one = geometryParams({ kind: 'custom', vertices, faces });

        // Assert
        if (params.kind !== 'custom' || one.kind !== 'custom') throw new Error('not custom');
        expect(params.vertices).toHaveLength(MAX_EDIT_VERTICES);
        expect(params.vertices[0]).toEqual([0, 0, MAX_SIZE]);
        expect(params.bad).toBe(MAX_EDIT_FACES);
        expect(one.faces).toHaveLength(MAX_EDIT_FACES);
        expect(one.bad).toBe(MAX_EDIT_FACES);
    });

    it('should draw each face as a fan of triangles, with a face its own normal when flat', () => {
        // Act
        const geometry = createGeometry(geometryParams(cube));

        // Assert: six squares are twelve triangles, each corner its own
        const position = geometry.getAttribute('position');
        const normal = geometry.getAttribute('normal');
        expect(geometry.getIndex()).toBeNull();
        expect(position.count).toBe(36);
        expect([normal.getX(0), normal.getY(0), normal.getZ(0)].map((value) => Math.round(value) + 0)).toEqual([0, 0, -1]);
        expect([normal.getX(6), normal.getY(6), normal.getZ(6)].map((value) => Math.round(value) + 0)).toEqual([0, 0, 1]);
        geometry.dispose();
    });

    it('should share the vertices and average the normals at a corner when smooth', () => {
        // Act
        const geometry = createGeometry(geometryParams({ ...cube, shading: 'smooth' }));

        // Assert: the corner at (0.5, 0.5, 0.5) points out along its diagonal
        const normal = geometry.getAttribute('normal');
        const third = 1 / Math.sqrt(3);
        expect(geometry.getAttribute('position').count).toBe(8);
        expect(geometry.getIndex()?.count).toBe(36);
        expect(normal.getX(6)).toBeCloseTo(third);
        expect(normal.getY(6)).toBeCloseTo(third);
        expect(normal.getZ(6)).toBeCloseTo(third);
        geometry.dispose();
    });

    it('should make an empty geometry of no faces', () => {
        // Act
        const geometry = createGeometry(geometryParams({ kind: 'custom', vertices: [], faces: [] }));

        // Assert
        expect(geometry.getAttribute('position').count).toBe(0);
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
