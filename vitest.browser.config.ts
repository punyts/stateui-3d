import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    // The three.js add-ons are bundled before the run, so Vite does not find them mid-run, reload the page and load
    // three.js twice
    optimizeDeps: {
        include: ['three', 'three/examples/jsm/loaders/GLTFLoader.js', 'three/examples/jsm/controls/OrbitControls.js']
    },
    test: {
        globals: true,
        // Builds the runtime chunk into .test-build/ and gives its script to test/chunk.browser.test.ts
        globalSetup: ['./test/globalSetup.ts'],
        include: ['src/**/*.browser.test.ts', 'test/**/*.browser.test.ts'],
        passWithNoTests: false,
        browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }]
        }
    }
});
