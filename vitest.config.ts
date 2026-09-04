import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{shared,services,apps}/*/src/**/*.test.ts'],
    // The dashboard is a separate app with its own toolchain.
    exclude: ['**/node_modules/**', 'apps/dashboard/**'],
    environment: 'node',
  },
});
