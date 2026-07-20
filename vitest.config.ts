import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    // Pure modules run under plain 'node' (see PRD Testing Decisions); the
    // App.tsx component/hook harness (issue 184) needs a DOM, so `.test.tsx`
    // files opt into jsdom via the glob match below instead of switching the
    // whole suite over.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
    environmentMatchGlobs: [['src/**/*.test.tsx', 'jsdom']],
    setupFiles: ['src/renderer/src/test/setup.ts'],
  },
});
