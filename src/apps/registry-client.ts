const REGISTRY_URL =
  'https://raw.githubusercontent.com/0xMaxMa/claude-gateway-appstore/main/apps.json';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RegistryVersion {
  version: string;
  commit: string;
  approved_at: string;
}

export interface RegistryApp {
  name: string;
  description: string;
  repo: string;
  author: string;
  versions: RegistryVersion[];
}

interface RegistryIndex {
  updated_at: string;
  apps: RegistryApp[];
}

interface Cache {
  data: RegistryIndex;
  fetchedAt: number;
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class RegistryClient {
  private cache: Cache | null = null;

  /**
   * Fetch the community registry.
   * Returns cached data if within TTL.
   * Falls back to stale cache on network/parse error.
   * Throws only if no cached data is available.
   */
  async fetchRegistry(): Promise<RegistryIndex> {
    const now = Date.now();
    if (this.cache && now - this.cache.fetchedAt < CACHE_TTL_MS) {
      return this.cache.data;
    }

    try {
      const res = await fetch(REGISTRY_URL, {
        headers: { 'User-Agent': 'claude-gateway/appstore' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        throw new Error(`Registry fetch failed: HTTP ${res.status}`);
      }
      const raw: unknown = await res.json();
      const data = this.validate(raw);
      this.cache = { data, fetchedAt: now };
      return data;
    } catch (err) {
      if (this.cache) {
        // Stale cache is better than nothing
        return this.cache.data;
      }
      throw err;
    }
  }

  async findApp(name: string): Promise<RegistryApp | undefined> {
    const registry = await this.fetchRegistry();
    return registry.apps.find((a) => a.name === name);
  }

  async findVersion(
    name: string,
    version: string,
  ): Promise<{ app: RegistryApp; ver: RegistryVersion } | undefined> {
    const app = await this.findApp(name);
    if (!app) return undefined;
    const ver = app.versions.find((v) => v.version === version);
    if (!ver) return undefined;
    return { app, ver };
  }

  clearCache(): void {
    this.cache = null;
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private validate(raw: unknown): RegistryIndex {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('Invalid registry format: expected object');
    }
    const obj = raw as Record<string, unknown>;
    if (typeof obj['updated_at'] !== 'string') {
      throw new Error('Invalid registry format: missing "updated_at"');
    }
    if (!Array.isArray(obj['apps'])) {
      throw new Error('Invalid registry format: "apps" must be an array');
    }
    for (const app of obj['apps'] as unknown[]) {
      this.validateApp(app);
    }
    return raw as RegistryIndex;
  }

  private validateApp(app: unknown): void {
    if (typeof app !== 'object' || app === null) {
      throw new Error('Invalid registry entry: app must be an object');
    }
    const a = app as Record<string, unknown>;
    if (typeof a['name'] !== 'string' || !a['name']) {
      throw new Error('Invalid registry entry: missing "name"');
    }
    if (!Array.isArray(a['versions'])) {
      throw new Error(`Invalid registry entry "${a['name']}": "versions" must be an array`);
    }
    for (const v of a['versions'] as unknown[]) {
      this.validateVersion(v, String(a['name']));
    }
  }

  private validateVersion(v: unknown, appName: string): void {
    if (typeof v !== 'object' || v === null) {
      throw new Error(`Invalid version in "${appName}": must be an object`);
    }
    const ver = v as Record<string, unknown>;
    if (typeof ver['version'] !== 'string' || !ver['version']) {
      throw new Error(`Invalid version in "${appName}": missing "version"`);
    }
    if (typeof ver['commit'] !== 'string' || !/^[0-9a-f]{40}$/.test(ver['commit'])) {
      throw new Error(
        `Invalid version in "${appName}": "commit" must be a 40-char hex string`,
      );
    }
  }
}
