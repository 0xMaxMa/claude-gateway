/**
 * Shared-KB graph layer (planning-64 K5) — a deterministic, memory-wiki-style
 * compile over the shared vault. NO LLM. Reads the vault's `*.md` notes (YAML
 * frontmatter: title, claims[], evidence[], confidence, updatedAt; body
 * `[[wiki-links]]`) and writes `reports/*.md`:
 *   - relationship-graph.md — every [[link]] edge, flat.
 *   - backlinks.md          — a "referenced by" map (the reverse edges).
 *   - contradictions.md     — claims sharing an id but diverging in text/status.
 *   - stale-pages.md        — pages older than the stale threshold.
 *   - low-confidence.md     — pages/claims with confidence < 0.5.
 *
 * Mirrors openclaw memory-wiki's shallow, pure-function dashboards. Opt-in via
 * `gateway.knowledge.shared.graph`. Runs off the event loop (after the shared
 * reindex). Report pages are never treated as source pages (no self-reference).
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

const WIKI_STALE_DAYS = 90;
const LOW_CONFIDENCE = 0.5;
const REPORTS_DIR = 'reports';
// Guards against a pathological note (a multi-hundred-MB file or a YAML
// anchor/alias "billion laughs" frontmatter) OOM-ing or hanging the reindex
// subprocess: oversized notes are skipped, and the frontmatter block handed to
// js-yaml is length-capped before parsing.
const MAX_NOTE_BYTES = 512 * 1024;
const MAX_FRONTMATTER_CHARS = 64 * 1024;
const REPORT_NAMES = new Set([
  'relationship-graph.md',
  'backlinks.md',
  'contradictions.md',
  'stale-pages.md',
  'low-confidence.md',
]);

export interface WikiClaim {
  id?: string;
  text: string;
  status?: string;
  confidence?: number;
}

export interface WikiPage {
  relPath: string; // vault-relative, POSIX
  title: string;
  claims: WikiClaim[];
  confidence: number | null;
  updatedAt: string | null;
  links: string[]; // [[targets]] found in the body
}

export interface WikiCompileResult {
  pages: number;
  edges: number;
  contradictions: number;
  stale: number;
  lowConfidence: number;
}

function toStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
function toNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Split `--- yaml --- body`; tolerate a missing/invalid frontmatter block. */
function splitFrontmatter(raw: string): { fm: Record<string, unknown>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) return { fm: {}, body: raw };
  // Cap the frontmatter block before parsing — a huge/alias-bomb block is treated
  // as "no frontmatter" rather than fed to js-yaml.
  if (m[1].length > MAX_FRONTMATTER_CHARS) return { fm: {}, body: m[2] };
  let fm: Record<string, unknown> = {};
  try {
    const loaded = yaml.load(m[1]);
    if (loaded && typeof loaded === 'object') fm = loaded as Record<string, unknown>;
  } catch {
    fm = {};
  }
  return { fm, body: m[2] };
}

/** Extract `[[target]]` link targets from a body (code spans not masked — v1). */
export function extractLinks(body: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const t = m[1].trim();
    if (t) out.push(t);
  }
  return out;
}

function normalizeClaims(v: unknown): WikiClaim[] {
  if (!Array.isArray(v)) return [];
  const out: WikiClaim[] = [];
  for (const item of v) {
    if (typeof item === 'string') {
      if (item.trim()) out.push({ text: item.trim() });
      continue;
    }
    if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      const text = toStr(rec.text);
      if (!text) continue; // a claim with no text is dropped
      out.push({ id: toStr(rec.id), text, status: toStr(rec.status), confidence: toNum(rec.confidence) });
    }
  }
  return out;
}

export function parseWikiPage(relPath: string, raw: string): WikiPage {
  const { fm, body } = splitFrontmatter(raw);
  return {
    relPath,
    title: toStr(fm.title) ?? relPath.replace(/\.md$/i, ''),
    claims: normalizeClaims(fm.claims),
    confidence: toNum(fm.confidence) ?? null,
    updatedAt: toStr(fm.updatedAt) ?? null,
    links: extractLinks(body),
  };
}

/** page relPath, its stem, its basename, and its title — all match keys for a link. */
function pageKeys(p: WikiPage): string[] {
  const rel = p.relPath;
  const noExt = rel.replace(/\.md$/i, '');
  const base = path.posix.basename(noExt);
  return [rel, noExt, base, p.title].map((s) => s.toLowerCase());
}

/** Map each page to the pages that link to it (reverse [[link]] edges). */
export function buildBacklinks(pages: WikiPage[]): Map<string, string[]> {
  const keyToPage = new Map<string, string>();
  for (const p of pages) for (const k of pageKeys(p)) keyToPage.set(k, p.relPath);
  const back = new Map<string, string[]>();
  for (const p of pages) {
    for (const link of p.links) {
      const target = keyToPage.get(link.toLowerCase());
      if (!target || target === p.relPath) continue;
      const arr = back.get(target) ?? [];
      if (!arr.includes(p.relPath)) arr.push(p.relPath);
      back.set(target, arr);
    }
  }
  return back;
}

export interface Dashboards {
  contradictions: Array<{ claimId: string; variants: Array<{ page: string; text: string; status?: string }> }>;
  stale: Array<{ page: string; updatedAt: string; ageDays: number }>;
  lowConfidence: Array<{ page: string; confidence: number; kind: 'page' | 'claim'; text?: string }>;
}

