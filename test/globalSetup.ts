import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { TestProject } from 'vitest/node';
import { CHUNK_ENTRY, buildRuntimeChunk } from '../runtime-chunk/build.ts';

declare module 'vitest' {
    export interface ProvidedContext {
        /** The text of the runtime chunk built from the current sources */
        chunkScript: string;
        /** The bytes of the model fixture `test/fixtures/box.glb` (G3.7b), base64 */
        modelFixture: string;
        /** The bytes of the animated model fixture `test/fixtures/box-clips.glb` (G3.9b), base64 */
        clipsFixture: string;
    }
}

/**
 * Builds the runtime chunk from the current sources into `.test-build/runtime-chunk/`, so the browser tests need no
 * earlier `npm run build`, and gives its text to the tests (`inject('chunkScript')`), and the model fixture's bytes
 * (`inject('modelFixture')`, and `inject('clipsFixture')` for the animated one)
 */
export default async function setup(project: TestProject): Promise<void> {
    const outDir = resolve(import.meta.dirname, '..', '.test-build', 'runtime-chunk');
    const manifest = await buildRuntimeChunk({ entry: CHUNK_ENTRY, outDir });
    project.provide('chunkScript', await readFile(join(outDir, manifest.script), 'utf8'));
    project.provide('modelFixture', (await readFile(resolve(import.meta.dirname, 'fixtures', 'box.glb'))).toString('base64'));
    project.provide('clipsFixture', (await readFile(resolve(import.meta.dirname, 'fixtures', 'box-clips.glb'))).toString('base64'));
}
