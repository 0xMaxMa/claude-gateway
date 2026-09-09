/**
 * HTTP client for the gateway's own WeChat REST API — never a direct iLink
 * call from inside the agent's sandbox. Mirrors `mcp/tools/cron/client.ts`'s
 * shape: this subprocess has no route to the live long-poll session the main
 * gateway process holds in memory (per agent), so sending has to go through
 * that process's own `/wechat/send` route, the same way WhatsApp's Baileys
 * socket is reached (see src/api/router.ts's `/whatsapp/send` doc comment
 * for the same reasoning, once that channel lands).
 */

export class WeChatClient {
  private readonly baseUrl: string;
  private readonly agentId: string;
  private readonly apiKey: string;

  constructor(apiUrl: string, agentId: string, apiKey?: string) {
    this.baseUrl = apiUrl.replace(/\/$/, '');
    this.agentId = agentId;
    this.apiKey = apiKey ?? '';
  }

  private url(path: string): string {
    return `${this.baseUrl}/api/v1/agents/${this.agentId}/wechat${path}`;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (this.apiKey) headers['X-Api-Key'] = this.apiKey;

    const res = await fetch(this.url(path), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`WeChat API ${method} ${path} failed: HTTP ${res.status} ${text}`);
    }

    const contentType = res.headers.get('content-type') ?? '';
    return contentType.includes('application/json') ? res.json() : res.text();
  }

  async send(toId: string, text: string): Promise<void> {
    await this.request('POST', '/send', { to_id: toId, text });
  }
}