export function buildDashboards(pages: WikiPage[], now: number): Dashboards {
  // Contradictions: claims sharing an id whose normalized text OR status diverges.
  const byId = new Map<string, Array<{ page: string; text: string; status?: string }>>();
  for (const p of pages) {
    for (const c of p.claims) {
      if (!c.id) continue;
      const arr = byId.get(c.id) ?? [];
      arr.push({ page: p.relPath, text: c.text, status: c.status });
      byId.set(c.id, arr);
    }
  }
  const contradictions: Dashboards['contradictions'] = [];
  for (const [claimId, variants] of byId) {
    if (variants.length < 2) continue;
    const distinctText = new Set(variants.map((v) => v.text.trim().toLowerCase()));
    const distinctStatus = new Set(variants.map((v) => (v.status ?? '').trim().toLowerCase()));
    if (distinctText.size > 1 || distinctStatus.size > 1) contradictions.push({ claimId, variants });
  }

  // Stale: pages whose updatedAt is older than the threshold.
  const stale: Dashboards['stale'] = [];
  for (const p of pages) {
    if (!p.updatedAt) continue;
    const t = Date.parse(p.updatedAt);
    if (Number.isNaN(t)) continue;
    const ageDays = Math.floor((now - t) / (24 * 60 * 60 * 1000));
    if (ageDays >= WIKI_STALE_DAYS) stale.push({ page: p.relPath, updatedAt: p.updatedAt, ageDays });
  }

  // Low confidence: page-level or claim-level confidence below the threshold.
  const lowConfidence: Dashboards['lowConfidence'] = [];
  for (const p of pages) {
    if (p.confidence !== null && p.confidence < LOW_CONFIDENCE) {
      lowConfidence.push({ page: p.relPath, confidence: p.confidence, kind: 'page' });
    }
    for (const c of p.claims) {
      if (c.confidence !== undefined && c.confidence < LOW_CONFIDENCE) {
        lowConfidence.push({ page: p.relPath, confidence: c.confidence, kind: 'claim', text: c.text });
      }
    }
  }
  return { contradictions, stale, lowConfidence };
}

function renderReports(pages: WikiPage[], back: Map<string, string[]>, d: Dashboards): Record<string, string> {
  const gen = '<!-- generated by knowledge/wiki.ts — do not edit -->\n\n';

  const edges: string[] = [];
  for (const p of pages) for (const l of p.links) edges.push(`- \`${p.relPath}\` → [[${l}]]`);

  const backLines: string[] = [];
  for (const [target, refs] of [...back.entries()].sort()) {
    backLines.push(`- \`${target}\` ← ${refs.map((r) => `\`${r}\``).join(', ')}`);
  }

  const contra = d.contradictions.map(
    (c) => `- **${c.claimId}**:\n${c.variants.map((v) => `    - \`${v.page}\`: ${v.text}${v.status ? ` _(${v.status})_` : ''}`).join('\n')}`,
  );
  const stale = d.stale.sort((a, b) => b.ageDays - a.ageDays).map((s) => `- \`${s.page}\` — ${s.ageDays}d old (updated ${s.updatedAt})`);
  const low = d.lowConfidence.map((l) => `- \`${l.page}\` — ${l.kind} confidence ${l.confidence}${l.text ? `: ${l.text}` : ''}`);

  const section = (title: string, lines: string[], empty: string): string =>
    `${gen}# ${title}\n\n${lines.length ? lines.join('\n') : `_${empty}_`}\n`;

  return {
    'relationship-graph.md': section('Relationship graph', edges, 'No links yet.'),
    'backlinks.md': section('Backlinks', backLines, 'No backlinks yet.'),
    'contradictions.md': section('Contradictions', contra, 'No contradictions detected.'),
    'stale-pages.md': section(`Stale pages (≥ ${WIKI_STALE_DAYS}d)`, stale, 'No stale pages.'),
    'low-confidence.md': section(`Low confidence (< ${LOW_CONFIDENCE})`, low, 'No low-confidence entries.'),
  };
}

/** Recursively collect vault `*.md` files, EXCLUDING the reports dir. */
function collectPages(vaultDir: string, dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); // deterministic order
  for (const e of entries) {
    if (e.name.startsWith('.')) continue; // skip dotfiles / `.tmp-*` write leftovers
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (path.relative(vaultDir, full) === REPORTS_DIR) continue; // never scan generated reports
      collectPages(vaultDir, full, out);
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      out.push(full);
    }
  }
}

/**
 * Compile the wiki reports for a vault. Deterministic; `now` is injected. Writes
 * `<vault>/reports/*.md`. Best-effort per file. Returns summary counts.
 */
export function compileWiki(vaultDir: string, now: number): WikiCompileResult {
  const absFiles: string[] = [];
  collectPages(vaultDir, vaultDir, absFiles);
  const pages: WikiPage[] = [];
  for (const abs of absFiles) {
    const rel = path.relative(vaultDir, abs).split(path.sep).join('/');
    if (REPORT_NAMES.has(path.posix.basename(rel)) && rel.startsWith(`${REPORTS_DIR}/`)) continue;
    let raw: string;
    try {
      if (fs.statSync(abs).size > MAX_NOTE_BYTES) continue; // oversized note — skip (DoS guard)
      raw = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    pages.push(parseWikiPage(rel, raw));
  }

  const back = buildBacklinks(pages);
  const dash = buildDashboards(pages, now);
  const reports = renderReports(pages, back, dash);

  const reportsDir = path.join(vaultDir, REPORTS_DIR);
  fs.mkdirSync(reportsDir, { recursive: true });
  for (const [name, content] of Object.entries(reports)) {
    try {
      fs.writeFileSync(path.join(reportsDir, name), content, 'utf8');
    } catch {
      /* best-effort */
    }
  }

  const edges = pages.reduce((n, p) => n + p.links.length, 0);
  return {
    pages: pages.length,
    edges,
    contradictions: dash.contradictions.length,
    stale: dash.stale.length,
    lowConfidence: dash.lowConfidence.length,
  };
}
