/**
 * HTTP client for gateway cron REST API.
 */

export class CronClient {
  private readonly baseUrl: string;
  private readonly agentId: string;
  private readonly apiKey: string;

  constructor(apiUrl: string, agentId: string, apiKey?: string) {
    this.baseUrl = apiUrl.replace(/\/$/, '');
    this.agentId = agentId;
    this.apiKey = apiKey ?? '';
  }

  private url(path: string, query?: Record<string, string>): string {
    const base = `${this.baseUrl}/api/v1/crons${path}`;
    if (!query) return base;
    const qs = new URLSearchParams(query).toString();
    return `${base}?${qs}`;
  }

  private async request(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (this.apiKey) headers['X-Api-Key'] = this.apiKey;

    const res = await fetch(this.url(path, query), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`API ${method} ${path} failed: HTTP ${res.status} ${text}`);
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      return res.json();
    }
    return res.text();
  }

  async list(): Promise<unknown> {
    return this.request('GET', '', undefined, { agent: this.agentId });
  }

  async create(params: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', '', { ...params, agentId: this.agentId });
  }

  async delete(jobId: string): Promise<void> {
    await this.request('DELETE', `/${jobId}`);
  }

  async run(jobId: string): Promise<unknown> {
    return this.request('POST', `/${jobId}/run`);
  }

  async getRuns(jobId: string): Promise<unknown> {
    return this.request('GET', `/${jobId}/runs`);
  }
}
