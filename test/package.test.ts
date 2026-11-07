import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.ts';

interface PackageJson {
    version: string;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
}

const packageJson = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as PackageJson;

describe('package.json', () => {
    it('should have no runtime dependency on a @punyts/stateui-* package', () => {
        // The runtime bundle has the component library as a dev dependency, and the component library holds the 3D
        // shapes: a dependency the other way would make a cycle (design Decisions)
        const runtime = { ...packageJson.dependencies, ...packageJson.peerDependencies, ...packageJson.optionalDependencies };

        // Assert
        expect(Object.keys(runtime).filter((name) => name.startsWith('@punyts/stateui'))).toEqual([]);
    });

    it('should pin three and its types exactly, to the same release', () => {
        // Arrange
        const three = packageJson.dependencies?.three;
        const types = packageJson.devDependencies?.['@types/three'];

        // Assert
        expect(three).toMatch(/^\d+\.\d+\.\d+$/);
        expect(types).toBe(three);
    });

    it('should give the chunk the package version', () => {
        // Assert
        expect(VERSION).toBe(packageJson.version);
    });
});
