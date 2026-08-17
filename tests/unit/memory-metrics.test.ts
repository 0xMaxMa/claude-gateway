import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { computeMemoryMetrics } from '../../src/agent/memory-metrics';
import { indexAgentArchive, archiveDbPath, ArchiveDB } from '../../src/agent/knowledge';
import type { AgentConfig } from '../../src/types';

// A temp agent dir (agents/<id>/workspace) so kb.sqlite lands at agents/<id>/kb.sqlite.
function mkAgent(files: Record<string, string> = {}): { agentDir: string; config: AgentConfig } {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-metrics-'));
  const workspaceDir = path.join(agentDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(workspaceDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  const config = { id: 'metric-agent', workspace: workspaceDir } as AgentConfig;
  return { agentDir, config };
}

describe('computeMemoryMetrics', () => {
  test('hygiene: budget utilization + over-budget flag', () => {
    const { agentDir, config } = mkAgent({ 'MEMORY.md': 'x'.repeat(9_000), 'USER.md': 'ok' });
    try {
      const m = computeMemoryMetrics(config, undefined);
      expect(m.hygiene.memory.chars).toBe(9_000);
      expect(m.hygiene.memory.budget).toBe(8_000); // default
      expect(m.hygiene.memory.overBudget).toBe(true);
      expect(m.hygiene.memory.utilization).toBeCloseTo(1.125, 2);
      expect(m.hygiene.user.overBudget).toBe(false);
      expect(m.sessionDropIncidents).toBe(0);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  test('hygiene: counts string length (code points), NOT UTF-8 byte size (Thai memory)', () => {
    // 3000 Thai chars = 9000 UTF-8 bytes, but JS length 3000 (< 8000 budget). The
    // metric must match the loader's `content.length` budget check (under budget),
    // not the byte size (which would wrongly report over budget).
    const { agentDir, config } = mkAgent({ 'MEMORY.md': 'ก'.repeat(3_000), 'USER.md': 'ok' });
    try {
      const m = computeMemoryMetrics(config, undefined);
      expect(m.hygiene.memory.chars).toBe(3_000);
      expect(m.hygiene.memory.overBudget).toBe(false);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  test('archive: exists=false without a kb.sqlite (metrics never create one)', () => {
    const { agentDir, config } = mkAgent({ 'MEMORY.md': 'small' });
    try {
      const m = computeMemoryMetrics(config, undefined);
      expect(m.archive.exists).toBe(false);
      expect(m.archive.sources).toBe(0);
      expect(fs.existsSync(archiveDbPath(config.workspace))).toBe(false); // not created
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  test('archive: reports source + chunk counts once indexed', () => {
    const { agentDir, config } = mkAgent({
      'MEMORY.md': 'the deploy runs on kubernetes',
      'memory/note.md': 'an atomic note about ingress',
    });
    try {
      indexAgentArchive(config.workspace);
      const m = computeMemoryMetrics(config, undefined);
      expect(m.archive.exists).toBe(true);
      expect(m.archive.sources).toBe(2); // MEMORY.md + memory/note.md
      expect(m.archive.chunks).toBeGreaterThanOrEqual(2);
      ArchiveDB.evict(archiveDbPath(config.workspace));
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  test('dreaming: parses promotions.jsonl into run/proposal counts + last run', () => {
    const { agentDir, config } = mkAgent({ 'MEMORY.md': 'm' });
    try {
      const dir = path.join(config.workspace, '.dreaming');
      fs.mkdirSync(dir, { recursive: true });
      const t1 = 1_700_000_000_000;
      const t2 = 1_700_000_100_000;
      fs.writeFileSync(
        path.join(dir, 'promotions.jsonl'),
        [
          JSON.stringify({ ts: t1, mode: 'propose', op: 'add', file: 'MEMORY.md' }),
          JSON.stringify({ ts: t1, mode: 'propose', op: 'remove', file: 'MEMORY.md' }),
          JSON.stringify({ ts: t2, mode: 'auto', op: 'add', file: 'MEMORY.md' }),
          'malformed line to ignore',
        ].join('\n') + '\n',
      );
      const m = computeMemoryMetrics(config, undefined);
      expect(m.dreaming.proposals).toBe(3);
      expect(m.dreaming.runs).toBe(2); // two distinct ts
      expect(m.dreaming.lastRunISO).toBe(new Date(t2).toISOString());
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  test('shared: reflects config + reports 0 when the shared vault is empty', () => {
    const { agentDir, config } = mkAgent({ 'MEMORY.md': 'm' });
    // Point the shared vault at a temp root so the metric never reads the real
    // ~/.claude-gateway shared KB (test isolation).
    config.knowledge = { shared: { root: path.join(agentDir, 'shared-root'), project: 'testproj' } };
    try {
      const m = computeMemoryMetrics(config, undefined);
      expect(m.shared.enabled).toBe(true); // default
      expect(m.shared.project).toBe('testproj');
      expect(m.shared.sources).toBe(0); // empty temp vault
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
