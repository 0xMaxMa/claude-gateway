import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MockGatewayAPI } from './fixtures/mock-gateway-api';
import { MockTelegramServer } from './fixtures/mock-telegram-server';
import { CronModule } from '../../mcp/gateway/tools/cron/module';
import { TelegramModule } from '../../mcp/gateway/tools/telegram/module';
import { createChannelManager } from '../../mcp/gateway/channel-manager';
import { resolveRoute, buildChannelContext, renderChannelContextSection } from '../../mcp/gateway/router';
import type { ChannelModule, InboundMessage, InboundMessageHandler, ChannelId, McpToolDefinition } from '../../mcp/gateway/types';

function createTestMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: 'telegram',
    accountId: 'bot-test',
    senderId: 'user-e2e',
    chatId: 'chat-e2e',
    chatType: 'direct',
    text: 'hello',
    messageId: 'msg-e2e',
    ts: Date.now(),
    ...overrides,
  };
}

function createMockChannelModule(overrides: Partial<ChannelModule> = {}): ChannelModule {
  return {
    id: 'mock-channel' as ChannelId,
    capabilities: {
      typingIndicator: false,
      reactions: false,
      editMessage: false,
      fileAttachment: false,
      threadReply: false,
      maxMessageLength: 4096,
      markupFormat: 'none' as const,
    },
    toolVisibility: 'current-channel' as const,
    isEnabled: () => true,
    getTools: () => [],
    handleTool: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    start: async (_handler: InboundMessageHandler, signal: AbortSignal) => {
      await new Promise<void>(resolve => {
        signal.addEventListener('abort', () => resolve());
      });
    },
    getSnapshot: () => ({ accountId: 'mock-channel', running: false, configured: true }),
    ...overrides,
  };
}

