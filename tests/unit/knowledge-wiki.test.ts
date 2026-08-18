import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  parseWikiPage,
  extractLinks,
  buildBacklinks,
  buildDashboards,
  compileWiki,
  type WikiPage,
} from '../../src/agent/knowledge/wiki';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function mkVault(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-wiki-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

describe('parseWikiPage / extractLinks', () => {
  test('parses frontmatter claims/confidence/updatedAt + body links', () => {
    const raw = `---\ntitle: Deploy\nconfidence: 0.9\nupdatedAt: "2026-01-01T00:00:00Z"\nclaims:\n  - id: c1\n    text: uses kubernetes\n    status: supported\n  - just a string claim\n---\nBody links [[oncall]] and [[Runbook|the runbook]].\n`;
    const p = parseWikiPage('deploy.md', raw);
    expect(p.title).toBe('Deploy');
    expect(p.confidence).toBe(0.9);
    expect(p.updatedAt).toBe('2026-01-01T00:00:00Z');
    expect(p.claims).toHaveLength(2);
    expect(p.claims[0]).toEqual({ id: 'c1', text: 'uses kubernetes', status: 'supported', confidence: undefined });
    expect(p.links).toEqual(['oncall', 'Runbook']);
  });

  test('no/invalid frontmatter degrades gracefully; title falls back to path', () => {
    const p = parseWikiPage('notes/x.md', 'plain body [[y]]');
    expect(p.title).toBe('notes/x');
    expect(p.claims).toEqual([]);
    expect(p.links).toEqual(['y']);
  });

  test('extractLinks handles alias pipes and ignores empties', () => {
    expect(extractLinks('see [[a]] and [[ b | alias ]] and [[]]')).toEqual(['a', 'b']);
  });

  test('UNQUOTED YAML date is coerced to YYYY-MM-DD (js-yaml parses it as a Date)', () => {
    // Regression: `updatedAt: 2026-03-20` (unquoted — the natural way to write it)
    // is parsed by js-yaml into a JS Date, not a string. Without coercion the field
    // was dropped, silently disabling staleness for the page.
    const p = parseWikiPage('rl.md', '---\ntitle: RL\nupdatedAt: 2026-03-20\n---\nbody [[x]]\n');
    expect(p.updatedAt).toBe('2026-03-20');
  });

  test('unquoted-date page is flagged stale end-to-end via compileWiki', () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-wiki-stale-'));
    try {
      fs.writeFileSync(
        path.join(vault, 'old.md'),
        '---\ntitle: Old\nupdatedAt: 2026-03-20\n---\nlinks [[x]]\n',
      );
      const res = compileWiki(vault, Date.parse('2026-08-17T00:00:00Z')); // 150d later
      expect(res.stale).toBe(1);
      expect(fs.readFileSync(path.join(vault, 'reports', 'stale-pages.md'), 'utf8')).toContain('old.md');
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });
});

describe('buildBacklinks', () => {
  test('reverse edges by relPath / stem / basename / title', () => {
    const pages: WikiPage[] = [
      { relPath: 'a.md', title: 'Alpha', type: null, claims: [], confidence: null, updatedAt: null, links: ['b', 'Gamma'], excerpt: null },
      { relPath: 'b.md', title: 'Beta', type: null, claims: [], confidence: null, updatedAt: null, links: [], excerpt: null },
      { relPath: 'c.md', title: 'Gamma', type: null, claims: [], confidence: null, updatedAt: null, links: [], excerpt: null },
    ];
    const back = buildBacklinks(pages);
    expect(back.get('b.md')).toEqual(['a.md']); // matched by basename stem
    expect(back.get('c.md')).toEqual(['a.md']); // matched by title
  });
});

describe('buildDashboards', () => {
  const pages: WikiPage[] = [
    { relPath: 'p1.md', title: 'P1', type: null, confidence: 0.3, updatedAt: new Date(NOW - 120 * DAY).toISOString(), links: [], excerpt: null,
      claims: [{ id: 'shared', text: 'the API is REST', status: 'supported' }, { id: 'weak', text: 'maybe', confidence: 0.2 }] },
    { relPath: 'p2.md', title: 'P2', type: null, confidence: 0.95, updatedAt: new Date(NOW - 5 * DAY).toISOString(), links: [], excerpt: null,
      claims: [{ id: 'shared', text: 'the API is GraphQL', status: 'supported' }] },
  ];

  test('contradictions: same claim id, divergent text', () => {
    const d = buildDashboards(pages, NOW);
    expect(d.contradictions).toHaveLength(1);
    expect(d.contradictions[0].claimId).toBe('shared');
    expect(d.contradictions[0].variants).toHaveLength(2);
  });

  test('stale: pages older than 90 days', () => {
    const d = buildDashboards(pages, NOW);
    expect(d.stale.map((s) => s.page)).toEqual(['p1.md']); // 120d old
  });

  test('low-confidence: page < 0.5 and claim < 0.5', () => {
    const d = buildDashboards(pages, NOW);
    const pageLow = d.lowConfidence.find((l) => l.kind === 'page');
    const claimLow = d.lowConfidence.find((l) => l.kind === 'claim');
    expect(pageLow?.page).toBe('p1.md');
    expect(claimLow?.confidence).toBe(0.2);
  });
});

describe('compileWiki', () => {
  test('writes reports/*.md, excludes the reports dir, returns counts', () => {
    const vault = mkVault({
      'entities/deploy.md': `---\ntitle: Deploy\nclaims:\n  - id: db\n    text: postgres\n---\nlinks [[oncall]]\n`,
      'entities/oncall.md': `---\ntitle: Oncall\nclaims:\n  - id: db\n    text: mysql\n---\nno links\n`,
    });
    try {
      const res = compileWiki(vault, NOW);
      expect(res.pages).toBe(2);
      expect(res.edges).toBe(1);
      expect(res.contradictions).toBe(1); // claim id "db": postgres vs mysql

      const reportsDir = path.join(vault, 'reports');
      for (const f of ['relationship-graph.md', 'backlinks.md', 'contradictions.md', 'stale-pages.md', 'low-confidence.md']) {
        expect(fs.existsSync(path.join(reportsDir, f))).toBe(true);
      }
      expect(fs.readFileSync(path.join(reportsDir, 'backlinks.md'), 'utf8')).toContain('oncall.md');

      // A second compile must NOT treat the generated reports as source pages.
      const res2 = compileWiki(vault, NOW);
      expect(res2.pages).toBe(2);
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });

  test('skips a pathologically oversized note (DoS guard), still compiles the rest', () => {
    const vault = mkVault({
      'entities/normal.md': `---\ntitle: Normal\n---\nbody [[normal]]\n`,
      // > 512 KiB — must be skipped rather than read + YAML-parsed.
      'entities/huge.md': `---\ntitle: Huge\n---\n` + 'x'.repeat(600 * 1024),
    });
    try {
      const res = compileWiki(vault, NOW);
      expect(res.pages).toBe(1); // only normal.md; huge.md skipped
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Graph model (buildGraphModel / graphFromPages) — the /knowledge/graph payload.
// ---------------------------------------------------------------------------
import {
  graphFromPages,
  buildGraphModel,
  type GraphModel,
} from '../../src/agent/knowledge/wiki';
import { demoGraphModel, demoGraphModelSized, DEMO_MAX_SIZE } from '../../src/agent/knowledge/graph-demo';

describe('graphFromPages', () => {
  test('maps nodes (type/degree/stale/contradiction) and resolves [[link]] edges', () => {
    const pages: WikiPage[] = [
      parseWikiPage('notes/a.md', `---\ntitle: A\ntype: decision\n---\nlinks [[b]]\n`),
      parseWikiPage('notes/b.md', `---\ntitle: B\ntype: evidence\n---\nno links\n`),
      parseWikiPage('notes/old.md', `---\ntitle: Old\ntype: infra\nupdatedAt: "2023-01-01"\n---\nlinks [[a]]\n`),
    ];
    const g = graphFromPages(pages, NOW);
    expect(g.nodes).toHaveLength(3);
    const a = g.nodes.find((n) => n.id === 'notes/a.md')!;
    expect(a.type).toBe('decision');
    // a is linked-from old.md and links-to b.md → degree 2.
    expect(a.degree).toBe(2);
    // Edges: a→b and old→a (self-loops / unresolved dropped).
    expect(g.edges).toHaveLength(2);
    expect(g.edges).toContainEqual({ source: 'notes/a.md', target: 'notes/b.md' });
    const old = g.nodes.find((n) => n.id === 'notes/old.md')!;
    expect(old.stale).toBe(true); // 2023-01-01 is > 90d before NOW
    expect(a.stale).toBe(false);
  });

  test('flags both pages of a contradicting claim; dedupes repeated links; drops self-loops', () => {
    const pages: WikiPage[] = [
      parseWikiPage('notes/x.md', `---\ntitle: X\nclaims:\n  - id: m\n    text: JWT\n---\n[[y]] [[y]] [[x]]\n`),
      parseWikiPage('notes/y.md', `---\ntitle: Y\nclaims:\n  - id: m\n    text: sessions\n---\nbody\n`),
    ];
    const g = graphFromPages(pages, NOW);
    // Repeated [[y]] de-duped to one edge; [[x]] self-loop dropped.
    expect(g.edges).toEqual([{ source: 'notes/x.md', target: 'notes/y.md' }]);
    expect(g.nodes.find((n) => n.id === 'notes/x.md')!.contradiction).toBe(true);
    expect(g.nodes.find((n) => n.id === 'notes/y.md')!.contradiction).toBe(true);
  });

  test('buildGraphModel reads a real vault directory (skips reports/ and dotfiles)', () => {
    const vault = mkVault({
      'notes/a.md': `---\ntitle: A\n---\n[[b]]\n`,
      'notes/b.md': `---\ntitle: B\n---\nbody\n`,
      'reports/relationship-graph.md': `# generated — must be ignored\n[[a]]\n`,
      'notes/.tmp-draft.md': `---\ntitle: leftover\n---\n[[a]]\n`,
    });
    try {
      const g: GraphModel = buildGraphModel(vault, NOW);
      expect(g.nodes.map((n) => n.id).sort()).toEqual(['notes/a.md', 'notes/b.md']);
      expect(g.edges).toEqual([{ source: 'notes/a.md', target: 'notes/b.md' }]);
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });
});

describe('demoGraphModel', () => {
  const NOW_2026 = Date.parse('2026-08-01T00:00:00Z');
  test('renders a meaningful demo graph with edges, a contradiction, and a stale node', () => {
    const g = demoGraphModel(NOW_2026);
    expect(g.nodes.length).toBeGreaterThanOrEqual(6);
    expect(g.edges.length).toBeGreaterThan(0);
    // auth-method contradiction (JWT vs server-side sessions) flags both pages.
    const contradicting = g.nodes.filter((n) => n.contradiction).map((n) => n.id);
    expect(contradicting).toContain('notes/auth-jwt.md');
    expect(contradicting).toContain('notes/session-store.md');
    // legacy-cache is dated 2025-01-01 → stale relative to 2026.
    expect(g.nodes.find((n) => n.id === 'notes/legacy-cache.md')!.stale).toBe(true);
  });
});

describe('demoGraphModelSized', () => {
  const NOW = Date.parse('2026-08-01T00:00:00Z');

  test('generates the requested node count with a connected, clustered structure', () => {
    const g = demoGraphModelSized(NOW, 300);
    expect(g.nodes.length).toBe(300);
    expect(g.edges.length).toBeGreaterThan(200); // spokes + neighbours + bridges
    // Every edge references real nodes (link resolution held) — no dangling ids.
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
    // Hubs accrue high degree → the graph is not a uniform mesh.
    expect(Math.max(...g.nodes.map((n) => n.degree))).toBeGreaterThan(5);
    // Derived flags are genuinely produced by the pipeline, not faked.
    expect(g.nodes.some((n) => n.stale)).toBe(true);
    expect(g.nodes.some((n) => n.contradiction)).toBe(true);
  });

  test('is deterministic for a given size', () => {
    expect(demoGraphModelSized(NOW, 100)).toEqual(demoGraphModelSized(NOW, 100));
  });

  test('falls back to the hand-written demo for small sizes', () => {
    expect(demoGraphModelSized(NOW, 5)).toEqual(demoGraphModel(NOW));
  });

  test('clamps an abusive size to DEMO_MAX_SIZE', () => {
    const g = demoGraphModelSized(NOW, 999999);
    expect(g.nodes.length).toBe(DEMO_MAX_SIZE);
  });
});
