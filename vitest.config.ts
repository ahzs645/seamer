import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Standalone config for unit tests of pure modules (command bus, geometry, mutators). We resolve the
// `$lib` alias ourselves instead of loading the full SvelteKit plugin, so tests run fast in Node.
export default defineConfig({
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts']
  }
});
