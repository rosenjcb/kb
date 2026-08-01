import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@kb/core': path.join(root, 'packages/kb-core/src'),
      '@kb/client': path.join(root, 'packages/kb-client/src'),
      '@kb/server': path.join(root, 'packages/kb-server/src'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: true,
    restoreMocks: true,
    clearMocks: true,
    // Several retrieval/init tests legitimately run 5-8s and CI runners are
    // shared: the 5s default made near-limit tests (e.g. TC-29 at ~4.9s local)
    // flake on slow runs. Hangs still fail — just with a wider margin.
    testTimeout: 20000,
  },
})
