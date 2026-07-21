/**
 * Unit tests for the image MCP tool's endpoint resolution + https guard
 * (mcp/tools/image/module.ts). Config comes from ONE place — the Claude Code CLI
 * config at ~/.claude/settings.json (its `env` block carries ANTHROPIC_BASE_URL +
 * CLAUDE_CODE_OAUTH_TOKEN). The CLI applies that block internally, not to the OS
 * environment, so this MCP process reads the file directly. Two behaviors locked in:
 *
 *  1. baseUrl() resolves from settings.json's env.ANTHROPIC_BASE_URL — absent file /
 *     key ⇒ not configured ⇒ isEnabled() false.
 *  2. baseUrlIsSecure guard — the Bearer secret rides every call, so an http URL to
 *     a PUBLIC host is refused (isEnabled → false). https, or http to a
 *     local/internal host (a trusted hop like host.docker.internal in dev), is allowed.
 *
 * baseUrl()/settingsEnv() are private, so we assert their OBSERVABLE effect via
 * isEnabled(), driving it purely by the settings.json we write per test.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ImageModule } from '../../mcp/tools/image/module';

describe('ImageModule.isEnabled() — endpoint resolution + https guard (config from ~/.claude/settings.json)', () => {
  let cfgDir: string;
  let errSpy: jest.SpyInstance;
  const savedCfgDir = process.env.CLAUDE_CONFIG_DIR;
  const savedDisabled = process.env.IMAGE_DISABLED;

  beforeEach(() => {
    // Point the module at a temp config dir via CLAUDE_CONFIG_DIR (real files — the
    // os/fs builtins are non-configurable here, so they can't be spied).
    cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgcfg-'));
    process.env.CLAUDE_CONFIG_DIR = cfgDir;
    // isEnabled() logs to console.error the first time it refuses an insecure URL.
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.IMAGE_DISABLED;
  });

  afterEach(() => {
    errSpy.mockRestore();
    fs.rmSync(cfgDir, { recursive: true, force: true });
    if (savedCfgDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedCfgDir;
    if (savedDisabled === undefined) delete process.env.IMAGE_DISABLED;
    else process.env.IMAGE_DISABLED = savedDisabled;
  });

  // Write the `env` block of settings.json — the single source baseUrl()/authToken() read.
  const setSettings = (env: Record<string, string>) =>
    fs.writeFileSync(path.join(cfgDir, 'settings.json'), JSON.stringify({ env }));

  const enabled = () => new ImageModule().isEnabled();

  test('https ANTHROPIC_BASE_URL in settings.json → enabled', () => {
    setSettings({ ANTHROPIC_BASE_URL: 'https://provider.example.com', CLAUDE_CODE_OAUTH_TOKEN: 'proxy-secret' });
    expect(enabled()).toBe(true);
  });

  test('no settings.json file → disabled (nothing configured)', () => {
    expect(enabled()).toBe(false);
  });

  test('settings.json without ANTHROPIC_BASE_URL → disabled (no endpoint)', () => {
    setSettings({ CLAUDE_CODE_OAUTH_TOKEN: 'proxy-secret' });
    expect(enabled()).toBe(false);
  });

  test('malformed settings.json → disabled (degrades, does not throw)', () => {
    fs.writeFileSync(path.join(cfgDir, 'settings.json'), '{ not valid json');
    expect(enabled()).toBe(false);
  });

  test('http to a local host (host.docker.internal) → enabled (trusted hop)', () => {
    setSettings({ ANTHROPIC_BASE_URL: 'http://host.docker.internal:8080', CLAUDE_CODE_OAUTH_TOKEN: 'proxy-secret' });
    expect(enabled()).toBe(true);
  });

  test('http to localhost → enabled (trusted hop)', () => {
    setSettings({ ANTHROPIC_BASE_URL: 'http://localhost:8080', CLAUDE_CODE_OAUTH_TOKEN: 'proxy-secret' });
    expect(enabled()).toBe(true);
  });

  test('http to a PUBLIC host → disabled (refuses to send Bearer secret in cleartext)', () => {
    setSettings({ ANTHROPIC_BASE_URL: 'http://provider.example.com', CLAUDE_CODE_OAUTH_TOKEN: 'proxy-secret' });
    expect(enabled()).toBe(false);
    expect(errSpy).toHaveBeenCalled(); // the guard warns once
  });

  test('IMAGE_DISABLED=true → disabled even with a valid https URL', () => {
    setSettings({ ANTHROPIC_BASE_URL: 'https://provider.example.com', CLAUDE_CODE_OAUTH_TOKEN: 'proxy-secret' });
    process.env.IMAGE_DISABLED = 'true';
    expect(enabled()).toBe(false);
  });
});
