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
    env: {
      KB_LOCAL_MODE: 'true',
    },
  },
})
