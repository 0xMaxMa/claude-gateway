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
