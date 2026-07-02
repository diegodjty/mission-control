import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests cover the pure modules only (see PRD Testing Decisions).
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
