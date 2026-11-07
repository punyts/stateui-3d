import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        globals: true,
        include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'runtime-chunk/**/*.test.ts'],
        exclude: [...configDefaults.exclude, 'src/**/*.browser.test.ts', 'test/**/*.browser.test.ts']
    }
});
