/**
 * HTTP client for the gateway apps REST API.
 */

export class AppsClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(apiUrl: string, apiKey?: string) {
    this.baseUrl = apiUrl.replace(/\/$/, '');
    this.apiKey = apiKey ?? '';
  }

  private url(p: string): string {
    return `${this.baseUrl}/api/v1/apps${p}`;
  }

  private async request(method: string, p: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const res = await fetch(this.url(p), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Apps API ${method} ${p} failed: HTTP ${res.status} ${text}`);
    }

    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) return res.json();
    return res.text();
  }

  async listRegistry(): Promise<unknown> {
    return this.request('GET', '/registry');
  }

  async getRegistry(name: string): Promise<unknown> {
    return this.request('GET', `/registry/${encodeURIComponent(name)}`);
  }

  async listApps(): Promise<unknown> {
    return this.request('GET', '');
  }

  async getApp(name: string): Promise<unknown> {
    return this.request('GET', `/${encodeURIComponent(name)}`);
  }

  async getVersion(name: string): Promise<unknown> {
    return this.request('GET', `/${encodeURIComponent(name)}/version`);
  }

  async install(params: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', '/install', params);
  }

  async pollJob(jobId: string): Promise<unknown> {
    return this.request('GET', `/jobs/${encodeURIComponent(jobId)}`);
  }

  async uninstall(name: string): Promise<unknown> {
    return this.request('DELETE', `/${encodeURIComponent(name)}`);
  }

  async update(name: string): Promise<unknown> {
    return this.request('POST', `/${encodeURIComponent(name)}/update`);
  }

  async startStop(name: string, action: 'start' | 'stop' | 'restart'): Promise<unknown> {
    return this.request('POST', `/${encodeURIComponent(name)}/${action}`);
  }
}
