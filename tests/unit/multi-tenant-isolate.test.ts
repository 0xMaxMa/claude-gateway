/**
 * Multi-tenant isolate mode (#601): one agent serving many unrelated senders
 * must not inject one sender's USER.md/MEMORY.md into another sender's session.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadWorkspace,
  composeTenantContext,
  tenantDir,
  tenantDirName,
} from '../../src/agent/workspace-loader';

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-ws-'));
  fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# Agent: shared-bot\nShared operator instructions.');
  fs.writeFileSync(path.join(workspace, 'SOUL.md'), 'Warm and concise tone.');
  // Written before isolate mode was enabled: a mix of every sender's data.
  fs.writeFileSync(path.join(workspace, 'MEMORY.md'), 'ROOT-MEMORY: Alice owes 300 baht.');
  fs.writeFileSync(path.join(workspace, 'USER.md'), 'ROOT-USER: Alice prefers Thai.');
});

afterEach(() => fs.rmSync(workspace, { recursive: true, force: true }));

function writeTenant(channel: string, chatId: string, user: string, memory: string): void {
  const dir = tenantDir(workspace, channel, chatId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'USER.md'), user);
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), memory);
}

describe('loadWorkspace multiTenant', () => {
  it('absent or false composes exactly the single-tenant prompt', async () => {
    const base = await loadWorkspace(workspace);
    expect((await loadWorkspace(workspace, { multiTenant: false })).systemPrompt).toBe(base.systemPrompt);
    expect(base.systemPrompt).toContain('ROOT-MEMORY');
    expect(base.systemPrompt).toContain('ROOT-USER');
  });

  it('the shared prompt keeps operator files and leaves out every sender file', async () => {
    const { systemPrompt } = await loadWorkspace(workspace, { multiTenant: true, coreShrink: true });
    expect(systemPrompt).toContain('Shared operator instructions.');
    expect(systemPrompt).toContain('Warm and concise tone.');
    expect(systemPrompt).not.toContain('ROOT-MEMORY');
    expect(systemPrompt).not.toContain('ROOT-USER');
    expect(systemPrompt).toContain('TENANT CONTEXT');
    // memory_search is not offered in this mode, so nothing may point at it.
    expect(systemPrompt).not.toContain('memory_search');
    // The persona is shared by every sender, so no sender may rewrite it.
    expect(systemPrompt).toContain('Only the operator changes the persona');
    // The root files may still hold earlier senders' data, so reading them is forbidden too.
    expect(systemPrompt).toContain('NEVER read the workspace-root MEMORY.md/USER.md');
  });

  it('drops the write-routing addendum that routes notes to memory_search', async () => {
    const { systemPrompt } = await loadWorkspace(workspace, { multiTenant: true, memoryBudget: { writeRouting: true } });
    expect(systemPrompt).not.toContain('Memory Tiers');
  });
});

describe('composeTenantContext', () => {
  it("never shows one tenant's memory to another", () => {
    writeTenant('telegram', '111', 'TENANT-A-USER', 'TENANT-A-MEMORY');
    writeTenant('telegram', '222', 'TENANT-B-USER', 'TENANT-B-MEMORY');
    const a = composeTenantContext(workspace, 'telegram', '111');
    const b = composeTenantContext(workspace, 'telegram', '222');
    expect(a).toContain('TENANT-A-USER');
    expect(a).toContain('TENANT-A-MEMORY');
    expect(a).not.toContain('TENANT-B');
    expect(b).toContain('TENANT-B-MEMORY');
    expect(b).not.toContain('TENANT-A');
    expect(a).toContain(path.join(tenantDir(workspace, 'telegram', '111'), 'MEMORY.md'));
  });

  it('a brand-new tenant starts empty instead of inheriting the root files', () => {
    const context = composeTenantContext(workspace, 'line', 'U-new');
    expect(context).toContain('--- USER PROFILE ---\n\n');
    expect(context).toContain('--- LONG-TERM MEMORY ---\n');
    expect(context).not.toContain('ROOT-');
  });

  it('separates the same chatId on different channels', () => {
    writeTenant('telegram', '42', 'TG-USER', 'TG-MEMORY');
    expect(composeTenantContext(workspace, 'discord', '42')).not.toContain('TG-');
  });

  it('applies the memory budget banner to tenant files', () => {
    writeTenant('telegram', '1', '', 'x'.repeat(50));
    const context = composeTenantContext(workspace, 'telegram', '1', { memoryBudgetChars: 10 });
    // The banner must name the tenant's file, not the shared root MEMORY.md.
    expect(context).toContain(`${path.join('tenants', tenantDirName('telegram', '1'), 'MEMORY.md')} OVER BUDGET`);
  });
});

describe('tenantDirName', () => {
  it('keeps ordinary ids readable', () => {
    expect(tenantDirName('telegram', '-1001234')).toMatch(/^telegram--1001234-[0-9a-f]{16}$/);
  });

  it("a chosen chatId cannot reproduce another key's directory", () => {
    const victim = tenantDirName('api', 'x.');
    expect(tenantDirName('api', victim.slice('api-'.length))).not.toBe(victim);
  });

  it('cannot escape tenants/ and keeps distinct keys distinct', () => {
    const escaped = tenantDir(workspace, 'api', '../../etc');
    expect(path.dirname(escaped)).toBe(path.join(workspace, 'tenants'));
    expect(tenantDirName('api', 'a/b')).not.toBe(tenantDirName('api', 'a_b'));
    expect(tenantDirName('api', 'a/b')).not.toBe(tenantDirName('api', 'a:b'));
  });
});
