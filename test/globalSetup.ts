import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { TestProject } from 'vitest/node';
import { CHUNK_ENTRY, buildRuntimeChunk } from '../runtime-chunk/build.ts';

declare module 'vitest' {
    export interface ProvidedContext {
        /** The text of the runtime chunk built from the current sources */
        chunkScript: string;
    }
}

/**
 * Builds the runtime chunk from the current sources into `.test-build/runtime-chunk/`, so the browser tests need no
 * earlier `npm run build`, and gives its text to the tests (`inject('chunkScript')`)
 */
export default async function setup(project: TestProject): Promise<void> {
    const outDir = resolve(import.meta.dirname, '..', '.test-build', 'runtime-chunk');
    const manifest = await buildRuntimeChunk({ entry: CHUNK_ENTRY, outDir });
    project.provide('chunkScript', await readFile(join(outDir, manifest.script), 'utf8'));
}
