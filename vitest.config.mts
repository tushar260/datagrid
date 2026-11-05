import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Separate from electron.vite.config.ts so the app build is untouched.
// Default environment is node; component/renderer tests opt in with `// @vitest-environment jsdom`.
const pg = !!(process.env.RUN_PG_TESTS || process.env.PG_TEST_URL)
const e2e = !!process.env.RUN_E2E
// DynamoDB Local integration tests: only with RUN_DDB_TESTS=1 and DDB_ENDPOINT=http://localhost:8000
const ddb = !!(process.env.RUN_DDB_TESTS && process.env.DDB_ENDPOINT)
// Redis integration tests start their own throwaway redis-server: only with RUN_REDIS_TESTS=1
const redis = !!process.env.RUN_REDIS_TESTS

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    // integration tests need a real Postgres: only run them when asked (RUN_PG_TESTS=1 or PG_TEST_URL=...)
    // e2e tests launch the installed Electron app: only run them when asked (RUN_E2E=1)
    exclude: [
      '**/node_modules/**',
      ...(pg ? [] : ['tests/**/db*.int.test.ts']),
      ...(redis ? [] : ['tests/**/redis.int.test.ts']),
      ...(e2e ? [] : ['tests/**/*.e2e.test.ts']),
      ...(ddb ? [] : ['tests/**/*.ddb.test.ts'])
    ],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/renderer/src/main.tsx',
        'src/renderer/src/env.d.ts',
        'src/renderer/src/css.d.ts',
        'src/preload/**',
        'src/main/index.ts'
      ]
    }
  }
})
