import { defineConfig } from 'vite';

// https://vitejs.dev/config
// Keep `external` a plain string array: Forge merges it with its own array via mergeConfig
// (see ELECTRON-LESSONS.md in v1). Native modules cannot be bundled, so better-sqlite3 stays a
// real `require()` at runtime; forge.config.ts makes sure it is shipped in the packaged app.
export default defineConfig({
  build: {
    rollupOptions: {
      external: ['better-sqlite3'],
    },
  },
});
