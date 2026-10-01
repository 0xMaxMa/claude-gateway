/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/e2e/'],
  testTimeout: 30000,
  // Two workers, each capped below (see the `test` script's --max-old-space-size),
  // keep peak RSS within a ~8GB CI box. workerIdleMemoryLimit recycles a worker
  // between test files once its heap grows past the limit, so a heavy suite
  // (e.g. session-process.test.ts, ~1.9GB in one file) never accumulates on top
  // of a worker's earlier residue and OOM-kills the process.
  maxWorkers: 2,
  workerIdleMemoryLimit: '512MB',
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
        // Transpile only. Type-checking in ts-jest keeps a full TypeScript
        // program alive in every worker (~300MB+ per worker on a cold cache),
        // which pushed workers to the heap cap. `pretest` runs
        // `npm run typecheck:tests` (tsconfig.test.json, src + tests) instead.
        isolatedModules: true,
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
