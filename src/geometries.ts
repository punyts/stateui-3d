import { BoxGeometry, BufferGeometry, CapsuleGeometry, ConeGeometry, CylinderGeometry, Float32BufferAttribute, PlaneGeometry, SphereGeometry, TorusGeometry } from 'three';
import type { JsonValue } from './tree.js';

/** The geometry kinds of a `mesh` (`geometry.kind`) */
export const GEOMETRY_KINDS = ['box', 'sphere', 'cylinder', 'cone', 'plane', 'torus', 'capsule', 'custom'] as const;

export type GeometryKind = (typeof GEOMETRY_KINDS)[number];

/** The fewest and the most segments a round geometry is made with (the `segments` range of the `mesh` shape) */
export const MIN_SEGMENTS = 3;
export const MAX_SEGMENTS = 128;
/** The largest size, in scene units, a geometry is made with; a larger one is cut to it */
export const MAX_SIZE = 10_000;
/**
 * The most vertices and faces of a `custom` geometry, and the most vertices of one face (docs/design/stateui-mesh-editor.md);
 * the same limits as stateui-app's `polyMesh` validator, which this package does not depend on
 */
export const MAX_EDIT_VERTICES = 4000;
export const MAX_EDIT_FACES = 4000;
export const MAX_FACE_SIDES = 32;

/** How a `custom` geometry's faces are lit: each face by its own normal, or by normals averaged where faces share a vertex */
export const SHADINGS = ['flat', 'smooth'] as const;
export type Shading = (typeof SHADINGS)[number];

export type Vec3 = readonly [number, number, number];

/**
 * The sizes a geometry is made with, every one set: the `mesh`'s `geometry` with defaults for what it leaves out.
 * Every kind is about one unit across by default, as a unit box: a sphere, cylinder and cone of radius 0.5 and height 1,
 * a plane 1 by 1 (facing +z), a torus of radius 0.4 and tube 0.1, a capsule of radius 0.25 whose middle section is 0.5
 * long. `segments` is the number around a round geometry (radial, or along a torus's ring); flat kinds ignore it
 */
export type GeometryParams =
    | { readonly kind: 'box'; readonly width: number; readonly height: number; readonly depth: number }
    | { readonly kind: 'sphere'; readonly radius: number; readonly segments: number }
    | { readonly kind: 'cylinder'; readonly radiusTop: number; readonly radiusBottom: number; readonly height: number; readonly segments: number }
    | { readonly kind: 'cone'; readonly radius: number; readonly height: number; readonly segments: number }
    | { readonly kind: 'plane'; readonly width: number; readonly height: number }
    | { readonly kind: 'torus'; readonly radius: number; readonly tube: number; readonly segments: number }
    | { readonly kind: 'capsule'; readonly radius: number; readonly height: number; readonly segments: number }
    | CustomParams;

/**
 * A `custom` geometry, read: its vertices (each coordinate cut to `MAX_SIZE`) and the faces that can be drawn, at most the
 * limits; `bad` is the index of the first face left out (fewer than 3 or more than `MAX_FACE_SIDES` indices, an index
 * that is not one of a well-formed vertex, or one repeated), or of the first past the limit
 */
export interface CustomParams {
    readonly kind: 'custom';
    readonly vertices: readonly Vec3[];
    readonly faces: readonly (readonly number[])[];
    readonly shading: Shading;
    readonly bad?: number;
}

/** The segments of a round geometry when `segments` is not set */
const DEFAULT_SEGMENTS: Record<GeometryKind, number> = { box: 1, sphere: 32, cylinder: 32, cone: 32, plane: 1, torus: 48, capsule: 16, custom: 1 };

const isObject = (value: JsonValue | undefined): value is { [key: string]: JsonValue } => typeof value === 'object' && value !== null && !Array.isArray(value);

/** True for a geometry kind */
export const isGeometryKind = (value: unknown): value is GeometryKind => typeof value === 'string' && (GEOMETRY_KINDS as readonly string[]).includes(value);

/**
 * The sizes of a `mesh`'s `geometry` value, clamped: a size that is not a finite number of 0 or more takes its default,
 * one above `MAX_SIZE` is cut to it; `segments` is rounded and kept between `MIN_SEGMENTS` and `MAX_SEGMENTS`. A value
 * that is not an object, or names no kind of the list, is a unit box. Pure
 */
