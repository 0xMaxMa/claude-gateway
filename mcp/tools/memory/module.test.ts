/**
 * Bun tests for MemoryModule.handleTool's memory_shared_write / memory_shared_delete
 * gating — specifically that a missing GATEWAY_AGENT_ID fails closed instead of
 * falling back to a shared 'agent' identity (which would let two misconfigured
 * agents overwrite/delete each other's notes).
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
  GATEWAY_AGENT_ID: process.env.GATEWAY_AGENT_ID,
};

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-module-ws-'));
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-module-shared-'));
  process.env.GATEWAY_WORKSPACE_DIR = workspaceDir;
  process.env.GATEWAY_SHARED_KB_DIR = vaultDir;
  process.env.GATEWAY_AGENT_ID = 'test-agent';
});

afterEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(vaultDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('memory_shared_write: fails closed (does not fall back to a shared identity) when GATEWAY_AGENT_ID is unset', async () => {
  delete process.env.GATEWAY_AGENT_ID;
  const mod = new MemoryModule();
  const result = await mod.handleTool('memory_shared_write', { content: 'x', reason: 'oncall' });
  expect(result.isError).toBe(true);
  expect((result.content[0] as { text: string }).text).toContain('GATEWAY_AGENT_ID');
  // Nothing should have been written to the vault.
  expect(fs.existsSync(path.join(vaultDir, 'notes'))).toBe(false);
});

test('memory_shared_delete: fails closed when GATEWAY_AGENT_ID is unset', async () => {
  delete process.env.GATEWAY_AGENT_ID;
  const mod = new MemoryModule();
  const result = await mod.handleTool('memory_shared_delete', { reason: 'oncall' });
  expect(result.isError).toBe(true);
  expect((result.content[0] as { text: string }).text).toContain('GATEWAY_AGENT_ID');
});

test('memory_shared_write: succeeds normally when GATEWAY_AGENT_ID is set', async () => {
  const mod = new MemoryModule();
  const result = await mod.handleTool('memory_shared_write', { content: 'escalate to SRE', reason: 'oncall' });
  expect(result.isError).toBeUndefined();
  const body = JSON.parse((result.content[0] as { text: string }).text);
  expect(body.written).toBe(true);
});

// claude-gateway#381: the tool descriptions must disclose the actual on-disk
// filename BEFORE a caller writes, not just leave it discoverable from the
// returned `path` after the fact — the agentId prefix is load-bearing for
// memory_shared_delete's ownership scoping (see archive-writer.ts's
// sharedNoteSlug) and was previously undocumented.
test('memory_shared_write description discloses the <agentId>-<reason>.md filename scheme', () => {
  const mod = new MemoryModule();
  const tool = mod.getTools().find((t) => t.name === 'memory_shared_write');
  expect(tool?.description).toContain('<your-agent-id>-<reason>.md');
});

test('memory_shared_delete description cross-references the same filename scheme', () => {
  const mod = new MemoryModule();
  const tool = mod.getTools().find((t) => t.name === 'memory_shared_delete');
  expect(tool?.description).toContain('<your-agent-id>-<reason>.md');
});
