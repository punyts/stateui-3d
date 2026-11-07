import { BoxGeometry, CapsuleGeometry, ConeGeometry, CylinderGeometry, PlaneGeometry, SphereGeometry, TorusGeometry } from 'three';
import type { BufferGeometry } from 'three';
import type { JsonValue } from './tree.js';

/** The geometry kinds of a `mesh` (`geometry.kind`) */
export const GEOMETRY_KINDS = ['box', 'sphere', 'cylinder', 'cone', 'plane', 'torus', 'capsule'] as const;

export type GeometryKind = (typeof GEOMETRY_KINDS)[number];

/** The fewest and the most segments a round geometry is made with (the `segments` range of the `mesh` shape) */
export const MIN_SEGMENTS = 3;
export const MAX_SEGMENTS = 128;
/** The largest size, in scene units, a geometry is made with; a larger one is cut to it */
export const MAX_SIZE = 10_000;

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
    | { readonly kind: 'capsule'; readonly radius: number; readonly height: number; readonly segments: number };

/** The segments of a round geometry when `segments` is not set */
const DEFAULT_SEGMENTS: Record<GeometryKind, number> = { box: 1, sphere: 32, cylinder: 32, cone: 32, plane: 1, torus: 48, capsule: 16 };

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
    }
}
