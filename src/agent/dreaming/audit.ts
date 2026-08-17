/**
 * Dream audit trail: a human-readable DREAMS.md diary + a structured
 * promotions.jsonl, both under `<workspace>/.dreaming/`. Best-effort — an audit
 * write must never throw into the scheduler. In propose mode this is the ONLY
 * output; no memory file is touched.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { DreamMode, DreamOutcome, DreamProposal } from './types';

export const DREAMING_DIR = '.dreaming';

export interface DreamAuditEntry {
  ts: number;
  outcome: DreamOutcome;
  mode: DreamMode;
  summary: string;
  proposals: DreamProposal[];
  tokensSpent: number;
  sessionCount: number;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * Append one dream run to the diary + (when there are proposals) the JSONL
 * audit. Returns the diary path on success, null on any I/O failure.
 */
export function writeDreamAudit(workspaceDir: string, entry: DreamAuditEntry): string | null {
  try {
    const dir = path.join(workspaceDir, DREAMING_DIR);
    fs.mkdirSync(dir, { recursive: true });

    const iso = new Date(entry.ts).toISOString();
    const lines: string[] = [`## ${iso} — ${entry.outcome} (${entry.mode})`];
    if (entry.summary) lines.push('', entry.summary);
    if (entry.proposals.length) {
      lines.push('');
      for (const p of entry.proposals) {
        const anchor = p.target ? ` [${truncate(p.target, 40)}]` : '';
        lines.push(
          `- **${p.op}** \`${p.file}\`${anchor} — ${p.reason} ` +
            `_(score ${p.score.toFixed(2)}, recall ${p.recallCount})_`,
        );
      }
      lines.push(
        '',
        entry.mode === 'auto'
          ? '_auto mode requested — applier not yet available; proposals logged only, memory not modified._'
          : '_propose mode: proposals logged only — memory not modified._',
      );
    } else if (entry.outcome === 'no-changes') {
      lines.push('', '_No changes proposed._');
    } else if (entry.outcome === 'skipped-empty') {
      lines.push('', '_No sessions in the lookback window._');
    } else if (entry.outcome === 'error') {
      lines.push('', '_Reviewer produced no usable output (timeout or malformed) — no-op._');
    }
    lines.push('', `_tokens: ${entry.tokensSpent}, sessions: ${entry.sessionCount}_`, '', '---', '');

    fs.appendFileSync(path.join(dir, 'DREAMS.md'), lines.join('\n') + '\n', 'utf8');

    if (entry.proposals.length) {
      const jsonl =
        entry.proposals
          .map((p) => JSON.stringify({ ts: entry.ts, mode: entry.mode, ...p }))
          .join('\n') + '\n';
      fs.appendFileSync(path.join(dir, 'promotions.jsonl'), jsonl, 'utf8');
    }
    return path.join(dir, 'DREAMS.md');
  } catch {
    return null;
  }
}
