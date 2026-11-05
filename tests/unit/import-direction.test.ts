/**
 * Core session, runner and orchestration code depends only on core types. The files and git modules implement
 * `src/session/cwd.ts`, and the composition root injects them. A feature import here, direct or through another module
 * such as `src/api/files-router.ts`, would make core code depend on a feature again, which is the inversion the cwd
 * resolver removed.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../../src');

/**
 * `from '...'`, `import('...')`, `require('...')` and `import '...'`, type-only imports included, with single, double
 * or backtick quotes. A template literal with `${}` yields its static prefix.
 */
const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(?:['"]([^'"]+)['"]|`([^`$]*)(\$\{)?[^`]*`)/gm;

function tsFiles(entry: string): string[] {
  if (!fs.statSync(entry).isDirectory()) return [entry];
  return fs.readdirSync(entry, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(entry, d.name);
    return d.isDirectory() ? tsFiles(full) : d.name.endsWith('.ts') ? [full] : [];
  });
}

interface Specifier { spec: string; interpolated: boolean }

function specifiersIn(text: string): Specifier[] {
  return [...text.matchAll(SPECIFIER_RE)].map((m) => ({ spec: (m[1] ?? m[2])!, interpolated: m[3] !== undefined }));
}

/** Where `spec` points without an extension: relative to `file`, or to the repo root for `src/...`; null for a package. */
function target(src: string, file: string, spec: string): string | null {
  if (spec.startsWith('.')) return path.resolve(path.dirname(file), spec);
  if (spec === 'src' || spec.startsWith('src/')) return path.join(path.dirname(src), spec);
  return path.isAbsolute(spec) ? spec : null;
}

function moduleFile(base: string): string | null {
  return [`${base}.ts`, path.join(base, 'index.ts'), base].find((f) => fs.existsSync(f) && fs.statSync(f).isFile()) ?? null;
}

/**
 * Every feature module reachable from the core files through any chain of imports, as `core -> ... -> specifier`.
 * Modules between are followed whatever folder they live in, so a non-feature module that imports a feature counts.
 */
function featureImports(src: string): string[] {
  const features = ['files', 'git', 'projects'].map((d) => path.join(src, d));
  const isFeature = (t: string) => features.some((f) => t === f || t.startsWith(f + path.sep));
  const core = ['session', 'orchestration', path.join('agent', 'runner.ts')]
    .map((p) => path.join(src, p)).filter((p) => fs.existsSync(p)).flatMap(tsFiles);
  const via = new Map<string, string | null>(core.map((f) => [f, null]));
  const queue = [...core];
  const hits: string[] = [];
  const chain = (file: string): string[] => {
    const up = via.get(file);
    return [...(up ? chain(up) : []), path.relative(src, file)];
  };
  while (queue.length) {
    const file = queue.shift()!;
    for (const { spec, interpolated } of specifiersIn(fs.readFileSync(file, 'utf8'))) {
      const t = target(src, file, spec);
      if (t === null) continue;
      if (isFeature(t) || (interpolated && features.some((f) => f.startsWith(t)))) {
        hits.push([...chain(file), spec].join(' -> '));
        continue;
      }
      const next = interpolated ? null : moduleFile(t);
      if (next && next.startsWith(src + path.sep) && !via.has(next)) {
        via.set(next, file);
        queue.push(next);
      }
    }
  }
  return hits;
}

/** Writes a throwaway src tree of `files` (path -> source) and returns its feature imports. */
function probe(files: Record<string, string>): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-direction-'));
  try {
    const src = path.join(dir, 'src');
    for (const [rel, text] of Object.entries({ 'files/marks.ts': '', 'git/status.ts': '', 'projects/chat.ts': '', ...files })) {
      fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
      fs.writeFileSync(path.join(src, rel), text);
    }
    return featureImports(src);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('import direction', () => {
  it('scans the session, orchestration and runner sources', () => {
    const files = ['session', 'orchestration'].flatMap((d) => tsFiles(path.join(SRC, d)));
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(path.join(SRC, 'session', 'process.ts'));
    expect(files).toContain(path.join(SRC, 'orchestration', 'tasks', 'driver.ts'));
  });

  it('finds no import of src/files, src/git or src/projects reachable from core code, directly or through other modules', () => {
    expect(featureImports(SRC)).toEqual([]);
  });

  it.each([
    ['a static import', "import { resolveDir } from '../files/marks';"],
    ['a type-only import', "import type { GitStatus } from '../git/status';"],
    ['a dynamic import', "const lazy = () => import('../files/marks');"],
    ['a require', "const old = require('../projects/chat');"],
    ['a side-effect import', "import '../files/marks';"],
    ['a re-export', "export * from '../files/marks';"],
    ['a multiline from', "import {\n  x,\n} from\n  '../files/marks';"],
    ['a template-literal dynamic import', 'const t = () => import(`../files/marks`);'],
    ['an interpolated template-literal import', 'const t = (n: string) => import(`../files/${n}`);'],
    ['a non-relative src/ specifier', "import { x } from 'src/files/marks';"],
  ])('catches %s in a core file', (_form, line) => {
    expect(probe({ 'session/process.ts': line })).toEqual([`session/process.ts -> ${line.match(/['"`]([^'"`$]+)/)![1]}`]);
  });

  it('catches a feature import reached through a non-core module, and through the runner', () => {
    expect(probe({
      'agent/runner.ts': "import { createFilesRouter } from '../api/files-router';",
      'api/files-router.ts': "import { takeMark } from '../files/marks';",
    })).toEqual(['agent/runner.ts -> api/files-router.ts -> ../files/marks']);
  });

  it('passes core code that imports only core and shared modules', () => {
    expect(probe({
      'session/process.ts': "import { CwdResolver } from './cwd';\nimport { pathWithin } from '../utils/paths';\nimport * as fs from 'fs';",
      'session/cwd.ts': '',
      'utils/paths.ts': "import * as path from 'path';",
    })).toEqual([]);
  });
});
