/** A JSON value, as the store holds it (the package depends on no `@punyts/stateui-*` package, so it declares its own) */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** The 3D node components a `scene3d` holds, by component name (their shapes live in `@punyts/stateui-components`) */
export const NODE3D_KINDS = ['camera', 'light', 'mesh', 'model', 'group3d', 'repeat3d', 'label3d'] as const;

export type Node3dKind = (typeof NODE3D_KINDS)[number];

/** True for the name of a 3D node component */
export const isNode3dKind = (name: unknown): name is Node3dKind => typeof name === 'string' && (NODE3D_KINDS as readonly string[]).includes(name);

/**
 * One node of a 3D scene, as the renderer takes it: a plain object, never state. The `scene3d` component reads it from
 * the store; a test or another host builds it itself. It mirrors `ShapeTree` of the component library's 2D renderers.
 */
export interface Scene3dTree {
    readonly kind: Node3dKind;
    /** The key of the node in its parent's `children` map (`row` for a repeat's template) */
    readonly key: string;
    /** The state path of the node; it is also the node's id for `boundsOf` and `elementOf` of the scene */
    readonly path: string;
    /** The resolved properties of the node, links followed; the reserved keys and the node slots are not among them */
    readonly properties: Readonly<Record<string, JsonValue>>;
    /** The nodes of a `group3d`'s `children`, in the order of the map; empty for every other kind */
    readonly children: readonly Scene3dTree[];
    /** The row template of a `repeat3d` */
    readonly row?: Scene3dTree;
}

/**
 * The scene's own properties (the `scene3d` node's), as the feeder reads them. `background` and `ambient` are colours
 * (literals or token references, resolved with the scene's `resolveColor`); the feeder passes the `scene3d.background`
 * and `scene3d.ambient` tokens when the node sets none. `environment` names a lighting preset (`environment.ts`: `none`,
 * `studio`, the default, `daylight`, `neutral`), and `ambient` is the colour of the `studio` preset's ambient light. An
 * unset `background` takes the preset's (none for `none`, which leaves the canvas transparent, so the host's own
 * background shows). `fog` is `{ color, near, far }` (`fogParams`); without a colour it takes the background's
 */
export interface Scene3dSettings {
    readonly background?: JsonValue;
    readonly ambient?: JsonValue;
    readonly environment?: JsonValue;
    readonly fog?: JsonValue;
    /** How a person moves the camera (G3.8b, `controls.ts`): `none` (the default), `orbit` or `pan` */
    readonly controls?: JsonValue;
}

/**
 * Resolves a colour value of a node or of the scene (a literal such as `#ff8800`, or a token reference such as
 * `{color.accent.base}`) to a CSS colour, or undefined when it is unset or names nothing. The feeder passes it (the
 * component library's paint resolver reading the host's computed style), so the package depends on no StateUI package
 */
export type ColorResolver = (value: JsonValue) => string | undefined;

/** A point or a size in scene units, `[x, y, z]` */
export type Vector3Tuple = readonly [number, number, number];

/** The axis-aligned bounds of a node in scene (world) units */
export interface Bounds3d {
    readonly min: Vector3Tuple;
    readonly max: Vector3Tuple;
}
