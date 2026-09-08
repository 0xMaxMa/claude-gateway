/**
 * Unit tests for the video MCP tool's endpoint resolution + https guard
 * (mcp/tools/video/module.ts). Mirrors image-module.test.ts — config resolves in
 * this order:
 *
 *   VIDEO_BASE_URL → IMAGE_BASE_URL → ANTHROPIC_BASE_URL (env) → ~/.claude/settings.json's env block.
 *
 * Video shares the getpod api with the image tool, so its resolution is the same
 * with a VIDEO_* override on top. Two behaviors locked in:
 *
 *  1. baseUrl() resolves from the first source above that yields a value; absent all
 *     ⇒ not configured ⇒ isEnabled() false. Env wins over settings.json, and the
 *     VIDEO_* override wins over the shared IMAGE_/ANTHROPIC_ vars.
 *  2. baseUrlIsSecure guard — the Bearer secret rides every call, so an http URL to a
 *     PUBLIC host is refused. https, or http to a local/internal host, is allowed.
 *
 * baseUrl()/settingsEnv() are private, so we assert their OBSERVABLE effect via
 * isEnabled(), driving it by the env / settings.json we set per test.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VideoModule } from '../../mcp/tools/video/module';

const ENV_KEYS = [
  'VIDEO_BASE_URL',
  'IMAGE_BASE_URL',
  'ANTHROPIC_BASE_URL',
  'VIDEO_API_KEY',
  'IMAGE_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'VIDEO_DISABLED',
] as const;

describe('VideoModule.isEnabled() — endpoint resolution + https guard', () => {
  let cfgDir: string;
  let errSpy: jest.SpyInstance;
  const saved: Record<string, string | undefined> = {};
  const savedCfgDir = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidcfg-'));
    process.env.CLAUDE_CONFIG_DIR = cfgDir;
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
    fs.rmSync(cfgDir, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (savedCfgDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedCfgDir;
  });

  const setSettings = (env: Record<string, string>) =>
    fs.writeFileSync(path.join(cfgDir, 'settings.json'), JSON.stringify({ env }));

  const enabled = () => new VideoModule().isEnabled();

  describe('env-based config', () => {
    test('https ANTHROPIC_BASE_URL env (shared with image) → enabled', () => {
      process.env.ANTHROPIC_BASE_URL = 'https://provider.example.com';
      process.env.ANTHROPIC_AUTH_TOKEN = 'proxy-secret';
      expect(enabled()).toBe(true);
    });

    test('VIDEO_BASE_URL env (separate video endpoint) → enabled', () => {
      process.env.VIDEO_BASE_URL = 'https://video.example.com';
      process.env.VIDEO_API_KEY = 'video-secret';
      expect(enabled()).toBe(true);
    });

    test('no env and no settings.json → disabled (nothing configured)', () => {
      expect(enabled()).toBe(false);
    });

    test('http to a PUBLIC host env → disabled (refuses Bearer secret in cleartext)', () => {
      process.env.ANTHROPIC_BASE_URL = 'http://provider.example.com';
      process.env.ANTHROPIC_AUTH_TOKEN = 'proxy-secret';
      expect(enabled()).toBe(false);
      expect(errSpy).toHaveBeenCalled();
    });

    test('VIDEO_DISABLED=true → disabled even with a valid https env URL', () => {
      process.env.ANTHROPIC_BASE_URL = 'https://provider.example.com';
      process.env.VIDEO_DISABLED = 'true';
      expect(enabled()).toBe(false);
    });

    test('http to a local host (host.docker.internal) → enabled (trusted hop)', () => {
      process.env.VIDEO_BASE_URL = 'http://host.docker.internal:8080';
      process.env.VIDEO_API_KEY = 'video-secret';
      expect(enabled()).toBe(true);
    });
  });

  describe('settings.json fallback (no env)', () => {
    test('https ANTHROPIC_BASE_URL in settings.json → enabled', () => {
      setSettings({ ANTHROPIC_BASE_URL: 'https://provider.example.com', CLAUDE_CODE_OAUTH_TOKEN: 'proxy-secret' });
      expect(enabled()).toBe(true);
    });

    test('settings.json without ANTHROPIC_BASE_URL → disabled (no endpoint)', () => {
      setSettings({ CLAUDE_CODE_OAUTH_TOKEN: 'proxy-secret' });
      expect(enabled()).toBe(false);
    });

    test('malformed settings.json → disabled (degrades, does not throw)', () => {
      fs.writeFileSync(path.join(cfgDir, 'settings.json'), '{ not valid json');
      expect(enabled()).toBe(false);
    });

    test('http to a PUBLIC host in settings.json → disabled', () => {
      setSettings({ ANTHROPIC_BASE_URL: 'http://provider.example.com', CLAUDE_CODE_OAUTH_TOKEN: 'proxy-secret' });
      expect(enabled()).toBe(false);
      expect(errSpy).toHaveBeenCalled();
    });
  });

  describe('precedence: VIDEO_* overrides the shared vars', () => {
    test('a valid https VIDEO_BASE_URL wins over a public-http ANTHROPIC_BASE_URL', () => {
      process.env.ANTHROPIC_BASE_URL = 'http://provider.example.com'; // public http ⇒ would disable
      expect(enabled()).toBe(false);
      process.env.VIDEO_BASE_URL = 'https://video.example.com';
      expect(new VideoModule().isEnabled()).toBe(true);
    });
  });

  describe('tool surface', () => {
    test('exposes exactly the generate_video tool with the four actions', () => {
      const tools = new VideoModule().getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe('generate_video');
      const schema = tools[0]!.inputSchema as { properties: { action: { enum: string[] } } };
      expect(schema.properties.action.enum).toEqual(['generate', 'status', 'list', 'list_refs']);
    });

    test('rejects an unknown tool name', async () => {
      const res = await new VideoModule().handleTool('generate_image', {});
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain('Unknown tool');
    });

    test('generate without a prompt is a validation error (no network)', async () => {
      const res = await new VideoModule().handleTool('generate_video', { action: 'generate', model: 'grok-video/grok-imagine' });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text.toLowerCase()).toContain('prompt');
    });

    test('generate without a model is a validation error (no network)', async () => {
      const res = await new VideoModule().handleTool('generate_video', { action: 'generate', prompt: 'a cat surfing' });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain('"model" is required');
    });

    test('status without a task_id is a validation error (no network)', async () => {
      const res = await new VideoModule().handleTool('generate_video', { action: 'status' });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain('task_id');
    });

    test('an unknown action is rejected', async () => {
      const res = await new VideoModule().handleTool('generate_video', { action: 'frobnicate' });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain('unknown action');
    });
  });
});
