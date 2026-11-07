// The entry of the runtime chunk (runtime-chunk/build.ts): one classic script that sets one global and nothing else.
// chunkGuard.js comes first so that it runs before three.js
import { THREE_GLOBAL, hadThreeGlobal } from './chunkGuard.js';
import { GLOBAL_NAME, createScene3d } from './index.js';
import type { Stateui3dGlobal } from './index.js';
import { VERSION } from './version.js';

if (!hadThreeGlobal && typeof window !== 'undefined') delete (window as unknown as Record<string, unknown>)[THREE_GLOBAL];

const api: Stateui3dGlobal = Object.freeze({ version: VERSION, createScene3d });
(globalThis as Record<string, unknown>)[GLOBAL_NAME] = api;
