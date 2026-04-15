import { TelegramModule } from '../../mcp/gateway/tools/telegram/module';

describe('TelegramModule', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('isEnabled', () => {
    it('should return true when TELEGRAM_BOT_TOKEN is set', () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token-123';
      const mod = new TelegramModule();
      expect(mod.isEnabled()).toBe(true);
    });

    it('should return false when TELEGRAM_BOT_TOKEN is not set', () => {
      delete process.env.TELEGRAM_BOT_TOKEN;
      // Point state dir to nonexistent path to prevent .env fallback
      process.env.TELEGRAM_STATE_DIR = '/tmp/nonexistent-telegram-state-dir';
      const mod = new TelegramModule();
      expect(mod.isEnabled()).toBe(false);
    });
  });

  describe('getTools', () => {
    it('should return 4 telegram-prefixed tools', () => {
      const mod = new TelegramModule();
      const tools = mod.getTools();

      expect(tools).toHaveLength(4);

      const names = tools.map(t => t.name);
      expect(names).toContain('telegram_reply');
      expect(names).toContain('telegram_react');
      expect(names).toContain('telegram_edit_message');
      expect(names).toContain('telegram_download_attachment');
    });

    it('TM1: telegram_reply tool has required schema fields', () => {
      const mod = new TelegramModule();
      const tools = mod.getTools();
      const reply = tools.find(t => t.name === 'telegram_reply')!;

      expect(reply.inputSchema).toBeDefined();
      const schema = reply.inputSchema as any;
      expect(schema.required).toContain('chat_id');
      expect(schema.required).toContain('text');
      expect(schema.properties.files).toBeDefined();
      expect(schema.properties.format).toBeDefined();
    });

    it('TM2: telegram_react tool has required schema fields', () => {
      const mod = new TelegramModule();
      const tools = mod.getTools();
      const react = tools.find(t => t.name === 'telegram_react')!;

      const schema = react.inputSchema as any;
      expect(schema.required).toContain('chat_id');
      expect(schema.required).toContain('message_id');
      expect(schema.required).toContain('emoji');
    });

    it('TM3: telegram_edit_message tool has required schema fields', () => {
      const mod = new TelegramModule();
      const tools = mod.getTools();
      const edit = tools.find(t => t.name === 'telegram_edit_message')!;

      const schema = edit.inputSchema as any;
      expect(schema.required).toContain('chat_id');
      expect(schema.required).toContain('message_id');
      expect(schema.required).toContain('text');
    });
  });

  describe('handleTool', () => {
    // TM4: tool call without bot initialization → error, no throw
    it('TM4: should return error when bot is not initialized', async () => {
      const mod = new TelegramModule();

      const result = await mod.handleTool('telegram_reply', {
        chat_id: 'test-chat',
        text: 'hello',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not initialized');
    });

    it('should return error for unknown tool name', async () => {
      const mod = new TelegramModule();

      const result = await mod.handleTool('telegram_unknown', {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not initialized');
    });
  });

  describe('properties', () => {
    it('should have correct id and visibility', () => {
      const mod = new TelegramModule();
      expect(mod.id).toBe('telegram');
      expect(mod.toolVisibility).toBe('current-channel');
    });

    it('should have correct capabilities', () => {
      const mod = new TelegramModule();
      expect(mod.capabilities.typingIndicator).toBe(true);
      expect(mod.capabilities.reactions).toBe(true);
      expect(mod.capabilities.editMessage).toBe(true);
      expect(mod.capabilities.fileAttachment).toBe(true);
      expect(mod.capabilities.threadReply).toBe(true);
      expect(mod.capabilities.maxMessageLength).toBe(4096);
      expect(mod.capabilities.markupFormat).toBe('html');
    });
  });
});
