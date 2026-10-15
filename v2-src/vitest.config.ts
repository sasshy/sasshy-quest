import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    sequence: { concurrent: false },
    // scripts/*.test.mjs are node:test smoke tests run by build:ios.
    exclude: [...configDefaults.exclude, 'scripts/**', 'ios-web/**', 'dist-ios/**'],
  },
});
