# @punyts/stateui-3d

Draws StateUI 3D scenes (`scene3d` and its nodes) with three.js. The StateUI runtime loads it as a second script, only for apps that use a scene.

The shapes of `scene3d` and its nodes (`state.json` files, shape tier) live in `@punyts/stateui-components`, where the catalog, the validator and `ui_component_get` read them. This package holds the renderer only, and depends on `three` and on no `@punyts/stateui-*` package, so there is no cycle with the runtime bundle (which has the component library as a dev dependency). `test/package.test.ts` fails when `package.json` gains such a dependency.

## three.js
`three` is pinned exactly (0.187.0, MIT), with `@types/three` of the same release; graphics story G3.1 chose the release and measured it: 167,830 bytes gzipped with everything the 3D epic uses, `GLTFLoader` and `OrbitControls` included, and no `eval`, `new Function` or workers. Move `three` and `@types/three` together.

## Package exports
- `.`: the typed API, for tests and other hosts.
  - `createScene3d(host, options?)` makes a `Scene3d` in `host` (an element): a canvas that follows the host's size (written through CSSOM; `setSize(w, h, false)` writes no `style` attribute), a `WebGLRenderer`, a scene and a default perspective camera (`DEFAULT_FOV` 50°, at `DEFAULT_CAMERA_POSITION` `[0, 0, 5]`, looking at the origin). It throws when the browser gives no WebGL context. Options: `reducedMotion` (default false).
  - `Scene3d`, named as the component library's 2D `DrawingRenderer`: `update(tree)` draws a list of `Scene3dTree` nodes; `hit(x, y)` gives the interactive node at a point of the host in CSS pixels (the first node the ray meets, or its nearest `interactive: true` ancestor); `boundsOf(path)` the node's axis-aligned bounds in scene units (`Bounds3d`, `{ min, max }`); `elementOf(path)` the element that stands for a node (none yet: the proxy buttons come with G3.8); `setReducedMotion(reduced)` and `reducedMotion`; `drawn()` resolves after the next frame; `dispose()` frees the geometries, materials and renderer (forcing the context loss, since a page keeps at most 16 WebGL contexts), removes the canvas and makes every later call a no-op. The scene draws again on `webglcontextrestored`.
  - `Scene3dTree` (`kind`, `key`, `path`, `properties`, `children`, `row`), mirroring the 2D `ShapeTree`; `NODE3D_KINDS` and `isNode3dKind` (`camera`, `light`, `mesh`, `model`, `group3d`, `repeat3d`, `label3d`); `JsonValue`, `Vector3Tuple`, `Bounds3d`.
  - `VERSION`, `GLOBAL_NAME` (`__stateui3d`) and `Stateui3dGlobal` (the type of that global).
- `./runtime-chunk/*`: the built chunk, `dist/runtime-chunk/<hash>.js`, and `manifest.json` (`{ hash, script }`).

**What draws today (G3.2).** The first renderer is a minimal one: a `mesh` is a unit box in an unlit material of its `material.color` (a literal colour; white otherwise), a `group3d` places its children, every node takes `position`, `rotation` (degrees), `scale` and `visible`, and the other nodes are not drawn. `update` rebuilds the scene and draws at once. Cameras, lights, geometries, materials and tokens come with G3.5.

## Runtime chunk
`src/chunk.ts` is the entry of one classic script that sets one global, `globalThis.__stateui3d = { version, createScene3d }` (frozen), and nothing else: three.js sets `window.__THREE__`, and the chunk removes it again unless the page had one before (`src/chunkGuard.ts` runs before three.js). `runtime-chunk/build.ts` bundles it with esbuild as `runtime-bundle/build.ts` of `@punyts/stateui-app` bundles the runtime (`iife`, minified, `platform: 'browser'`, `target: 'es2022'`) and names the file after its content: sha256, the first 16 hex characters. It removes only its own earlier output from `dist/runtime-chunk` (`<16 hex>.js` and `manifest.json`). The chunk is a classic script, not a module, because the runtime frame may have an opaque origin; the server serves it beside the runtime script and the host names it by hash in the `load` message (G3.3).

A build test fails when the chunk is more than 15% above G3.1's 167,830 gzipped bytes (193,004). Today it is about 135,000, since `GLTFLoader` and `OrbitControls` join the chunk with the stories that use them (G3.7b, G3.8b).

## Scripts
| Script | What it does |
|--------|--------------|
| `npm run build` | `tsc -b tsconfig.build.json` into `dist/`, then `build:runtime-chunk` |
| `npm run build:runtime-chunk` | `node runtime-chunk/build.ts` (Node's type stripping) into `dist/runtime-chunk/` |
| `npm run typecheck` | The sources, and the tests, build script and configs |
| `npm test` | The node tests: the chunk build (hashing, own output, size gate) and `package.json` |
| `npm run test:browser` | The browser tests in Chromium: the scene (`src/scene3d.browser.test.ts`) and the chunk loaded in a page (`test/chunk.browser.test.ts`; `test/globalSetup.ts` builds it into `.test-build/`) |
| `npm run clean` | Removes `dist`, `.test-build` and the build info files |
