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
 *   (a) within `mcp/` itself (self-contained siblings),
 *   (b) a published directory from package.json `files` (e.g. `dist/` — the
 *       compiled artifact both runtimes consume), or
 *   (c) an exact published top-level file (e.g. `config.template.json`).
 * It may NEVER reach into `src/` (or any other non-published path), because that
 * path is absent from the tarball an end user installs. For `dist/` imports it
 * also checks that a matching `src/` source exists, so a typo'd dist path (whose
 * directory ships but whose file does not exist) is caught too.
 *
 * Consequence for local dev: because the bun MCP tools consume the COMPILED
 * `dist/` artifact, `npm run build` must have run before they can resolve those
 * imports. This is a non-issue in normal operation — the gateway runs from
 * `dist/`, and `make start` builds first — but a fresh checkout that launches an
 * MCP tool without building will hit the same "Cannot find module".
 */
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join, resolve, dirname, relative, sep } from 'path'

const REPO_ROOT = resolve(__dirname, '..', '..')
const MCP_DIR = join(REPO_ROOT, 'mcp')

/** package.json `files`, split into published directory prefixes and exact files. */
function shippedEntries(): { dirs: string[]; files: string[] } {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
  const files: string[] = pkg.files ?? []
  return {
    dirs: files.filter((f) => f.endsWith('/')).map((f) => f.replace(/\/+$/, '')), // "dist/" -> "dist"
    files: files.filter((f) => !f.endsWith('/')), // "config.template.json"
  }
}

const SHIPPED = shippedEntries()

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
 * Strip line and block comments WITHOUT touching string-literal contents, so a
 * URL like 'https://a//b' or a comment-looking path inside a string survives
 * intact (import specifiers only ever appear in real code, never in a string, so
 * nothing is lost). A small state machine walks the source tracking whether we
 * are inside a '…', "…", or `…` literal (respecting backslash escapes); a `//`
 * or block comment opener is only a comment in code context. Regex literals are
 * not special-cased — they are rare in these files and at worst leave a comment
 * unstripped, which can never hide a real import.
 */
function stripComments(source: string): string {
  let out = ''
  let quote: string | null = null
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    const c2 = source[i + 1] ?? ''
    if (quote) {
      out += c
      if (c === '\\' && i + 1 < source.length) {
        out += source[i + 1] // keep escaped char verbatim
        i++
      } else if (c === quote) {
        quote = null
      }
      continue
    }
    if (c === '/' && c2 === '/') {
      while (i < source.length && source[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (c === '/' && c2 === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++
      i++ // land on '/', the loop's i++ steps past it
      continue
    }
    if (c === '"' || c === "'" || c === '`') quote = c
    out += c
  }
  return out
}

/** Pull every relative import/require specifier out of a source file. */
export function relativeSpecifiers(source: string): string[] {
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

/**
 * Classify one relative import from one mcp file. Returns a violation message,
 * or null if the import is safe to publish. Exported so the rules can be tested
 * directly with synthetic inputs, not only against the live tree.
 */
export function classifyImport(fileAbs: string, spec: string): string | null {
  const resolvedRel = relative(REPO_ROOT, resolve(dirname(fileAbs), spec))
  const where = `${relative(REPO_ROOT, fileAbs)} imports "${spec}" -> "${resolvedRel}"`
  const parts = resolvedRel.split(sep)

  // (a) sibling within mcp/ — always fine.
  if (parts[0] === 'mcp') return null
  // (c) an exact published top-level file (e.g. config.template.json).
  if (SHIPPED.files.includes(resolvedRel)) return null
  // (b) must land in a published directory.
  const topDir = parts[0]
  if (!SHIPPED.dirs.includes(topDir)) {
    return `${where} (top-level "${topDir}" is NOT in package.json files: ${[...SHIPPED.dirs, ...SHIPPED.files].join(', ')})`
  }
  // dist/ ships, but verify the import points at a real compiled module: dist is
  // built 1:1 from src, so a matching src/<path>.ts(x) (or dir/index) must exist.
  // This catches a typo'd dist path without requiring dist to be built first.
  if (topDir === 'dist') {
    const rel = parts.slice(1).join(sep).replace(/\.(js|mjs|cjs)$/, '')
    const candidates = [
      join(REPO_ROOT, 'src', `${rel}.ts`),
      join(REPO_ROOT, 'src', `${rel}.tsx`),
      join(REPO_ROOT, 'src', rel), // extensionless file or directory (index)
      join(REPO_ROOT, 'src', rel, 'index.ts'),
    ]
    if (!candidates.some((p) => existsSync(p))) {
      return `${where} (no src counterpart src/${rel}.ts — typo?)`
    }
  }
  return null
}

describe('mcp/ must not import from unpublished paths (packaging guard)', () => {
  const mcpFiles = collectMcpSources(MCP_DIR)
  const anchor = join(MCP_DIR, 'tools', 'telegram', 'receiver-server.ts')

  it('publishes dist/ so compiled shared modules are importable at runtime', () => {
    // The whole strategy (import ../../../dist/agent/*.js from mcp) depends on
    // dist/ being in the published set. If this ever changes, mcp imports break.
    expect(SHIPPED.dirs).toContain('dist')
  })

  it('finds mcp source files to scan (guard is not a no-op)', () => {
    expect(mcpFiles.length).toBeGreaterThan(0)
  })

  it('no mcp/** file imports a path outside the published file set', () => {
    const violations: string[] = []
    for (const file of mcpFiles) {
      for (const spec of relativeSpecifiers(readFileSync(file, 'utf8'))) {
        const v = classifyImport(file, spec)
        if (v) violations.push(v)
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

  // ── Rule-level tests (synthetic inputs, independent of the live tree) ────────

  it('rejects a raw src/ import', () => {
    expect(classifyImport(anchor, '../../../src/agent/turn-trace')).toMatch(/NOT in package.json files/)
  })

  it('accepts a real dist/ import but rejects a typo with no src counterpart', () => {
    expect(classifyImport(anchor, '../../../dist/agent/turn-trace.js')).toBeNull()
    expect(classifyImport(anchor, '../../../dist/agent/does-not-exist.js')).toMatch(/no src counterpart/)
  })

  it('accepts a self-contained sibling import within mcp/', () => {
    expect(classifyImport(anchor, './typing')).toBeNull()
  })

  it('accepts an exact published top-level file (not just a directory)', () => {
    // config.template.json is a published file entry, not a directory prefix.
    expect(SHIPPED.files).toContain('config.template.json')
    expect(classifyImport(anchor, '../../../config.template.json')).toBeNull()
  })

  it('strips comments and string contents so import-like prose does not trigger', () => {
    // A path mentioned in a comment must not be treated as an import.
    expect(relativeSpecifiers("// import x from '../../../src/foo'\n")).toEqual([])
    // A '//' inside a string literal must not be mistaken for a comment.
    expect(
      relativeSpecifiers("const u = 'https://a//b'\nimport x from '../../../dist/y.js'"),
    ).toEqual(['../../../dist/y.js'])
  })
})
