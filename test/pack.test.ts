import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** One file of the list `npm pack --dry-run --json` prints */
interface PackedFile {
    path: string;
}

/** One package of that list */
interface PackResult {
    files: PackedFile[];
}

const root = join(import.meta.dirname, '..');
const built = existsSync(join(root, 'dist', 'runtime-chunk', 'manifest.json'));

/**
 * The paths `npm pack` would put in the tarball, without writing it. npm 10 prints an array of packages, npm 11 and
 * later an object keyed by package name, so both are read
 */
function packedPaths(): string[] {
    const output = execSync('npm pack --dry-run --json --ignore-scripts', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const parsed = JSON.parse(output) as PackResult[] | Record<string, PackResult>;
    const result = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
    return (result?.files ?? []).map((file) => file.path.replace(/\\/g, '/'));
}

describe('npm pack', () => {
    const paths = packedPaths();

    it('should leave out the sources, the spike, the tests, the fixtures and the build script', () => {
        // Assert
        const unwanted = paths.filter((path) => /^(src|spike|test|runtime-chunk|coverage|\.test-build)\//.test(path) || /\.test\.(ts|js)$/.test(path) || path.endsWith('.glb'));
        expect(unwanted).toEqual([]);
    });

    it('should hold only dist and the package files', () => {
        // Assert
        expect(paths.filter((path) => !path.startsWith('dist/') && !['package.json', 'README.md', 'LICENSE'].includes(path))).toEqual([]);
    });

    it.skipIf(!built)('should hold the typed API and the built chunk with its manifest (needs npm run build)', () => {
        // Assert
        expect(paths).toContain('dist/index.js');
        expect(paths).toContain('dist/index.d.ts');
        expect(paths).toContain('dist/runtime-chunk/manifest.json');
        expect(paths.filter((path) => /^dist\/runtime-chunk\/[0-9a-f]{16}\.js$/.test(path))).toHaveLength(1);
    });
});
