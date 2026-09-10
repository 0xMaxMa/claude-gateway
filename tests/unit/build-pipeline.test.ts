/**
 * Regression guard for #479 — `npm test`'s `pretest` hook forced a full,
 * non-incremental `tsc` build on every invocation, pushing this 8GB shared
 * host to ~95% RAM with swap saturated (peak RSS occurred during the
 * `pretest` -> `tsc` step, not during the Jest run itself).
 *
 * `tests/unit/**` never touches `dist/` for real: the only unit test that
 * references it (`whatsapp-cloud-mcp.test.ts`) uses `jest.mock(path, factory,
 * { virtual: true })`, and `mcp-no-src-imports.test.ts` only checks that a
 * matching `src/` counterpart exists via `existsSync`, never reads `dist/`
 * itself. So `test:unit` paid the full build cost for nothing.
 *
 * The full `npm test` run is different: `tests/integration/cli-dispatch.test.ts`
 * spawns the real `dist/entry.js` binary and `tests/helpers/pty-harness.ts`
 * spawns the real `dist/shell/claude-pty-shell.js`, so that path still needs a
 * real build — `pretest` must stay wired there. The fix is scoped to the
 * `test:unit` path (which was needlessly building) plus incremental caching
 * so repeat `tsc` invocations (full `npm test`, `typecheck`, `check:full`)
 * stay cheap after the first.
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

  it('does not force a full tsc build before running unit tests alone', () => {
    // test:unit only exercises tests/unit/**, none of which reads a real dist/
    // artifact (mocks are `{ virtual: true }`, and the src-import guard checks
    // src/ existence, not dist/ content) — so it must not carry a pretest:unit
    // build hook.
    expect(scripts['pretest:unit']).toBeUndefined();
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
