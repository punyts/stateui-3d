import type { JsonValue, Vector3Tuple } from './tree.js';

/** The lighting presets of a scene's `environment` (the `scene3d` shape's values; `studio` is its default) */
export const ENVIRONMENT_NAMES = ['none', 'studio', 'daylight', 'neutral'] as const;

export type EnvironmentName = (typeof ENVIRONMENT_NAMES)[number];

/** The preset a scene without an `environment`, or with a value that is no preset, gets (the shape's default) */
export const DEFAULT_ENVIRONMENT: EnvironmentName = 'studio';

/** True for the name of an environment preset */
export const isEnvironmentName = (value: unknown): value is EnvironmentName => typeof value === 'string' && (ENVIRONMENT_NAMES as readonly string[]).includes(value);

/** One light of an environment preset; `intensity` is before `LIGHT_SCALE`, as a `light` node's */
export interface EnvironmentLight {
    readonly kind: 'ambient' | 'hemisphere' | 'directional';
    /** The light's colour (a hemisphere light's sky colour), a CSS colour */
    readonly color: string;
    /** True when the scene's `ambient` colour (the `scene3d.ambient` token) replaces `color` while it resolves */
    readonly sceneAmbient?: boolean;
    /** The ground colour of a hemisphere light */
    readonly groundColor?: string;
    readonly intensity: number;
    /** Where a directional light shines from, towards the origin */
    readonly position?: Vector3Tuple;
}

/**
 * An environment preset: lights and a background colour, no environment map file. The background is drawn when the
 * scene's own `background` is unset (the `scene3d` component always sets one, its `scene3d.background` token)
 */
export interface EnvironmentPreset {
    readonly lights: readonly EnvironmentLight[];
    /** The clear colour while the scene sets no `background`; undefined leaves the canvas transparent */
    readonly background?: string;
}

/**
 * The presets. `none`: no light and no background, so only the scene's own `light` nodes light it. `studio`: an
 * ambient light of the scene's `ambient` colour (white when unset) with a white key light from the front, above and to
 * the right, and a weak rim light from behind. `daylight`: a sky and ground hemisphere light and a warm sun from high
 * up. `neutral`: an even white ambient light alone, so every face shows its own colour, a little darkened
 */
export const ENVIRONMENT_PRESETS: Readonly<Record<EnvironmentName, EnvironmentPreset>> = Object.freeze({
    none: { lights: [] },
    studio: {
        background: '#e9ebee',
        lights: [
            { kind: 'ambient', color: '#ffffff', sceneAmbient: true, intensity: 0.4 },
            { kind: 'directional', color: '#ffffff', intensity: 0.8, position: [3, 5, 8] },
            { kind: 'directional', color: '#ffffff', intensity: 0.3, position: [-5, 3, -8] }
        ]
    },
    daylight: {
        background: '#cfe6ff',
        lights: [
            { kind: 'hemisphere', color: '#cfe6ff', groundColor: '#6b5a45', intensity: 0.9 },
            { kind: 'directional', color: '#fff1d6', intensity: 1.2, position: [4, 12, 6] }
        ]
    },
    neutral: {
        background: '#808080',
        lights: [{ kind: 'ambient', color: '#ffffff', intensity: 0.5 }]
    }
} satisfies Record<EnvironmentName, EnvironmentPreset>);

/** The preset an `environment` value names: the default (`studio`) when it is unset or names no preset. Pure */
export function environmentPreset(value: JsonValue | undefined): { readonly name: EnvironmentName; readonly preset: EnvironmentPreset } {
    const name = isEnvironmentName(value) ? value : DEFAULT_ENVIRONMENT;
    return { name, preset: ENVIRONMENT_PRESETS[name] };
}

/** The near and far distances of a `fog` that sets none */
export const DEFAULT_FOG_NEAR = 1;
export const DEFAULT_FOG_FAR = 100;

/** A scene's `fog` with defaults: undefined for no fog */
export interface FogParams {
    /** The fog's colour value as given (a literal or a token), undefined to take the scene's background */
    readonly color: JsonValue | undefined;
    readonly near: number;
    readonly far: number;
}

const isObject = (value: JsonValue | undefined): value is { [key: string]: JsonValue } => typeof value === 'object' && value !== null && !Array.isArray(value);

const distance = (value: JsonValue | undefined, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback);

/**
 * The fog of a scene's `fog` value (`{ color, near, far }`): none unless it is an object. Objects closer than `near`
 * are clear, those beyond `far` take the fog's colour, linearly between. `near` defaults to 1 and `far` to 100, and a
 * `far` not beyond `near` is put one unit beyond it. An unset `color` takes the scene's background. Pure
 */
export function fogParams(value: JsonValue | undefined): FogParams | undefined {
    if (!isObject(value)) return undefined;
    const near = distance(value.near, DEFAULT_FOG_NEAR);
    const far = distance(value.far, DEFAULT_FOG_FAR);
    const color = value.color === undefined || value.color === null || value.color === '' ? undefined : value.color;
    return { color, near, far: far > near ? far : near + 1 };
}
