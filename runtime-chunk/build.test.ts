import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHUNK_ENTRY, MANIFEST_FILE, buildRuntimeChunk } from './build.ts';

/**
 * The gzipped size G3.1 measured for three.js 0.187.0 with everything the 3D epic uses, `GLTFLoader` and
 * `OrbitControls` included (knowledge-base/design/stateui-graphics.md, Decisions). The chunk may grow to it as later
 * stories add those parts; the build fails when it is more than 15% above it
 */
const G3_1_GZIP_BYTES = 167_830;
const GZIP_LIMIT = Math.floor(G3_1_GZIP_BYTES * 1.15);

describe('buildRuntimeChunk', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'runtime-chunk-'));
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    async function chunkOf(source: string, outName: string) {
        const entry = join(dir, 'entry.ts');
        await writeFile(entry, source);
        return buildRuntimeChunk({ entry, outDir: join(dir, outName) });
    }

    it('should change the file name when the source changes', async () => {
        // Act
        const first = await chunkOf('window.name = "one";', 'out');
        const second = await chunkOf('window.name = "two";', 'out');

        // Assert
        expect(second.script).not.toBe(first.script);
        expect(second.hash).not.toBe(first.hash);
    });

    it('should keep the file name when the source does not change', async () => {
        // Act
        const first = await chunkOf('window.name = "same";', 'one');
        const second = await chunkOf('window.name = "same";', 'two');

        // Assert
        expect(second.script).toBe(first.script);
    });

    it('should remove its own earlier script and manifest but no other file', async () => {
        // Arrange
        const first = await chunkOf('window.name = "one";', 'out');
        await writeFile(join(dir, 'out', 'notes.txt'), 'kept');
        await writeFile(join(dir, 'out', 'other.js'), 'kept');

        // Act
        const second = await chunkOf('window.name = "two";', 'out');

        // Assert
        const files = (await readdir(join(dir, 'out'))).sort();
        expect(files).toEqual([MANIFEST_FILE, second.script, 'notes.txt', 'other.js'].sort());
        expect(files).not.toContain(first.script);
        const manifest: unknown = JSON.parse(await readFile(join(dir, 'out', MANIFEST_FILE), 'utf8'));
        expect(manifest).toEqual(second);
    });

    it('should name the script after the sha256 of its content, first 16 hex characters', async () => {
        // Act
        const manifest = await chunkOf('window.name = "one";', 'out');

        // Assert
        const { createHash } = await import('node:crypto');
        const contents = await readFile(join(dir, 'out', manifest.script));
        expect(manifest.hash).toMatch(/^[0-9a-f]{16}$/);
        expect(manifest.hash).toBe(createHash('sha256').update(contents).digest('hex').slice(0, 16));
        expect(manifest.script).toBe(`${manifest.hash}.js`);
    });

    it('should build the package chunk as one classic script within the size gate', async () => {
        // Act
        const manifest = await buildRuntimeChunk({ entry: CHUNK_ENTRY, outDir: join(dir, 'chunk') });

        // Assert
        expect((await readdir(join(dir, 'chunk'))).sort()).toEqual([MANIFEST_FILE, manifest.script].sort());
        expect(manifest.hash).toMatch(/^[0-9a-f]{16}$/);
        const script = await readFile(join(dir, 'chunk', manifest.script));
        const text = script.toString('utf8');
        // A classic script: no module syntax at the top level
        expect(text).not.toMatch(/^\s*(import|export)\b/m);
        // The frame's policy refuses workers, and the chunk needs no eval (G3.1)
        expect(text).not.toMatch(/\beval\(|new Function\(|new Worker\(/);
        const gzipped = gzipSync(script, { level: 9 }).length;
        expect(gzipped, `the chunk is ${gzipped} bytes gzipped, the gate is ${GZIP_LIMIT}`).toBeLessThanOrEqual(GZIP_LIMIT);
    }, 60_000);
});
