// Stryker mutation testing config — scoped to messenger/crypto only.
//
// Why scoped: mutation testing is expensive (10-100x slower than unit tests).
// We focus on the highest-stakes code: crypto primitives, key management,
// session establishment. A passing test that doesn't catch a flipped `>` to
// `>=` in a constant-time compare is a security bug waiting to happen.
//
// Run locally:  npm run mutation:crypto
// Run in CI:    .github/workflows/mutation.yml (weekly)

export default {
  packageManager: 'npm',
  reporters: ['html', 'clear-text', 'progress', 'json'],
  testRunner: 'jest',
  jest: {
    projectType: 'custom',
    config: {
      // Use the messenger-crypto Jest project config.
      preset: undefined,
      testEnvironment: 'node',
      testMatch: ['<rootDir>/src/modules/messenger/__tests__/**/*.test.ts'],
      transform: {
        '^.+\\.(ts|tsx|js|jsx)$': [
          'babel-jest',
          {
            presets: [
              ['@babel/preset-env', {targets: {node: 'current'}}],
              '@babel/preset-typescript',
            ],
          },
        ],
      },
      transformIgnorePatterns: ['/node_modules/(?!(@noble/hashes)/)'],
      setupFiles: ['<rootDir>/src/modules/messenger/__tests__/setup.ts'],
    },
    enableFindRelatedTests: true,
  },
  mutate: [
    'src/modules/messenger/crypto/**/*.ts',
    '!src/modules/messenger/crypto/**/*.test.ts',
    '!src/modules/messenger/crypto/**/*.spec.ts',
  ],
  thresholds: {high: 80, low: 60, break: 50},
  timeoutMS: 15000,
  concurrency: 4,
  coverageAnalysis: 'perTest',
  htmlReporter: {fileName: 'reports/mutation/index.html'},
  jsonReporter: {fileName: 'reports/mutation/mutation.json'},
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
};
