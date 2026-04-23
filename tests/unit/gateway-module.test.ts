import { GatewayModule } from '../../mcp/tools/gateway/module';
import { spawn } from 'child_process';

jest.mock('child_process', () => ({
  spawn: jest.fn().mockReturnValue({ unref: jest.fn(), pid: 12345 }),
}));

const mockSpawn = spawn as jest.Mock;

describe('GatewayModule', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    mockSpawn.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('isEnabled', () => {
    it('always returns true', () => {
      const mod = new GatewayModule();
      expect(mod.isEnabled()).toBe(true);
    });
  });

  describe('properties', () => {
    it('has correct id and visibility', () => {
      const mod = new GatewayModule();
      expect(mod.id).toBe('gateway');
      expect(mod.toolVisibility).toBe('all-configured');
    });
  });

  describe('getTools', () => {
    it('returns exactly one tool named gateway_restart', () => {
      const mod = new GatewayModule();
      const tools = mod.getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('gateway_restart');
    });

    it('requires notify_target_id in schema', () => {
      const mod = new GatewayModule();
      const schema = mod.getTools()[0].inputSchema as any;
      expect(schema.required).toContain('notify_target_id');
    });

    it('has notify_target_id and reason as optional additional property', () => {
      const mod = new GatewayModule();
      const schema = mod.getTools()[0].inputSchema as any;
      expect(schema.properties).toHaveProperty('notify_target_id');
      expect(schema.properties).toHaveProperty('reason');
    });
  });

  describe('handleTool', () => {
    it('returns error for unknown tool name', async () => {
      const mod = new GatewayModule();
      const result = await mod.handleTool('unknown_tool', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('unknown tool');
    });

    it('gateway_restart resolves immediately with restart message', async () => {
      const mod = new GatewayModule();
      const result = await mod.handleTool('gateway_restart', {
        notify_target_id: 'PLACEHOLDER_CHAT_ID',
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text.toLowerCase()).toMatch(/restart/);
    });

    it('spawns worker with detached:true', async () => {
      const mod = new GatewayModule();
      await mod.handleTool('gateway_restart', { notify_target_id: 'PLACEHOLDER_CHAT_ID' });
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const spawnOptions = mockSpawn.mock.calls[0][2];
      expect(spawnOptions.detached).toBe(true);
    });

    it('calls unref() on spawned child', async () => {
      const mockChild = { unref: jest.fn(), pid: 42 };
      mockSpawn.mockReturnValueOnce(mockChild);

      const mod = new GatewayModule();
      await mod.handleTool('gateway_restart', { notify_target_id: 'PLACEHOLDER_CHAT_ID' });
      expect(mockChild.unref).toHaveBeenCalledTimes(1);
    });

    it('passes RESTART_ORIGIN_CHANNEL from GATEWAY_ORIGIN_CHANNEL env', async () => {
      process.env.GATEWAY_ORIGIN_CHANNEL = 'telegram';
      const mod = new GatewayModule();
      await mod.handleTool('gateway_restart', { notify_target_id: 'PLACEHOLDER_CHAT_ID' });

      const spawnEnv = mockSpawn.mock.calls[0][2].env;
      expect(spawnEnv.RESTART_ORIGIN_CHANNEL).toBe('telegram');
    });

    it('passes TELEGRAM_BOT_TOKEN when channel is telegram', async () => {
      process.env.GATEWAY_ORIGIN_CHANNEL = 'telegram';
      process.env.TELEGRAM_BOT_TOKEN = 'tg-token-placeholder';
      const mod = new GatewayModule();
      await mod.handleTool('gateway_restart', { notify_target_id: 'PLACEHOLDER_CHAT_ID' });

      const spawnEnv = mockSpawn.mock.calls[0][2].env;
      expect(spawnEnv.RESTART_NOTIFY_BOT_TOKEN).toBe('tg-token-placeholder');
    });

    it('passes DISCORD_BOT_TOKEN when channel is discord', async () => {
      process.env.GATEWAY_ORIGIN_CHANNEL = 'discord';
      process.env.DISCORD_BOT_TOKEN = 'discord-token-placeholder';
      const mod = new GatewayModule();
      await mod.handleTool('gateway_restart', { notify_target_id: 'PLACEHOLDER_CHANNEL_ID' });

      const spawnEnv = mockSpawn.mock.calls[0][2].env;
      expect(spawnEnv.RESTART_NOTIFY_BOT_TOKEN).toBe('discord-token-placeholder');
    });

    it('passes RESTART_NOTIFY_TARGET_ID from notify_target_id arg', async () => {
      const mod = new GatewayModule();
      await mod.handleTool('gateway_restart', { notify_target_id: 'TARGET_ID_PLACEHOLDER' });

      const spawnEnv = mockSpawn.mock.calls[0][2].env;
      expect(spawnEnv.RESTART_NOTIFY_TARGET_ID).toBe('TARGET_ID_PLACEHOLDER');
    });

    it('passes GATEWAY_ROOT as absolute path', async () => {
      const mod = new GatewayModule();
      await mod.handleTool('gateway_restart', { notify_target_id: 'PLACEHOLDER_CHAT_ID' });

      const spawnEnv = mockSpawn.mock.calls[0][2].env;
      expect(path.isAbsolute(spawnEnv.GATEWAY_ROOT)).toBe(true);
    });

    it('resolves in under 200ms', async () => {
      const mod = new GatewayModule();
      const start = Date.now();
      await mod.handleTool('gateway_restart', { notify_target_id: 'PLACEHOLDER_CHAT_ID' });
      expect(Date.now() - start).toBeLessThan(200);
    });
  });
});

import * as path from 'path';
