import { DiscordModule } from '../../mcp/tools/discord/module';

describe('DiscordModule', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('isEnabled', () => {
    it('DM1: returns true when DISCORD_BOT_TOKEN is set', () => {
      process.env.DISCORD_BOT_TOKEN = 'test-token-123';
      const mod = new DiscordModule();
      expect(mod.isEnabled()).toBe(true);
    });

    it('DM2: returns false when DISCORD_BOT_TOKEN is not set', () => {
      delete process.env.DISCORD_BOT_TOKEN;
      const mod = new DiscordModule();
      expect(mod.isEnabled()).toBe(false);
    });
  });

  describe('getTools', () => {
    it('DM3: returns 5 discord-prefixed tools', () => {
      const mod = new DiscordModule();
      const tools = mod.getTools();
      expect(tools).toHaveLength(5);
      const names = tools.map(t => t.name);
      expect(names).toContain('discord_reply');
      expect(names).toContain('discord_react');
      expect(names).toContain('discord_edit_message');
      expect(names).toContain('discord_download_attachment');
      expect(names).toContain('discord_create_thread');
    });

    it('discord_reply has required schema fields', () => {
      const mod = new DiscordModule();
      const tools = mod.getTools();
      const reply = tools.find(t => t.name === 'discord_reply')!;
      const schema = reply.inputSchema as any;
      expect(schema.required).toContain('channel_id');
      expect(schema.required).toContain('text');
    });
  });

  describe('handleTool', () => {
    it('DM4: returns error when client is not initialized', async () => {
      const mod = new DiscordModule();
      const result = await mod.handleTool('discord_reply', {
        channel_id: 'test-channel',
        text: 'hello',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not initialized');
    });

    it('returns error for unknown tool name without init', async () => {
      const mod = new DiscordModule();
      const result = await mod.handleTool('discord_unknown', {});
      expect(result.isError).toBe(true);
    });
  });

  describe('properties', () => {
    it('DM5: has correct id and toolVisibility', () => {
      const mod = new DiscordModule();
      expect(mod.id).toBe('discord');
      expect(mod.toolVisibility).toBe('current-channel');
    });

    it('has correct capabilities', () => {
      const mod = new DiscordModule();
      expect(mod.capabilities.reactions).toBe(true);
      expect(mod.capabilities.editMessage).toBe(true);
      expect(mod.capabilities.fileAttachment).toBe(true);
      expect(mod.capabilities.threadReply).toBe(true);
      expect(mod.capabilities.maxMessageLength).toBe(2000);
      expect(mod.capabilities.markupFormat).toBe('markdown');
    });
  });
});
