import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/** What a server reads to serve the chunk: the content hash and the name of the script file */
export interface RuntimeChunkManifest {
    hash: string;
    script: string;
}

export interface RuntimeChunkOptions {
    /** The chunk entry file */
    entry: string;
    /** The folder the script and `manifest.json` are written to; the scripts and manifest of earlier builds are removed from it */
    outDir: string;
}

export const MANIFEST_FILE = 'manifest.json';
const HASH_LENGTH = 16;
/** The file names this build writes: a script named by its hash, and the manifest. Nothing else in `outDir` is touched */
const OWN_FILE = /^(?:[0-9a-f]{16}\.js|manifest\.json)$/;

/**
 * Bundles `entry` (the 3D renderer with the parts of three.js it imports) into one classic script, as
 * `runtime-bundle/build.ts` of `@punyts/stateui-app` bundles the runtime: `iife`, minified, for the browser, ES2022.
 * The file is named after a hash of its content (sha256, the first 16 hex characters), so a changed source gives a
 * new name and a server can serve it as immutable. A classic script, not a module: the runtime frame may have an
 * opaque origin, and a module script would need a CORS response
 */
export async function buildRuntimeChunk(options: RuntimeChunkOptions): Promise<RuntimeChunkManifest> {
    const result = await build({
        entryPoints: [options.entry],
        bundle: true,
        write: false,
        format: 'iife',
        platform: 'browser',
        target: 'es2022',
        minify: true,
        legalComments: 'none',
        logLevel: 'silent'
    });
    const [output] = result.outputFiles;
    if (result.outputFiles.length !== 1 || !output) {
        throw new Error(`The runtime chunk must be one file, esbuild produced ${result.outputFiles.length}`);
    }

    const hash = createHash('sha256').update(output.contents).digest('hex').slice(0, HASH_LENGTH);
    const manifest: RuntimeChunkManifest = { hash, script: `${hash}.js` };

    await mkdir(options.outDir, { recursive: true });
    for (const name of await readdir(options.outDir)) {
        if (OWN_FILE.test(name)) await rm(join(options.outDir, name), { force: true });
    }
    await writeFile(join(options.outDir, manifest.script), output.contents);
    await writeFile(join(options.outDir, MANIFEST_FILE), `${JSON.stringify(manifest)}\n`);
    return manifest;
}

const here = dirname(fileURLToPath(import.meta.url));

/** The chunk's entry and output folder in this package */
export const CHUNK_ENTRY = join(here, '..', 'src', 'chunk.ts');
export const CHUNK_OUT_DIR = join(here, '..', 'dist', 'runtime-chunk');

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const manifest = await buildRuntimeChunk({ entry: CHUNK_ENTRY, outDir: CHUNK_OUT_DIR });
    process.stdout.write(`Built runtime chunk ${manifest.script}\n`);
}
