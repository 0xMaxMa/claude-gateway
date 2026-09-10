/**
 * Regression guard for #479 — `npm test`'s `pretest` hook forced a full,
 * non-incremental `tsc` build on every invocation, pushing this 8GB shared
 * host to ~95% RAM with swap saturated (peak RSS occurred during the
 * `pretest` -> `tsc` step, not during the Jest run itself).
 *
 * `pretest`/`pretest:unit` still build before tests run — several `mcp/tools/**`
 * modules under test (`mcp/tools/telegram/typing.ts`, `whatsapp-cloud/module.ts`,
 * `slack/module.ts`, `skills/handlers.ts`) contain real (non-mocked) TypeScript
 * imports from `dist/**`, so ts-jest genuinely needs `dist/` built to resolve
 * them — a `jest.mock(path, factory, { virtual: true })` only substitutes the
 * module at runtime, it does not stop ts-jest's TypeScript compiler from
 * resolving the import statement at compile time (confirmed by running
 * `test:unit` against a checkout with no `dist/`: TS2307 "Cannot find module"
 * on those four files). Skipping the build for `test:unit` alone would break
 * it on any fresh checkout and in `release.yml`, which runs `npm run test:unit`
 * before its separate `Build` step.
 *
 * The actual fix is the `incremental: true` + `tsBuildInfoFile` cache below:
 * the first build after a fresh checkout still pays full cost, but every
 * repeat `tsc` invocation on the same checkout (`pretest`, `pretest:unit`,
 * `typecheck`, `check:full`) reuses the cached type info instead of
 * recompiling `src/` from scratch — which is the case that actually matters
 * on this host, where the same checkout runs tests repeatedly across a
 * session.
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
    // virtual mock), so ts-jest needs a real dist/ to type-check them.
    // Removing this hook makes `npm run test:unit` fail with TS2307 on a
    // fresh checkout (and in release.yml, which runs it before its build step).
    expect(scripts['pretest:unit']).toBe('npm run build');
    expect(scripts['test:unit']).toBeDefined();
  });

  it('still forces a real build before the full suite, which needs dist/ for real', () => {
    // tests/integration/cli-dispatch.test.ts and the pty-harness-based tests
    // spawn the compiled dist/ binaries directly — this hook must survive.
    expect(scripts['pretest']).toBe('npm run build');
  });

  it('provides a single check:full pipeline that does not run tsc twice', () => {
    const checkFull = scripts['check:full'];
    expect(checkFull).toBeDefined();
    // `npm run build` (tsc, which type-checks as part of compiling) must appear
    // exactly once, and check:full must not also shell out to `npm run
    // typecheck` / a bare `tsc --noEmit` — that would type-check the same
    // source tree a second time for nothing.
    expect((checkFull!.match(/npm run build/g) ?? []).length).toBe(1);
    expect(checkFull).not.toMatch(/npm run typecheck/);
    expect(checkFull).not.toMatch(/tsc --noEmit/);
    expect(checkFull).toMatch(/jest/);
  });
});
