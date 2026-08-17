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
});

describe('buildBacklinks', () => {
  test('reverse edges by relPath / stem / basename / title', () => {
    const pages: WikiPage[] = [
      { relPath: 'a.md', title: 'Alpha', claims: [], confidence: null, updatedAt: null, links: ['b', 'Gamma'] },
      { relPath: 'b.md', title: 'Beta', claims: [], confidence: null, updatedAt: null, links: [] },
      { relPath: 'c.md', title: 'Gamma', claims: [], confidence: null, updatedAt: null, links: [] },
    ];
    const back = buildBacklinks(pages);
    expect(back.get('b.md')).toEqual(['a.md']); // matched by basename stem
    expect(back.get('c.md')).toEqual(['a.md']); // matched by title
  });
});

describe('buildDashboards', () => {
  const pages: WikiPage[] = [
    { relPath: 'p1.md', title: 'P1', confidence: 0.3, updatedAt: new Date(NOW - 120 * DAY).toISOString(), links: [],
      claims: [{ id: 'shared', text: 'the API is REST', status: 'supported' }, { id: 'weak', text: 'maybe', confidence: 0.2 }] },
    { relPath: 'p2.md', title: 'P2', confidence: 0.95, updatedAt: new Date(NOW - 5 * DAY).toISOString(), links: [],
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
});
