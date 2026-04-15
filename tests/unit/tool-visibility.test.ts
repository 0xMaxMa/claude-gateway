import type { ChannelModule, ToolModule, McpToolDefinition, ToolVisibility, ChannelId } from '../../mcp/gateway/types';

type AnyModule = ChannelModule | ToolModule;

/**
 * Reimplementation of server.ts tool aggregation for unit testing.
 * This avoids needing to spawn the MCP server process.
 */
function aggregateVisibleTools(
  modules: AnyModule[],
  originChannel: string,
): McpToolDefinition[] {
  const visibleTools: McpToolDefinition[] = [];

  for (const mod of modules) {
    if (!mod.isEnabled()) continue;

    const visible =
      mod.toolVisibility === 'all-configured' ||
      mod.id === originChannel ||
      originChannel === '';

    if (!visible) continue;

    for (const tool of mod.getTools()) {
      visibleTools.push(tool);
    }
  }

  return visibleTools;
}

function createMockChannelModule(
  id: string,
  enabled: boolean,
  visibility: ToolVisibility,
  tools: McpToolDefinition[],
): AnyModule {
  return {
    id: id as ChannelId,
    toolVisibility: visibility,
    isEnabled: () => enabled,
    getTools: () => tools,
    handleTool: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    capabilities: {
      typingIndicator: false,
      reactions: false,
      editMessage: false,
      fileAttachment: false,
      threadReply: false,
      maxMessageLength: 4096,
      markupFormat: 'none' as const,
    },
    start: async () => {},
    getSnapshot: () => ({ accountId: id, running: false, configured: enabled }),
  };
}

function createMockToolModule(
  id: string,
  enabled: boolean,
  visibility: ToolVisibility,
  tools: McpToolDefinition[],
): AnyModule {
  return {
    id,
    toolVisibility: visibility,
    isEnabled: () => enabled,
    getTools: () => tools,
    handleTool: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
  };
}

const telegramTools: McpToolDefinition[] = [
  { name: 'telegram_reply', description: 'Reply on Telegram', inputSchema: { type: 'object' } },
  { name: 'telegram_react', description: 'React to message', inputSchema: { type: 'object' } },
  { name: 'telegram_edit_message', description: 'Edit message', inputSchema: { type: 'object' } },
  { name: 'telegram_download_attachment', description: 'Download attachment', inputSchema: { type: 'object' } },
];

const cronTools: McpToolDefinition[] = [
  { name: 'cron_list', description: 'List cron jobs', inputSchema: { type: 'object' } },
  { name: 'cron_create', description: 'Create cron job', inputSchema: { type: 'object' } },
];

describe('Tool Visibility', () => {
  // TV1: GATEWAY_ORIGIN_CHANNEL="telegram" → has telegram_* tools
  it('TV1: should include telegram tools when origin channel is telegram', () => {
    const modules: AnyModule[] = [
      createMockChannelModule('telegram', true, 'current-channel', telegramTools),
      createMockToolModule('cron', true, 'all-configured', cronTools),
    ];

    const tools = aggregateVisibleTools(modules, 'telegram');
    const names = tools.map(t => t.name);

    expect(names).toContain('telegram_reply');
    expect(names).toContain('telegram_react');
    expect(names).toContain('telegram_edit_message');
    expect(names).toContain('telegram_download_attachment');
  });

  // TV2: GATEWAY_ORIGIN_CHANNEL="telegram" → has cron_* (all-configured)
  it('TV2: should include cron tools regardless of origin channel', () => {
    const modules: AnyModule[] = [
      createMockChannelModule('telegram', true, 'current-channel', telegramTools),
      createMockToolModule('cron', true, 'all-configured', cronTools),
    ];

    const tools = aggregateVisibleTools(modules, 'telegram');
    const names = tools.map(t => t.name);

    expect(names).toContain('cron_list');
    expect(names).toContain('cron_create');
  });

  // TV3: GATEWAY_ORIGIN_CHANNEL="discord" → no telegram_* tools
  it('TV3: should exclude telegram tools when origin channel is discord', () => {
    const modules: AnyModule[] = [
      createMockChannelModule('telegram', true, 'current-channel', telegramTools),
      createMockToolModule('cron', true, 'all-configured', cronTools),
    ];

    const tools = aggregateVisibleTools(modules, 'discord');
    const names = tools.map(t => t.name);

    expect(names).not.toContain('telegram_reply');
    expect(names).not.toContain('telegram_react');
    // cron should still be present
    expect(names).toContain('cron_list');
  });

  // TV4: TELEGRAM_BOT_TOKEN not set → telegram module disabled, tools absent
  it('TV4: should exclude tools from disabled modules', () => {
    const modules: AnyModule[] = [
      createMockChannelModule('telegram', false, 'current-channel', telegramTools),
      createMockToolModule('cron', true, 'all-configured', cronTools),
    ];

    const tools = aggregateVisibleTools(modules, 'telegram');
    const names = tools.map(t => t.name);

    expect(names).not.toContain('telegram_reply');
    expect(names).toContain('cron_list');
  });

  // Additional: empty origin channel shows all enabled tools
  it('should show all tools when origin channel is empty', () => {
    const modules: AnyModule[] = [
      createMockChannelModule('telegram', true, 'current-channel', telegramTools),
      createMockToolModule('cron', true, 'all-configured', cronTools),
    ];

    const tools = aggregateVisibleTools(modules, '');
    const names = tools.map(t => t.name);

    expect(names).toContain('telegram_reply');
    expect(names).toContain('cron_list');
    expect(tools).toHaveLength(6);
  });
});
