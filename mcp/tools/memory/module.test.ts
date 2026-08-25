/**
 * Bun tests for MemoryModule.handleTool's memory_shared_create / _get / _update /
 * _delete — the exists/missing gates, the near-duplicate nudge on create, and the
 * content-loss confirmation guard on update.
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { MemoryModule } from './module';

let workspaceDir: string;
let vaultDir: string;
const originalEnv = {
  GATEWAY_WORKSPACE_DIR: process.env.GATEWAY_WORKSPACE_DIR,
  GATEWAY_SHARED_KB_DIR: process.env.GATEWAY_SHARED_KB_DIR,
};

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-module-ws-'));
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-module-shared-'));
  process.env.GATEWAY_WORKSPACE_DIR = workspaceDir;
  process.env.GATEWAY_SHARED_KB_DIR = vaultDir;
});

afterEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(vaultDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function textOf(result: Awaited<ReturnType<MemoryModule['handleTool']>>): string {
  return (result.content[0] as { text: string }).text;
}

test('memory_shared_create: writes a new note under a freeform name (no agent-id prefix)', async () => {
  const mod = new MemoryModule();
  const result = await mod.handleTool('memory_shared_create', { name: 'oncall-runbook', content: 'escalate to SRE' });
  expect(result.isError).toBeUndefined();
  const body = JSON.parse(textOf(result));
  expect(body.created).toBe(true);
  expect(fs.existsSync(path.join(vaultDir, 'notes', 'oncall-runbook.md'))).toBe(true);
});

test('memory_shared_create: fails with an exact-name collision, does not overwrite', async () => {
  const mod = new MemoryModule();
  await mod.handleTool('memory_shared_create', { name: 'oncall-runbook', content: 'v1: escalate to platform team' });
  const result = await mod.handleTool('memory_shared_create', { name: 'oncall-runbook', content: 'v2 attempt' });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain('already exists');
  expect(fs.readFileSync(path.join(vaultDir, 'notes', 'oncall-runbook.md'), 'utf8')).toBe('v1: escalate to platform team');
});

test('memory_shared_create: any agent can create — no GATEWAY_AGENT_ID required', async () => {
  delete process.env.GATEWAY_AGENT_ID;
  const mod = new MemoryModule();
  const result = await mod.handleTool('memory_shared_create', { name: 'oncall-runbook', content: 'escalate to SRE' });
  expect(result.isError).toBeUndefined();
});

test('memory_shared_get: reads full content; errors on a missing note', async () => {
  const mod = new MemoryModule();
  const missing = await mod.handleTool('memory_shared_get', { name: 'oncall-runbook' });
  expect(missing.isError).toBe(true);

  await mod.handleTool('memory_shared_create', { name: 'oncall-runbook', content: 'escalate to SRE' });
  const result = await mod.handleTool('memory_shared_get', { name: 'oncall-runbook' });
  expect(result.isError).toBeUndefined();
  const body = JSON.parse(textOf(result));
  expect(body.content).toBe('escalate to SRE');
});

test('memory_shared_update: fails when the note does not exist yet, pointing at memory_shared_create', async () => {
  const mod = new MemoryModule();
  const result = await mod.handleTool('memory_shared_update', { name: 'oncall-runbook', content: 'escalate to SRE' });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain('memory_shared_create');
});

test('memory_shared_update: applies a small edit (below the loss threshold) without confirm', async () => {
  const mod = new MemoryModule();
  await mod.handleTool('memory_shared_create', { name: 'oncall-runbook', content: 'line one\nline two\nline three\nline four' });
  // Drop 1 of 4 lines (25% loss) — under the 50% threshold, should apply directly.
  const result = await mod.handleTool('memory_shared_update', { name: 'oncall-runbook', content: 'line one\nline two\nline three' });
  expect(result.isError).toBeUndefined();
  const body = JSON.parse(textOf(result));
  expect(body.updated).toBe(true);
  expect(fs.readFileSync(path.join(vaultDir, 'notes', 'oncall-runbook.md'), 'utf8')).toBe('line one\nline two\nline three');
});

test('memory_shared_update: a large content loss needs confirm:true, and does not write until given', async () => {
  const mod = new MemoryModule();
  await mod.handleTool('memory_shared_create', { name: 'oncall-runbook', content: 'line one\nline two\nline three\nline four' });

  const warned = await mod.handleTool('memory_shared_update', { name: 'oncall-runbook', content: 'brand new unrelated content' });
  expect(warned.isError).toBeUndefined();
  const warnedBody = JSON.parse(textOf(warned));
  expect(warnedBody.updated).toBe(false);
  expect(warnedBody.needsConfirmation).toBe(true);
  expect(warnedBody.lossPercent).toBe(100);
  // Still the original content — the warning must not have written anything.
  expect(fs.readFileSync(path.join(vaultDir, 'notes', 'oncall-runbook.md'), 'utf8')).toBe('line one\nline two\nline three\nline four');

  const confirmed = await mod.handleTool('memory_shared_update', { name: 'oncall-runbook', content: 'brand new unrelated content', confirm: true });
  const confirmedBody = JSON.parse(textOf(confirmed));
  expect(confirmedBody.updated).toBe(true);
  expect(fs.readFileSync(path.join(vaultDir, 'notes', 'oncall-runbook.md'), 'utf8')).toBe('brand new unrelated content');
});

test('memory_shared_delete: any agent can delete any note — no ownership scoping', async () => {
  const mod = new MemoryModule();
  await mod.handleTool('memory_shared_create', { name: 'oncall-runbook', content: 'escalate to SRE' });
  delete process.env.GATEWAY_AGENT_ID; // a different/misconfigured agent — still allowed
  const result = await mod.handleTool('memory_shared_delete', { name: 'oncall-runbook' });
  expect(result.isError).toBeUndefined();
  expect(fs.existsSync(path.join(vaultDir, 'notes', 'oncall-runbook.md'))).toBe(false);
});

test('memory_shared_delete: errors (no-op) on a name that does not exist', async () => {
  const mod = new MemoryModule();
  const result = await mod.handleTool('memory_shared_delete', { name: 'never-created' });
  expect(result.isError).toBe(true);
});

// End-to-end proof that memory_shared_create's near-duplicate nudge actually
// fires through the real reindex path (not just the pure findSimilarSharedNotes
// unit tests in archive-reader.test.ts). Skips gracefully if dist/ hasn't been
// built, same guard as archive-writer.test.ts's e2e reindex test.
test('memory_shared_create: near-duplicate content is nudged for confirmation once reindexed', async () => {
  const cliPath = path.join(__dirname, '..', '..', '..', 'dist', 'agent', 'knowledge', 'reindex-cli.js');
  if (!fs.existsSync(cliPath)) {
    console.warn('[memory module.test] dist/agent/knowledge/reindex-cli.js missing — run `npm run build` first; skipping e2e near-dup test');
    return;
  }
  const mod = new MemoryModule();
  await mod.handleTool('memory_shared_create', {
    name: 'oncall-escalation-runbook',
    content: 'escalate paging incidents to the platform team via pagerduty, then page SRE if unacknowledged in 10 minutes',
  });

  // Wait for the fire-and-forget reindex triggered by the create above.
  const dbPath = path.join(vaultDir, 'kb.sqlite');
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !fs.existsSync(dbPath)) {
    await new Promise((r) => setTimeout(r, 150));
  }

  let result = await mod.handleTool('memory_shared_create', {
    name: 'paging-oncall-playbook',
    content: 'oncall playbook: paging escalation to platform team via pagerduty',
  });
  // Reindex is best-effort/async; retry briefly if it hadn't landed yet.
  const retryDeadline = Date.now() + 8000;
  while (Date.now() < retryDeadline) {
    const body = JSON.parse(textOf(result));
    if (body.needsConfirmation) break;
    await new Promise((r) => setTimeout(r, 200));
    result = await mod.handleTool('memory_shared_create', {
      name: 'paging-oncall-playbook',
      content: 'oncall playbook: paging escalation to platform team via pagerduty',
    });
  }
  const body = JSON.parse(textOf(result));
  expect(body.created).toBe(false);
  expect(body.needsConfirmation).toBe(true);
  expect(body.similar.some((s: { path: string }) => s.path.includes('oncall-escalation-runbook'))).toBe(true);
  expect(fs.existsSync(path.join(vaultDir, 'notes', 'paging-oncall-playbook.md'))).toBe(false);

  // confirm:true creates it anyway.
  const confirmed = await mod.handleTool('memory_shared_create', {
    name: 'paging-oncall-playbook',
    content: 'oncall playbook: paging escalation to platform team via pagerduty',
    confirm: true,
  });
  expect(JSON.parse(textOf(confirmed)).created).toBe(true);

  // #386: confirming past a near-dup nudge should link the related note(s)
  // found, not leave a disconnected duplicate — so /knowledge/graph gets a
  // real edge instead of staying empty.
  const written = fs.readFileSync(path.join(vaultDir, 'notes', 'paging-oncall-playbook.md'), 'utf8');
  expect(written).toContain('[[oncall-escalation-runbook]]');
}, 20000);
