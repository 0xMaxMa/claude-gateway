/**
 * Demo dataset for the Knowledge Base graph viewer. When the real shared vault
 * is empty, the `/knowledge/graph` endpoint serves this clearly-labelled demo
 * (response `demo: true`) so the viewer renders something meaningful instead of a
 * blank canvas — without silently masking the real empty state.
 *
 * The demo is built by running real note strings through the SAME parse + graph
 * pipeline as live notes (`parseWikiPage` → `graphFromPages`), so the contradiction
 * / stale / low-confidence flags are genuinely derived, not hand-faked.
 */

import { parseWikiPage, graphFromPages, type GraphModel } from './wiki';

// [relPath, raw markdown]. `notes/` prefix mirrors the real vault layout.
const DEMO_NOTES: Array<[string, string]> = [
  [
    'notes/api-gateway.md',
    '---\ntitle: API Gateway\ntype: decision\nconfidence: 0.9\n---\nFront door for all services. See [[auth-jwt]] and [[rate-limit]].\n',
  ],
  [
    'notes/auth-jwt.md',
    '---\ntitle: Auth via JWT\ntype: decision\nconfidence: 0.85\nclaims:\n  - id: auth-method\n    text: JWT bearer tokens\n    status: adopted\n---\nStateless auth using signed JWTs. Depends on [[session-store]].\n',
  ],
  [
    'notes/session-store.md',
    '---\ntitle: Session Store\ntype: decision\nconfidence: 0.6\nclaims:\n  - id: auth-method\n    text: server-side sessions\n    status: proposed\n---\nServer-side sessions in [[redis]] (contradicts the JWT decision).\n',
  ],
  [
    'notes/rate-limit.md',
    '---\ntitle: Rate Limiting\ntype: policy\nconfidence: 0.8\n---\nToken-bucket per API key, backed by [[redis]].\n',
  ],
  [
    'notes/redis.md',
    '---\ntitle: Redis\ntype: infra\nconfidence: 0.9\n---\nShared cache + rate-limit counters. Snapshots go to [[backup-policy]].\n',
  ],
  [
    'notes/db-postgres.md',
    '---\ntitle: Postgres\ntype: evidence\nconfidence: 0.95\n---\nPrimary datastore. Governed by [[backup-policy]].\n',
  ],
  [
    'notes/backup-policy.md',
    '---\ntitle: Backup Policy\ntype: policy\nconfidence: 0.4\n---\nNightly snapshots, 3-day retention. Still under review (low confidence).\n',
  ],
  [
    'notes/legacy-cache.md',
    '---\ntitle: Legacy Cache\ntype: decision\nconfidence: 0.7\nupdatedAt: "2025-01-01"\n---\nOld in-process cache, superseded by [[redis]]. Kept for reference.\n',
  ],
];

/** Build the demo graph model. `now` injected so staleness is deterministic per call. */
export function demoGraphModel(now: number): GraphModel {
  const pages = DEMO_NOTES.map(([rel, raw]) => parseWikiPage(rel, raw));
  return graphFromPages(pages, now);
}

/** Largest synthetic graph the sized demo will build — guards the endpoint from an abusive ?demo=99999. */
export const DEMO_MAX_SIZE = 1000;

/** Deterministic PRNG (mulberry32) — a given size always yields the same graph (stable for tests + caching). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEMO_TYPES = ['decision', 'policy', 'infra', 'evidence', 'claim'];

/**
 * Build a synthetic *clustered* graph of `size` notes for stress-testing the
 * viewer at scale (the dashboard's 100 / 300 size selector) without a populated
 * vault. Notes are generated as real markdown with [[wikilinks]] and run through
 * the SAME parse + graph pipeline as live notes, so degree / stale / contradiction
 * flags are genuinely derived — not hand-faked. Deterministic per `size` (seeded
 * PRNG). Sizes <= the hand-written demo fall back to it. Clamped to DEMO_MAX_SIZE.
 */
export function demoGraphModelSized(now: number, size: number): GraphModel {
  const n = Math.max(1, Math.min(DEMO_MAX_SIZE, Math.floor(size)));
  if (n <= DEMO_NOTES.length) return demoGraphModel(now);

  const rnd = mulberry32(n);
  const clusters = Math.max(3, Math.round(Math.sqrt(n)));
  const id = (i: number): string => 'n' + String(i).padStart(4, '0');
  const notes: Array<[string, string]> = [];

  for (let i = 0; i < n; i++) {
    const c = i % clusters; // round-robin keeps clusters balanced
    const hub = c; // first node of each cluster is its hub (nodes 0..clusters-1)
    const isHub = i < clusters;
    const links: string[] = [];
    if (!isHub) links.push(id(hub)); // spoke -> hub (hub gains high degree = big node)
    // 1-2 intra-cluster neighbours for local structure
    const nbr = clusters + Math.floor(rnd() * Math.max(1, n - clusters));
    if (nbr < n && nbr !== i) links.push(id(nbr));
    // ~12% cross-cluster bridge to another hub (keeps the graph one connected mass)
    if (rnd() < 0.12) {
      const other = Math.floor(rnd() * clusters);
      if (other !== hub) links.push(id(other));
    }

    const type = DEMO_TYPES[i % DEMO_TYPES.length];
    const confidence = (0.35 + rnd() * 0.6).toFixed(2); // spread of low..high confidence
    const stale = rnd() < 0.15 ? '\nupdatedAt: "2024-06-01"' : ''; // ~15% old -> stale flag
    // ~4% of nodes take part in a shared claim with alternating status -> contradiction flag
    const claim =
      rnd() < 0.04
        ? '\nclaims:\n  - id: scale-choice\n    text: partition strategy\n    status: ' +
          (i % 2 === 0 ? 'adopted' : 'proposed')
        : '';
    const linkLine = links.map((l) => '[[' + l + ']]').join(' ');
    const raw =
      '---\ntitle: Node ' +
      String(i) +
      '\ntype: ' +
      type +
      '\nconfidence: ' +
      confidence +
      stale +
      claim +
      '\n---\nSynthetic note ' +
      i +
      ' in cluster ' +
      c +
      '. ' +
      linkLine +
      '\n';
    notes.push(['notes/' + id(i) + '.md', raw]);
  }

  const pages = notes.map(([rel, raw]) => parseWikiPage(rel, raw));
  return graphFromPages(pages, now);
}
