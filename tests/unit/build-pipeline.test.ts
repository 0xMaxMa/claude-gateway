/**
 * Regression guard for #479 — `npm test`'s `pretest` hook forced a full,
 * non-incremental `tsc` build on every invocation, pushing this 8GB shared
 * host to ~95% RAM with swap saturated (peak RSS occurred during the
 * `pretest` -> `tsc` step, not during the Jest run itself).
 *
 * `pretest`/`pretest:unit` still build before tests run — several `mcp/tools/**`
 * modules under test (`mcp/tools/telegram/typing.ts`, `whatsapp-cloud/module.ts`,
 * `slack/module.ts`, `skills/handlers.ts`) contain real (non-mocked) TypeScript
 * imports from `dist/**`, so `dist/` must be built to resolve them — a
 * `jest.mock(path, factory, { virtual: true })` only substitutes the module at
 * runtime, it does not stop the TypeScript compiler (now `typecheck:tests`,
 * which runs after the build) from resolving the import statement (confirmed by running
 * `test:unit` against a checkout with no `dist/`: TS2307 "Cannot find module"
 * on those four files). Skipping the build for `test:unit` alone would break
 * it on any fresh checkout and in `release.yml`, which runs `npm run test:unit`
 * before its separate `Build` step.
 *
 * The actual fix is the `incremental: true` + `tsBuildInfoFile` cache below:
 * the first build after a fresh checkout still pays full cost, but every
 * repeat `tsc` invocation on the same checkout (`pretest`, `pretest:unit`,
 * `typecheck`) reuses the cached type info instead of recompiling `src/`
 * from scratch — which is the case that actually matters on this host,
 * where the same checkout runs tests repeatedly across a session.
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function readJson(relPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO_ROOT, relPath), 'utf8'));
}

describe('build pipeline is not needlessly heavy on this host (#479)', () => {
  const pkg = readJson('package.json') as { scripts?: Record<string, string> };
  const tsconfig = readJson('tsconfig.json') as {
    compilerOptions?: { incremental?: boolean; tsBuildInfoFile?: string };
  };
  const scripts = pkg.scripts ?? {};

  it('enables incremental tsc builds so repeat compiles reuse cached type info', () => {
    expect(tsconfig.compilerOptions?.incremental).toBe(true);
    expect(typeof tsconfig.compilerOptions?.tsBuildInfoFile).toBe('string');
  });

  it('keeps the incremental build-info cache out of the published dist/ tree', () => {
    // dist/ ships to npm via package.json `files`, so a cache file that landed
    // there would be published too. The buildinfo path must not resolve under dist/.
    const buildInfoPath = tsconfig.compilerOptions?.tsBuildInfoFile ?? '';
    expect(buildInfoPath.replace(/^\.\//, '').split('/')[0]).not.toBe('dist');
  });

  it('still builds before unit tests — several mcp/tools/** files import dist/ for real', () => {
    // mcp/tools/telegram/typing.ts, whatsapp-cloud/module.ts, slack/module.ts,
    // and skills/handlers.ts import from dist/** directly (not behind a jest
    // virtual mock), so both the tests and the test type-check need a real dist/.
    // Removing this hook makes `npm run test:unit` fail with TS2307 on a
    // fresh checkout (and in release.yml, which runs it before its build step).
    expect(scripts['pretest:unit']).toBe('npm run build && npm run typecheck:tests');
    expect(scripts['test:unit']).toBeDefined();
  });

  it('still forces a real build before the full suite, which needs dist/ for real', () => {
    // tests/integration/cli-dispatch.test.ts and the pty-harness-based tests
    // spawn the compiled dist/ binaries directly — this hook must survive.
    expect(scripts['pretest']).toBe('npm run build && npm run typecheck:tests');
  });

  it('type-checks tests once, incrementally, because ts-jest only transpiles', () => {
    // ts-jest type-checking kept a full TypeScript program in every Jest worker
    // (~300MB+ each on a cold cache) and pushed workers to the heap cap, so
    // jest.config.js sets isolatedModules. Test type errors must still fail
    // `npm test`; this single incremental tsc pass is what catches them.
    const jestConfig = require(join(REPO_ROOT, 'jest.config.js')) as {
      transform: Record<string, [string, { tsconfig: { isolatedModules?: boolean } }]>;
    };
    const [, tsJest] = Object.values(jestConfig.transform)[0];
    expect(tsJest.tsconfig.isolatedModules).toBe(true);
    const testTsconfig = readJson('tsconfig.test.json') as {
      extends?: string;
      compilerOptions?: { noEmit?: boolean; tsBuildInfoFile?: string };
      include?: string[];
    };
    expect(scripts['typecheck:tests']).toBe('tsc -p tsconfig.test.json');
    expect(testTsconfig.extends).toBe('./tsconfig.json');
    expect(testTsconfig.compilerOptions?.noEmit).toBe(true);
    expect(testTsconfig.compilerOptions?.tsBuildInfoFile).toBe('./.tsbuildinfo-tests');
    expect(testTsconfig.include).toEqual(expect.arrayContaining(['src/**/*', 'tests/**/*']));
  });

  it('does not carry a redundant check:full script duplicating npm test', () => {
    // npm test already runs `pretest` (build + test type-check) before jest, so a
    // separate check:full: "npm run build && jest" script would be an exact
    // duplicate of `npm test` — not a distinct pipeline.
    expect(scripts['check:full']).toBeUndefined();
  });
});
