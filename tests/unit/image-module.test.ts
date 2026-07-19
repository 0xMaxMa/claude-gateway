/**
 * Unit tests for the image MCP tool's endpoint resolution + https guard
 * (mcp/tools/image/module.ts). Two recent changes are locked in here:
 *
 *  1. baseUrl() resolves from ANTHROPIC_BASE_URL ONLY — the old GETPOD_IMAGE_URL
 *     fallback was removed. Setting GETPOD_IMAGE_URL must change nothing.
 *  2. baseUrlIsSecure guard — the Bearer proxy secret rides every call, so an http
 *     URL to a PUBLIC host is refused (isEnabled → false). https, or http to a
 *     local/internal host (a trusted hop like host.docker.internal in dev), is allowed.
 *
 * baseUrl() and baseUrlIsSecure are private/module-internal, so we assert their
 * OBSERVABLE effect via isEnabled() driven purely by env.
 */
import { ImageModule } from '../../mcp/tools/image/module';

const ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'GETPOD_IMAGE_URL',
  'GETPOD_IMAGE_DISABLED',
  'GETPOD_IMAGE_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
] as const;

describe('ImageModule.isEnabled() — endpoint resolution + https guard', () => {
  const saved: Record<string, string | undefined> = {};
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    // isEnabled() logs to console.error the first time it refuses an insecure URL.
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    errSpy.mockRestore();
  });

  const enabled = () => new ImageModule().isEnabled();

  test('https ANTHROPIC_BASE_URL + token → enabled', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://provider.getpod.ai';
    process.env.ANTHROPIC_AUTH_TOKEN = 'proxy-secret';
    expect(enabled()).toBe(true);
  });

  test('ANTHROPIC_BASE_URL unset → disabled (no endpoint)', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'proxy-secret';
    expect(enabled()).toBe(false);
  });

  test('http to a local host (host.docker.internal) → enabled (trusted hop)', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://host.docker.internal:8080';
    process.env.ANTHROPIC_AUTH_TOKEN = 'proxy-secret';
    expect(enabled()).toBe(true);
  });

  test('http to localhost → enabled (trusted hop)', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:8080';
    process.env.ANTHROPIC_AUTH_TOKEN = 'proxy-secret';
    expect(enabled()).toBe(true);
  });

  test('http to a PUBLIC host → disabled (refuses to send Bearer secret in cleartext)', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://provider.getpod.ai';
    process.env.ANTHROPIC_AUTH_TOKEN = 'proxy-secret';
    expect(enabled()).toBe(false);
    expect(errSpy).toHaveBeenCalled(); // the guard warns once
  });

  test('GETPOD_IMAGE_DISABLED=true → disabled even with a valid https URL', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://provider.getpod.ai';
    process.env.ANTHROPIC_AUTH_TOKEN = 'proxy-secret';
    process.env.GETPOD_IMAGE_DISABLED = 'true';
    expect(enabled()).toBe(false);
  });

  describe('GETPOD_IMAGE_URL fallback is genuinely removed', () => {
    test('GETPOD_IMAGE_URL set but ANTHROPIC_BASE_URL unset → still disabled', () => {
      process.env.GETPOD_IMAGE_URL = 'https://legacy-image.getpod.ai';
      process.env.ANTHROPIC_AUTH_TOKEN = 'proxy-secret';
      expect(enabled()).toBe(false);
    });

    test('GETPOD_IMAGE_URL does not override ANTHROPIC_BASE_URL (setting it changes nothing)', () => {
      // With only a public-http ANTHROPIC_BASE_URL the module is disabled; adding a
      // valid https GETPOD_IMAGE_URL must NOT rescue it — the fallback is gone.
      process.env.ANTHROPIC_BASE_URL = 'http://provider.getpod.ai';
      process.env.ANTHROPIC_AUTH_TOKEN = 'proxy-secret';
      expect(enabled()).toBe(false);
      process.env.GETPOD_IMAGE_URL = 'https://provider.getpod.ai';
      expect(new ImageModule().isEnabled()).toBe(false);
    });
  });
});