export function geometryParams(value: JsonValue | undefined): GeometryParams {
    const geometry = isObject(value) ? value : {};
    const kind = isGeometryKind(geometry.kind) ? geometry.kind : 'box';
    if (kind === 'custom') return customParams(geometry);
    const size = (name: string, fallback: number): number => {
        const raw = geometry[name];
        if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return fallback;
        return Math.min(raw, MAX_SIZE);
    };
    const raw = geometry.segments;
    const segments =
        typeof raw === 'number' && Number.isFinite(raw) ? Math.min(MAX_SEGMENTS, Math.max(MIN_SEGMENTS, Math.round(raw))) : DEFAULT_SEGMENTS[kind];
    switch (kind) {
        case 'box':
            return { kind, width: size('width', 1), height: size('height', 1), depth: size('depth', 1) };
        case 'sphere':
            return { kind, radius: size('radius', 0.5), segments };
        case 'cylinder': {
            const radius = size('radius', 0.5);
            return { kind, radiusTop: size('radiusTop', radius), radiusBottom: size('radiusBottom', radius), height: size('height', 1), segments };
        }
        case 'cone':
            return { kind, radius: size('radius', 0.5), height: size('height', 1), segments };
        case 'plane':
            return { kind, width: size('width', 1), height: size('height', 1) };
        case 'torus':
            return { kind, radius: size('radius', 0.4), tube: size('tube', 0.1), segments };
        case 'capsule':
            return { kind, radius: size('radius', 0.25), height: size('height', 0.5), segments };
    }
}

/** A coordinate cut to `MAX_SIZE` either way */
const coordinate = (value: number): number => Math.max(-MAX_SIZE, Math.min(MAX_SIZE, value));

/** Reads a `custom` geometry: the well-formed vertices (a malformed one is a hole no face may use) and the faces that can be drawn */
function customParams(geometry: { [key: string]: JsonValue }): CustomParams {
    const list = (value: JsonValue | undefined): JsonValue[] => (Array.isArray(value) ? value : []);
    const holes = new Set<number>();
    const vertices = list(geometry.vertices)
        .slice(0, MAX_EDIT_VERTICES)
        .map((vertex, index): Vec3 => {
            if (Array.isArray(vertex) && vertex.length === 3 && vertex.every((value) => typeof value === 'number' && Number.isFinite(value))) {
                return (vertex as number[]).map(coordinate) as unknown as Vec3;
            }
            holes.add(index);
            return [0, 0, 0];
        });
    const faces: number[][] = [];
    let bad: number | undefined;
    list(geometry.faces).forEach((face, index) => {
        const fits =
            index < MAX_EDIT_FACES &&
            Array.isArray(face) &&
            face.length >= 3 &&
            face.length <= MAX_FACE_SIDES &&
            new Set(face).size === face.length &&
            face.every((at) => typeof at === 'number' && Number.isInteger(at) && at >= 0 && at < vertices.length && !holes.has(at));
        if (fits) faces.push(face as number[]);
        else bad ??= index;
    });
    const shading: Shading = geometry.shading === 'smooth' ? 'smooth' : 'flat';
    return bad === undefined ? { kind: 'custom', vertices, faces, shading } : { kind: 'custom', vertices, faces, shading, bad };
}

/**
 * The three.js geometry of a `custom` geometry: each face a fan of triangles from its first vertex. Flat shading gives
 * every triangle its own corners, so each face shows its own normal; smooth shares the vertices, so normals are
 * averaged where faces meet. No texture coordinates
 */
function customGeometry({ vertices, faces, shading }: CustomParams): BufferGeometry {
    const triangles: number[] = [];
    for (const face of faces) {
        for (let at = 1; at < face.length - 1; at += 1) triangles.push(face[0] as number, face[at] as number, face[at + 1] as number);
    }
    const made = new BufferGeometry();
    if (shading === 'smooth') {
        made.setAttribute('position', new Float32BufferAttribute(vertices.flat(), 3));
        made.setIndex(triangles);
    } else {
        made.setAttribute('position', new Float32BufferAttribute(triangles.flatMap((index) => vertices[index] as Vec3), 3));
    }
    made.computeVertexNormals();
    return made;
}

/** Makes the three.js geometry of clamped sizes (`geometryParams`) */
export function createGeometry(params: GeometryParams): BufferGeometry {
    switch (params.kind) {
        case 'box':
            return new BoxGeometry(params.width, params.height, params.depth);
        case 'sphere':
            return new SphereGeometry(params.radius, params.segments, Math.max(2, Math.round(params.segments / 2)));
        case 'cylinder':
            return new CylinderGeometry(params.radiusTop, params.radiusBottom, params.height, params.segments);
        case 'cone':
            return new ConeGeometry(params.radius, params.height, params.segments);
        case 'plane':
            return new PlaneGeometry(params.width, params.height);
        case 'torus':
            return new TorusGeometry(params.radius, params.tube, Math.max(MIN_SEGMENTS, Math.round(params.segments / 3)), params.segments);
        case 'capsule':
            return new CapsuleGeometry(params.radius, params.height, Math.max(2, Math.round(params.segments / 4)), params.segments);
        case 'custom':
            return customGeometry(params);
    }
}