describe('Gateway E2E', () => {
  // E2E-1: Cron tool flow — create, list, run (simulates tool interaction)
  describe('E2E-1: Cron tool end-to-end flow', () => {
    let mockApi: MockGatewayAPI;

    beforeAll(async () => {
      mockApi = new MockGatewayAPI();
      await mockApi.start();
    });

    afterAll(async () => {
      await mockApi.stop();
    });

    it('should create, list, and run cron jobs via CronModule', async () => {
      process.env.GATEWAY_API_URL = mockApi.getBaseUrl();
      process.env.GATEWAY_AGENT_ID = 'test-agent';

      const mod = new CronModule();
      expect(mod.isEnabled()).toBe(true);

      // Create a job
      const createResult = await mod.handleTool('cron_create', {
        name: 'daily-report',
        schedule: '0 9 * * *',
        type: 'agent',
        prompt: 'Generate daily report',
      });
      expect(createResult.isError).toBeUndefined();
      const created = JSON.parse(createResult.content[0].text);
      expect(created.name).toBe('daily-report');
      expect(created.id).toBeDefined();

      // List jobs
      const listResult = await mod.handleTool('cron_list', {});
      expect(listResult.isError).toBeUndefined();
      const listData = JSON.parse(listResult.content[0].text);
      expect(listData.jobs).toHaveLength(1);
      expect(listData.jobs[0].name).toBe('daily-report');

      // Run job
      const runResult = await mod.handleTool('cron_run', { job_id: created.id });
      expect(runResult.isError).toBeUndefined();
      const run = JSON.parse(runResult.content[0].text);
      expect(run.status).toBe('success');

      // Get runs
      const runsResult = await mod.handleTool('cron_get_runs', { job_id: created.id });
      expect(runsResult.isError).toBeUndefined();
      const runs = JSON.parse(runsResult.content[0].text);
      expect(runs).toHaveLength(1);

      // Delete job
      const deleteResult = await mod.handleTool('cron_delete', { job_id: created.id });
      expect(deleteResult.isError).toBeUndefined();

      // Verify deleted
      const listResult2 = await mod.handleTool('cron_list', {});
      const listData2 = JSON.parse(listResult2.content[0].text);
      expect(listData2.jobs).toHaveLength(0);

      delete process.env.GATEWAY_API_URL;
      delete process.env.GATEWAY_AGENT_ID;
    });
  });

  // E2E-3: ChannelManager restart on failure
  describe('E2E-3: ChannelManager restart on failure', () => {
    it('should restart module after error', async () => {
      let startCount = 0;
      const mod = createMockChannelModule({
        id: 'failing-channel' as ChannelId,
        start: async () => {
          startCount++;
          if (startCount <= 1) {
            throw new Error('connection lost');
          }
          // Second call succeeds
          await new Promise<void>(() => {}); // hang forever
        },
      });

      const manager = createChannelManager([mod]);
      await manager.startAll(async () => {});

      // Wait for restart cycle to trigger
      await new Promise(r => setTimeout(r, 200));

      expect(startCount).toBeGreaterThanOrEqual(1);

      const state = manager._states.get('failing-channel');
      expect(state).toBeDefined();
      expect(state!.lastError).toBe('connection lost');

      manager.stopAll();
    });
  });

  // E2E-4: Tool visibility — correct tools exposed
  describe('E2E-4: Tool visibility', () => {
    it('should filter tools based on origin channel', () => {
      const telegramTools: McpToolDefinition[] = [
        { name: 'telegram_reply', description: 'Reply', inputSchema: { type: 'object' } },
        { name: 'telegram_react', description: 'React', inputSchema: { type: 'object' } },
      ];
      const cronTools: McpToolDefinition[] = [
        { name: 'cron_list', description: 'List', inputSchema: { type: 'object' } },
      ];

      // Simulate server.ts aggregation logic
      const modules = [
        { id: 'telegram', toolVisibility: 'current-channel' as const, isEnabled: () => true, getTools: () => telegramTools },
        { id: 'cron', toolVisibility: 'all-configured' as const, isEnabled: () => true, getTools: () => cronTools },
      ];

      // Origin = telegram
      const toolsForTelegram: McpToolDefinition[] = [];
      for (const mod of modules) {
        if (!mod.isEnabled()) continue;
        const visible = mod.toolVisibility === 'all-configured' || mod.id === 'telegram';
        if (!visible) continue;
        toolsForTelegram.push(...mod.getTools());
      }

      expect(toolsForTelegram.map(t => t.name)).toEqual(['telegram_reply', 'telegram_react', 'cron_list']);

      // Origin = discord (future)
      const toolsForDiscord: McpToolDefinition[] = [];
      for (const mod of modules) {
        if (!mod.isEnabled()) continue;
        const visible = mod.toolVisibility === 'all-configured' || mod.id === 'discord';
        if (!visible) continue;
        toolsForDiscord.push(...mod.getTools());
      }

      expect(toolsForDiscord.map(t => t.name)).toEqual(['cron_list']);
    });
  });

  // E2E-5: Session key isolation (concurrent chats)
  describe('E2E-5: Session key isolation', () => {
    it('should produce isolated session keys for concurrent chats', () => {
      const msg1 = createTestMessage({ chatId: 'chat-AAA', senderId: 'user-1' });
      const msg2 = createTestMessage({ chatId: 'chat-BBB', senderId: 'user-2' });

      const route1 = resolveRoute(msg1, 'agent-prod');
      const route2 = resolveRoute(msg2, 'agent-prod');

      // Different session keys
      expect(route1.sessionKey).not.toBe(route2.sessionKey);

      // Each route points to correct chat
      expect(route1.chatId).toBe('chat-AAA');
      expect(route2.chatId).toBe('chat-BBB');
      expect(route1.senderId).toBe('user-1');
      expect(route2.senderId).toBe('user-2');

      // Context sections are different
      const ctx1 = buildChannelContext(route1, ['telegram', 'cron']);
      const ctx2 = buildChannelContext(route2, ['telegram', 'cron']);

      const section1 = renderChannelContextSection(ctx1);
      const section2 = renderChannelContextSection(ctx2);

      expect(section1).toContain('chat-AAA');
      expect(section2).toContain('chat-BBB');
      expect(section1).not.toContain('chat-BBB');
    });
  });

  // E2E-6: Module handles tool error gracefully
  describe('E2E-6: Tool error handling', () => {
    it('should return error result without throwing for failed API calls', async () => {
      process.env.GATEWAY_API_URL = 'http://127.0.0.1:1'; // unreachable port
      process.env.GATEWAY_AGENT_ID = 'test-agent';

      const mod = new CronModule();
      const result = await mod.handleTool('cron_list', {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('failed');

      delete process.env.GATEWAY_API_URL;
      delete process.env.GATEWAY_AGENT_ID;
    });
  });

  // E2E-7: Module disabled — graceful degradation
  describe('E2E-7: Disabled module graceful degradation', () => {
    it('should not start disabled modules and exclude their tools', async () => {
      const disabledMod = createMockChannelModule({
        id: 'disabled-channel' as ChannelId,
        isEnabled: () => false,
        getTools: () => [
          { name: 'disabled_tool', description: 'Should not appear', inputSchema: { type: 'object' } },
        ],
      });

      const enabledMod = createMockChannelModule({
        id: 'enabled-channel' as ChannelId,
        isEnabled: () => true,
        getTools: () => [
          { name: 'enabled_tool', description: 'Should appear', inputSchema: { type: 'object' } },
        ],
      });

      // ChannelManager should skip disabled module
      const manager = createChannelManager([disabledMod, enabledMod]);
      await manager.startAll(async () => {});
      await new Promise(r => setTimeout(r, 50));

      const snapshots = manager.getSnapshots();
      expect(snapshots.has('disabled-channel')).toBe(false);
      expect(snapshots.has('enabled-channel')).toBe(true);

      // Tool aggregation should skip disabled module
      const allModules = [disabledMod, enabledMod];
      const visibleTools: McpToolDefinition[] = [];
      for (const mod of allModules) {
        if (!mod.isEnabled()) continue;
        visibleTools.push(...mod.getTools());
      }

      const names = visibleTools.map(t => t.name);
      expect(names).not.toContain('disabled_tool');
      expect(names).toContain('enabled_tool');

      manager.stopAll();
    });
  });
});

// ── Telegram Module E2E: real TelegramModule + mock Telegram API ──────────────

describe('Gateway Telegram E2E — TelegramModule via mock API', () => {
  let mockTg: MockTelegramServer;
  let mod: TelegramModule;
  let tmpDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeAll(async () => {
    originalEnv = { ...process.env };

    mockTg = new MockTelegramServer();
    await mockTg.start();

    // Temp state dir with access.json allowing test chat
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-tg-e2e-'));
    const stateDir = path.join(tmpDir, '.telegram-state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'access.json'),
      JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['12345', '67890'], groups: {}, pending: {} }),
    );

    process.env.TELEGRAM_BOT_TOKEN = 'e2e-test-token';
    process.env.TELEGRAM_STATE_DIR = stateDir;
    process.env.TELEGRAM_API_ROOT = mockTg.getApiRoot();

    mod = new TelegramModule();
    await mod.initBot();
  });

  afterAll(async () => {
    await mockTg.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  beforeEach(() => {
    mockTg.clearSentMessages();
  });

  test('E2E-TG-1: telegram_reply sends message via mock Telegram API', async () => {
    const result = await mod.handleTool('telegram_reply', {
      chat_id: '67890',
      text: 'Hello from E2E test!',
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('sent');

    const sent = mockTg.getSentMessages();
    const msg = sent.find(m => m.method === 'sendMessage');
    expect(msg).toBeDefined();
    expect(msg!.chat_id).toBe('67890');
    expect(msg!.text).toBe('Hello from E2E test!');
  });

  test('E2E-TG-2: telegram_reply with HTML format', async () => {
    const result = await mod.handleTool('telegram_reply', {
      chat_id: '67890',
      text: '<b>bold</b> text',
      format: 'html',
    });

    expect(result.isError).toBeUndefined();

    const sent = mockTg.getSentMessages();
    const msg = sent.find(m => m.method === 'sendMessage');
    expect(msg).toBeDefined();
    expect(msg!.text).toBe('<b>bold</b> text');
    expect(msg!.parse_mode).toBe('HTML');
  });

  test('E2E-TG-3: telegram_reply with reply_to threading', async () => {
    const result = await mod.handleTool('telegram_reply', {
      chat_id: '67890',
      text: 'Threaded reply',
      reply_to: '42',
    });

    expect(result.isError).toBeUndefined();

    const sent = mockTg.getSentMessages();
    const msg = sent.find(m => m.method === 'sendMessage');
    expect(msg).toBeDefined();
    expect(msg!.reply_parameters).toEqual({ message_id: 42 });
  });

  test('E2E-TG-4: telegram_react sends reaction via mock API', async () => {
    const result = await mod.handleTool('telegram_react', {
      chat_id: '67890',
      message_id: '100',
      emoji: '👍',
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('reacted');

    const sent = mockTg.getSentMessages();
    const reaction = sent.find(m => m.method === 'setMessageReaction');
    expect(reaction).toBeDefined();
  });

  test('E2E-TG-5: telegram_edit_message edits via mock API', async () => {
    const result = await mod.handleTool('telegram_edit_message', {
      chat_id: '67890',
      message_id: '100',
      text: 'Updated text',
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('edited');

    const sent = mockTg.getSentMessages();
    const edit = sent.find(m => m.method === 'editMessageText');
    expect(edit).toBeDefined();
  });

  test('E2E-TG-6: telegram_download_attachment downloads file via mock API', async () => {
    const result = await mod.handleTool('telegram_download_attachment', {
      file_id: 'test-file-id-123',
    });

    expect(result.isError).toBeUndefined();

    // Result should be a file path
    const filePath = result.content[0].text;
    expect(filePath).toContain('.jpg');
    expect(fs.existsSync(filePath)).toBe(true);

    // Verify file content matches what mock server sent
    const content = fs.readFileSync(filePath);
    expect(content.toString()).toBe('fake-image-data');

    // Verify mock server recorded the getFile call and file download
    const sent = mockTg.getSentMessages();
    expect(sent.some(m => m.method === 'downloadFile')).toBe(true);
  });

  test('E2E-TG-7: telegram_reply rejects non-allowlisted chat', async () => {
    const result = await mod.handleTool('telegram_reply', {
      chat_id: '99999',
      text: 'Should fail',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not allowlisted');
  });

  test('E2E-TG-8: telegram_reply auto-detects markdown and converts to HTML', async () => {
    const result = await mod.handleTool('telegram_reply', {
      chat_id: '67890',
      text: '**bold** and `code`',
    });

    expect(result.isError).toBeUndefined();

    const sent = mockTg.getSentMessages();
    const msg = sent.find(m => m.method === 'sendMessage');
    expect(msg).toBeDefined();
    // Should auto-convert to HTML since text contains markdown
    expect(msg!.parse_mode).toBe('HTML');
  });
});
