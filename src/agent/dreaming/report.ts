/**
 * Parse the dream audit trail (`.dreaming/DREAMS.md` + `promotions.jsonl`) into a
 * structured, newest-first list of runs for the dashboard's "Nightly dreaming" tab.
 *
 * DREAMS.md is the source of truth for *every* run (including no-change / skipped
 * nights) — it carries the header (iso + outcome + mode), summary, and the
 * tokens/sessions footer. promotions.jsonl carries the structured proposal ops
 * (with full `content`), all ops of one run sharing that run's `ts`. The two are
 * joined by `ts` (DREAMS.md's iso parses back to exactly the promotions `ts`).
 *
 * Pure + deterministic (no clock, no disk) so it is unit-testable. Both inputs are
 * untrusted on-disk text — every field is defensively coerced.
 */

export interface DreamProposalView {
  /** Position within its run's proposal list — the accept target the UI sends back. */
  index: number;
  op: string;
  file: string;
  target?: string;
  content?: string;
  reason: string;
  score: number;
  recallCount: number;
  /** True when this proposal was applied to memory via a manual dashboard accept. */
  accepted: boolean;
}

export interface DreamRunReport {
  ts: number;
  iso: string;
  outcome: string;
  mode: string; // 'propose' | 'auto'
  summary: string;
  tokens: number;
  sessions: number;
  applied: number | null; // ops written to memory in auto mode; null for propose
  proposals: DreamProposalView[];
}

function groupPromotionsByTs(
  jsonl: string,
  acceptedKeys: Set<string>,
): Map<number, DreamProposalView[]> {
  const byTs = new Map<number, DreamProposalView[]>();
  for (const raw of jsonl.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // skip a malformed line rather than fail the whole report
    }
    const ts = Number(o.ts);
    if (!Number.isFinite(ts)) continue;
    const arr = byTs.get(ts) ?? [];
    const index = arr.length; // position within this run — the accept target
    const view: DreamProposalView = {
      index,
      op: String(o.op ?? ''),
      file: String(o.file ?? ''),
      target: typeof o.target === 'string' ? o.target : undefined,
      content: typeof o.content === 'string' ? o.content : undefined,
      reason: String(o.reason ?? ''),
      score: Number(o.score) || 0,
      recallCount: Number(o.recallCount) || 0,
      accepted: acceptedKeys.has(`${ts}:${index}`),
    };
    arr.push(view);
    byTs.set(ts, arr);
  }
  return byTs;
}

/** Parse `accepted.jsonl` into a set of `"<ts>:<index>"` keys. */
function parseAcceptedKeys(acceptedJsonl: string): Set<string> {
  const keys = new Set<string>();
  for (const raw of acceptedJsonl.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      const ts = Number(o.ts);
      const idx = Number(o.index);
      if (Number.isFinite(ts) && Number.isFinite(idx)) keys.add(`${ts}:${idx}`);
    } catch {
      /* skip malformed line */
    }
  }
  return keys;
}

/** First meaningful prose line(s) after the header, before the first bullet / italic / rule. */
function extractSummary(sectionLines: string[]): string {
  const out: string[] = [];
  for (let i = 1; i < sectionLines.length; i++) {
    const l = sectionLines[i].trim();
    if (!l) {
      if (out.length) break; // blank after we've collected summary → done
      continue; // leading blank → keep looking
    }
    if (l.startsWith('- ') || l.startsWith('_') || l.startsWith('---') || l.startsWith('## ')) break;
    out.push(l);
  }
  return out.join(' ');
}

export function parseDreamReport(
  dreamsMd: string,
  promotionsJsonl: string,
  acceptedJsonl = '',
): DreamRunReport[] {
  const acceptedKeys = parseAcceptedKeys(acceptedJsonl);
  const byTs = groupPromotionsByTs(promotionsJsonl, acceptedKeys);
  const runs: DreamRunReport[] = [];
  // Each run is a "## <iso> — <outcome> (<mode>)" section.
  const sections = dreamsMd.split(/\n(?=## )/);
  for (const sec of sections) {
    const lines = sec.split('\n');
    const header = lines[0].match(/^## (\S+) — (.+?) \((propose|auto)\)\s*$/);
    if (!header) continue;
    const iso = header[1];
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) continue;
    const tok = sec.match(/_tokens: (\d+), sessions: (\d+)_/);
    const app = sec.match(/applied (\d+) op/);
    runs.push({
      ts,
      iso,
      outcome: header[2].trim(),
      mode: header[3],
      summary: extractSummary(lines),
      tokens: tok ? Number(tok[1]) : 0,
      sessions: tok ? Number(tok[2]) : 0,
      applied: app ? Number(app[1]) : null,
      proposals: byTs.get(ts) ?? [],
    });
  }
  runs.sort((a, b) => b.ts - a.ts); // newest first
  return runs;
}
