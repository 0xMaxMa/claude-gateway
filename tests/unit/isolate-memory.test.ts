/**
 * Isolated memory mode (#601): one agent serving many unrelated senders
 * must not inject one sender's USER.md/MEMORY.md into another sender's session.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadWorkspace,
  composeChatMemory,
  chatMemoryDir,
  chatMemoryDirName,
} from '../../src/agent/workspace-loader';

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-ws-'));
  fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# Agent: shared-bot\nShared operator instructions.');
  fs.writeFileSync(path.join(workspace, 'SOUL.md'), 'Warm and concise tone.');
  // Written before isolate mode was enabled: a mix of every sender's data.
  fs.writeFileSync(path.join(workspace, 'MEMORY.md'), 'ROOT-MEMORY: Alice owes 300 baht.');
  fs.writeFileSync(path.join(workspace, 'USER.md'), 'ROOT-USER: Alice prefers Thai.');
});

afterEach(() => fs.rmSync(workspace, { recursive: true, force: true }));

function writeChatMemory(channel: string, chatId: string, user: string, memory: string): void {
  const dir = chatMemoryDir(workspace, channel, chatId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'USER.md'), user);
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), memory);
}

describe('loadWorkspace isolateMemory', () => {
  it('absent or false composes exactly the shared-memory prompt', async () => {
    const base = await loadWorkspace(workspace);
    expect((await loadWorkspace(workspace, { isolateMemory: false })).systemPrompt).toBe(base.systemPrompt);
    expect(base.systemPrompt).toContain('ROOT-MEMORY');
    expect(base.systemPrompt).toContain('ROOT-USER');
  });

  it('the shared prompt keeps operator files and leaves out every sender file', async () => {
    const { systemPrompt } = await loadWorkspace(workspace, { isolateMemory: true, coreShrink: true });
    expect(systemPrompt).toContain('Shared operator instructions.');
    expect(systemPrompt).toContain('Warm and concise tone.');
    expect(systemPrompt).not.toContain('ROOT-MEMORY');
    expect(systemPrompt).not.toContain('ROOT-USER');
    expect(systemPrompt).toContain('CHAT MEMORY');
    // memory_search is not offered in this mode, so nothing may point at it.
    expect(systemPrompt).not.toContain('memory_search');
    // The persona is shared by every sender, so no sender may rewrite it.
    expect(systemPrompt).toContain('Only the operator changes the persona');
    // The root files may still hold earlier senders' data, so reading them is forbidden too.
    expect(systemPrompt).toContain('NEVER read the workspace-root MEMORY.md/USER.md');
  });

  it('drops the write-routing addendum that routes notes to memory_search', async () => {
    const { systemPrompt } = await loadWorkspace(workspace, { isolateMemory: true, memoryBudget: { writeRouting: true } });
    expect(systemPrompt).not.toContain('Memory Tiers');
  });
});

describe('composeChatMemory', () => {
  it("never shows one conversation's memory to another", () => {
    writeChatMemory('telegram', '111', 'CHAT-A-USER', 'CHAT-A-MEMORY');
    writeChatMemory('telegram', '222', 'CHAT-B-USER', 'CHAT-B-MEMORY');
    const a = composeChatMemory(workspace, 'telegram', '111');
    const b = composeChatMemory(workspace, 'telegram', '222');
    expect(a).toContain('CHAT-A-USER');
    expect(a).toContain('CHAT-A-MEMORY');
    expect(a).not.toContain('CHAT-B');
    expect(b).toContain('CHAT-B-MEMORY');
    expect(b).not.toContain('CHAT-A');
    expect(a).toContain(path.join(chatMemoryDir(workspace, 'telegram', '111'), 'MEMORY.md'));
  });

  it('a brand-new conversation starts empty instead of inheriting the root files', () => {
    const context = composeChatMemory(workspace, 'line', 'U-new');
    expect(context).toContain('--- USER PROFILE ---\n\n');
    expect(context).toContain('--- LONG-TERM MEMORY ---\n');
    expect(context).not.toContain('ROOT-');
  });

  it('separates the same chatId on different channels', () => {
    writeChatMemory('telegram', '42', 'TG-USER', 'TG-MEMORY');
    expect(composeChatMemory(workspace, 'discord', '42')).not.toContain('TG-');
  });

  it('names the files where the agent sees them: an app agent sees the workspace at /workspace', () => {
    writeChatMemory('telegram', '111', 'CHAT-A-USER', 'CHAT-A-MEMORY');
    const context = composeChatMemory(workspace, 'telegram', '111', undefined, '/workspace');
    expect(context).toContain('CHAT-A-MEMORY');
    expect(context).toContain(`- /workspace/chats/${chatMemoryDirName('telegram', '111')}/USER.md`);
    expect(context).toContain(`- /workspace/chats/${chatMemoryDirName('telegram', '111')}/MEMORY.md`);
    expect(context).not.toContain(workspace);
  });

  it("applies the memory budget banner to the conversation's files", () => {
    writeChatMemory('telegram', '1', '', 'x'.repeat(50));
    const context = composeChatMemory(workspace, 'telegram', '1', { memoryBudgetChars: 10 });
    // The banner must name the conversation's file, not the shared root MEMORY.md.
    expect(context).toContain(`${path.join('chats', chatMemoryDirName('telegram', '1'), 'MEMORY.md')} OVER BUDGET`);
  });
});

describe('chatMemoryDirName', () => {
  it('keeps ordinary ids readable', () => {
    expect(chatMemoryDirName('telegram', '-1001234')).toMatch(/^telegram--1001234-[0-9a-f]{16}$/);
  });

  it("a chosen chatId cannot reproduce another key's directory", () => {
    const victim = chatMemoryDirName('api', 'x.');
    expect(chatMemoryDirName('api', victim.slice('api-'.length))).not.toBe(victim);
  });

  it('cannot escape chats/ and keeps distinct keys distinct', () => {
    const escaped = chatMemoryDir(workspace, 'api', '../../etc');
    expect(path.dirname(escaped)).toBe(path.join(workspace, 'chats'));
    expect(chatMemoryDirName('api', 'a/b')).not.toBe(chatMemoryDirName('api', 'a_b'));
    expect(chatMemoryDirName('api', 'a/b')).not.toBe(chatMemoryDirName('api', 'a:b'));
  });
});
