import { defineConfig } from 'vitest/config';

// Only for `npm run bench` (scripts/bench.mjs): building and searching the 2,000,000-row database. Never part of `npm test`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/bench/*.spec.ts'],
    testTimeout: 30 * 60_000,
    hookTimeout: 30 * 60_000,
  },
});
