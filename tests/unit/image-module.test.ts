/**
 * Unit tests for the image MCP tool's endpoint resolution + https guard
 * (mcp/tools/image/module.ts). Config resolves in this order:
 *
 *   IMAGE_BASE_URL → ANTHROPIC_BASE_URL (env) → ~/.claude/settings.json's env block.
 *
 * The env vars let an operator point image at a separate endpoint; the settings.json
 * fallback covers the common case where the tool runs in an MCP subprocess that can't
 * inherit the CLI's config (Claude Code applies settings.json's `env` internally, not
 * to the OS environment). Two behaviors locked in:
 *
 *  1. baseUrl() resolves from the first source above that yields a value; absent all
 *     three ⇒ not configured ⇒ isEnabled() false. Env wins over settings.json.
 *  2. baseUrlIsSecure guard — the Bearer secret rides every call, so an http URL to a
 *     PUBLIC host is refused (isEnabled → false). https, or http to a local/internal
 *     host (a trusted hop like host.docker.internal in dev), is allowed.
 *
 * baseUrl()/settingsEnv() are private, so we assert their OBSERVABLE effect via
 * isEnabled(), driving it by the env / settings.json we set per test.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ImageModule } from '../../mcp/tools/image/module';

const ENV_KEYS = [
  'IMAGE_BASE_URL',
  'ANTHROPIC_BASE_URL',
  'IMAGE_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'IMAGE_DISABLED',
] as const;

describe('ImageModule.isEnabled() — endpoint resolution + https guard', () => {
  let cfgDir: string;
  let errSpy: jest.SpyInstance;
  const saved: Record<string, string | undefined> = {};
  const savedCfgDir = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    // Point the settings.json fallback at a temp config dir via CLAUDE_CONFIG_DIR
    // (real files — the os/fs builtins are non-configurable here, so they can't be spied).
    cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgcfg-'));
    process.env.CLAUDE_CONFIG_DIR = cfgDir;
    // isEnabled() logs to console.error the first time it refuses an insecure URL.
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

  // Write the `env` block of settings.json (the fallback source).
  const setSettings = (env: Record<string, string>) =>
    fs.writeFileSync(path.join(cfgDir, 'settings.json'), JSON.stringify({ env }));

  const enabled = () => new ImageModule().isEnabled();

  describe('env-based config', () => {
    test('https ANTHROPIC_BASE_URL env → enabled', () => {
      process.env.ANTHROPIC_BASE_URL = 'https://provider.example.com';
      process.env.ANTHROPIC_AUTH_TOKEN = 'proxy-secret';
      expect(enabled()).toBe(true);
    });

    test('IMAGE_BASE_URL env (separate image endpoint) → enabled', () => {
      process.env.IMAGE_BASE_URL = 'https://image.example.com';
      process.env.IMAGE_API_KEY = 'image-secret';
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

    test('IMAGE_DISABLED=true → disabled even with a valid https env URL', () => {
      process.env.ANTHROPIC_BASE_URL = 'https://provider.example.com';
      process.env.IMAGE_DISABLED = 'true';
      expect(enabled()).toBe(false);
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

    test('token stored under ANTHROPIC_AUTH_TOKEN in settings.json is accepted → enabled', () => {
      // A proxy deployment may carry the M2M secret under ANTHROPIC_AUTH_TOKEN (the same key
      // the env path uses) rather than CLAUDE_CODE_OAUTH_TOKEN — both must resolve the token.
      setSettings({ ANTHROPIC_BASE_URL: 'https://provider.example.com', ANTHROPIC_AUTH_TOKEN: 'proxy-secret' });
      expect(enabled()).toBe(true);
    });

    test('endpoint in settings.json but no token anywhere → disabled (no silent 401)', () => {
      // A resolvable https URL with no token must disable the tool cleanly rather than
      // advertise it and 401 on an empty Bearer at call time.
      setSettings({ ANTHROPIC_BASE_URL: 'https://provider.example.com' });
      expect(enabled()).toBe(false);
    });

    test('malformed settings.json → disabled (degrades, does not throw)', () => {
      fs.writeFileSync(path.join(cfgDir, 'settings.json'), '{ not valid json');
      expect(enabled()).toBe(false);
    });

    test('http to a local host (host.docker.internal) in settings.json → enabled (trusted hop)', () => {
      setSettings({ ANTHROPIC_BASE_URL: 'http://host.docker.internal:8080', CLAUDE_CODE_OAUTH_TOKEN: 'proxy-secret' });
      expect(enabled()).toBe(true);
    });

    test('http to localhost in settings.json → enabled (trusted hop)', () => {
      setSettings({ ANTHROPIC_BASE_URL: 'http://localhost:8080', CLAUDE_CODE_OAUTH_TOKEN: 'proxy-secret' });
      expect(enabled()).toBe(true);
    });

    test('http to a PUBLIC host in settings.json → disabled', () => {
      setSettings({ ANTHROPIC_BASE_URL: 'http://provider.example.com', CLAUDE_CODE_OAUTH_TOKEN: 'proxy-secret' });
      expect(enabled()).toBe(false);
      expect(errSpy).toHaveBeenCalled();
    });
  });

  describe('precedence: env overrides settings.json', () => {
    test('a valid https env URL wins over a public-http settings.json URL', () => {
      // settings.json alone (public http) ⇒ disabled…
      setSettings({ ANTHROPIC_BASE_URL: 'http://provider.example.com', CLAUDE_CODE_OAUTH_TOKEN: 'proxy-secret' });
      expect(enabled()).toBe(false);
      // …a valid https env URL points image elsewhere and enables it.
      process.env.IMAGE_BASE_URL = 'https://image.example.com';
      expect(new ImageModule().isEnabled()).toBe(true);
    });
  });
});
