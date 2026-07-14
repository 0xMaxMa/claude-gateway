/**
 * Regression guard for the packaging class of bug that silently broke every
 * Telegram receiver on systemd/global installs (v1.3.25–v1.3.26).
 *
 * Root cause: the MCP tools under `mcp/` are run directly by bun and shipped as
 * SOURCE (package.json `files` lists "mcp/", not "src/"). When an `mcp/**` file
 * imported `../../../src/agent/*`, it resolved fine in the dev repo (src exists)
 * but threw "Cannot find module" from an installed package (src is not
 * published) — so the receiver crashed on startup and the bot went silent.
 * Local tests never caught it because the dev tree always has src/.
 *
 * The rule this test enforces: a shipped `mcp/**` file may only import from
 *   (a) within `mcp/` itself (self-contained siblings), or
 *   (b) a directory that is actually published (the package.json `files` dirs,
 *       e.g. `dist/` — the compiled artifact both runtimes consume).
 * It may NEVER reach into `src/` (or any other non-published path), because that
 * path is absent from the tarball an end user installs.
 *
 * Consequence for local dev: because the bun MCP tools consume the COMPILED
 * `dist/` artifact, `npm run build` must have run before they can resolve those
 * imports. This is a non-issue in practice — the gateway itself runs from
 * `dist/`, and `make start` builds first — but a fresh checkout that launches an
 * MCP tool without building will hit the same "Cannot find module".
 */
import { readFileSync, readdirSync } from 'fs'
import { join, resolve, dirname, relative, sep } from 'path'

const REPO_ROOT = resolve(__dirname, '..', '..')
const MCP_DIR = join(REPO_ROOT, 'mcp')

/** Top-level directories that npm actually publishes (from package.json `files`). */
function shippedDirs(): string[] {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
  const files: string[] = pkg.files ?? []
  return files
    .filter((f) => f.endsWith('/'))
    .map((f) => f.replace(/\/+$/, '')) // "dist/" -> "dist"
}

/** Recursively collect every .ts/.js under mcp/, skipping mcp/node_modules. */
function collectMcpSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectMcpSources(full, out)
    else if (/\.(ts|js)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * Strip line and block comments before scanning. Import specifiers only ever
 * appear in real code, so this avoids false positives from prose that mentions
 * an import path (e.g. the very comments this repo uses to explain why these
 * files import from dist/ and not src/). Over-stripping is harmless here: we
 * only extract *relative* specifiers, which never live inside string URLs, so
 * mangling a `'https://…'` literal cannot change the result, and a real import
 * statement is never hidden behind a `//` on its own line.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/\/\/[^\n]*/g, '') // line comments
}

/** Pull every relative import/require specifier out of a source file. */
function relativeSpecifiers(source: string): string[] {
  source = stripComments(source)
  const specs: string[] = []
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g, // import ... from '...'
    /\bimport\s*['"]([^'"]+)['"]/g, // import '...'
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import('...')
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // require('...')
  ]
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(source)) !== null) {
      if (m[1].startsWith('.')) specs.push(m[1])
    }
  }
  return specs
}

describe('mcp/ must not import from unpublished paths (packaging guard)', () => {
  const SHIPPED = shippedDirs()
  const mcpFiles = collectMcpSources(MCP_DIR)

  it('publishes dist/ so compiled shared modules are importable at runtime', () => {
    // The whole strategy (import ../../../dist/agent/*.js from mcp) depends on
    // dist/ being in the published set. If this ever changes, mcp imports break.
    expect(SHIPPED).toContain('dist')
  })

  it('finds mcp source files to scan (guard is not a no-op)', () => {
    expect(mcpFiles.length).toBeGreaterThan(0)
  })

  it('no mcp/** file imports a path outside the published file set', () => {
    const violations: string[] = []

    for (const file of mcpFiles) {
      const source = readFileSync(file, 'utf8')
      for (const spec of relativeSpecifiers(source)) {
        const resolvedRel = relative(REPO_ROOT, resolve(dirname(file), spec))
        const parts = resolvedRel.split(sep)
        // Imports that stay inside mcp/ are always fine (self-contained siblings).
        if (parts[0] === 'mcp') continue
        // Anything escaping mcp/ must land in a published directory.
        const topDir = parts[0]
        if (!SHIPPED.includes(topDir)) {
          violations.push(
            `${relative(REPO_ROOT, file)} imports "${spec}" -> "${resolvedRel}" ` +
              `(top-level "${topDir}" is NOT in package.json files: ${SHIPPED.join(', ')})`,
          )
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        'mcp/ imports an unpublished path — this crashes the receiver on ' +
          'installed packages (import the compiled dist/ artifact instead):\n  ' +
          violations.join('\n  '),
      )
    }
    expect(violations).toEqual([])
  })
})
