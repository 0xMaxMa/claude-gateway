/**
 * Unit tests for the image MCP tool's endpoint resolution + https guard
 * (mcp/tools/image/module.ts). Two behaviors are locked in here:
 *
 *  1. baseUrl() resolves from IMAGE_BASE_URL first, then ANTHROPIC_BASE_URL —
 *     image generation may target a provider separate from the LLM, so an
 *     operator can override the endpoint (and secret via IMAGE_API_KEY) while
 *     still falling back to the ANTHROPIC_* pair when they share one provider.
 *  2. baseUrlIsSecure guard — the Bearer secret rides every call, so an http
 *     URL to a PUBLIC host is refused (isEnabled → false). https, or http to a
 *     local/internal host (a trusted hop like host.docker.internal in dev), is allowed.
 *
 * baseUrl() and baseUrlIsSecure are private/module-internal, so we assert their
 * OBSERVABLE effect via isEnabled() driven purely by env.
 */
import { ImageModule } from '../../mcp/tools/image/module';

const ENV_KEYS = [
  'IMAGE_BASE_URL',
  'ANTHROPIC_BASE_URL',
  'IMAGE_DISABLED',
  'IMAGE_API_KEY',
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
    process.env.ANTHROPIC_BASE_URL = 'https://provider.example.com';
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
    process.env.ANTHROPIC_BASE_URL = 'http://provider.example.com';
    process.env.ANTHROPIC_AUTH_TOKEN = 'proxy-secret';
    expect(enabled()).toBe(false);
    expect(errSpy).toHaveBeenCalled(); // the guard warns once
  });

  test('IMAGE_DISABLED=true → disabled even with a valid https URL', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://provider.example.com';
    process.env.ANTHROPIC_AUTH_TOKEN = 'proxy-secret';
    process.env.IMAGE_DISABLED = 'true';
    expect(enabled()).toBe(false);
  });

  describe('IMAGE_BASE_URL overrides ANTHROPIC_BASE_URL', () => {
    test('IMAGE_BASE_URL set (https) with ANTHROPIC_BASE_URL unset → enabled', () => {
      process.env.IMAGE_BASE_URL = 'https://image.example.com';
      process.env.ANTHROPIC_AUTH_TOKEN = 'proxy-secret';
      expect(enabled()).toBe(true);
    });

    test('a valid https IMAGE_BASE_URL overrides a public-http ANTHROPIC_BASE_URL (image wins)', () => {
      // With only a public-http ANTHROPIC_BASE_URL the module is disabled; adding a
      // valid https IMAGE_BASE_URL points image at a separate endpoint and enables it.
      process.env.ANTHROPIC_BASE_URL = 'http://provider.example.com';
      process.env.ANTHROPIC_AUTH_TOKEN = 'proxy-secret';
      expect(enabled()).toBe(false);
      process.env.IMAGE_BASE_URL = 'https://image.example.com';
      expect(new ImageModule().isEnabled()).toBe(true);
    });

    test('IMAGE_API_KEY alone (no ANTHROPIC_AUTH_TOKEN) still enables with a valid URL', () => {
      process.env.IMAGE_BASE_URL = 'https://image.example.com';
      process.env.IMAGE_API_KEY = 'image-secret';
      expect(enabled()).toBe(true);
    });
  });
});
