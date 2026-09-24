import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['api/**/__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
  },
});
