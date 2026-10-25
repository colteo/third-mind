import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      // Coverage is reported for the framework-independent modules that the
      // unit tests target, plus the Chrome adapters that are tested against
      // mocked Chrome APIs. Only the result views and the conversation
      // connections panel are rendered in tests (see docs/architecture/testing.md).
      include: [
        'src/domain/**/*.ts',
        'src/application/**/*.ts',
        'src/infrastructure/**/*.ts',
        'src/extension/protocol.ts',
        'src/extension/chrome-tabs.ts',
        'src/extension/session-connection-store.ts',
        'src/extension/provider-transport.ts',
        'src/extension/provider-transport-protocol.ts',
        'src/extension/provider-content-script.ts',
      ],
      exclude: ['src/**/*.test.ts', 'src/test-support/**'],
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
});
