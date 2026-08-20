/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/e2e/'],
  forceExit: true,
  testTimeout: 30000,
  // Two workers, each capped below (see the `test` script's --max-old-space-size),
  // keep peak RSS within a ~8GB CI box. workerIdleMemoryLimit recycles a worker
  // between test files once its heap grows past the limit, so a heavy suite
  // (e.g. session-process.test.ts, ~1.9GB in one file) never accumulates on top
  // of a worker's earlier residue and OOM-kills the process.
  maxWorkers: 2,
  workerIdleMemoryLimit: '768MB',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        target: 'ES2020',
        module: 'commonjs',
        esModuleInterop: true,
        strict: true,
        skipLibCheck: true,
        resolveJsonModule: true,
        rootDir: '.',
      }
    }]
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/index.ts',
  ],
  coverageDirectory: 'coverage',
};
