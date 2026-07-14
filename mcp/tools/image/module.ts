import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolModule, McpToolDefinition, McpToolResult, ToolVisibility } from '../../types';

/**
 * Image-generation tool module (getpod-ai #184, Track B).
 *
 * Mirrors the browser module shape: an env-configured getpod-api endpoint reached
 * with `Authorization: Bearer <proxy_secret>` (the same M2M secret the LLM proxy
 * path already uses — contract §0/D16), a single `generate_image` tool with
 * generate | status | list actions (D18), and results written into the session
 * media dir (like browser_screenshot) so the existing reply tools deliver them.
 *
 * Flow (contract E1/E2): generate → POST /v1/images/generations (202 { task_id })
 * → poll GET /v1/images/jobs/:id → on done, write each b64 image into
 * GATEWAY_SESSION_MEDIA_DIR and return the absolute path(s).
 */

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_POLL_TIMEOUT_MS = 150_000;
const REQUEST_TIMEOUT_MS = 30_000;

/** Human-readable guidance per api error code (contract §6 taxonomy). */
const ERROR_HINTS: Record<string, string> = {
  invalid_model: 'The model id is not recognised. Call generate_image with action="list" to see valid image models.',
  model_not_image: 'That model is not an image model. Use action="list" to pick an image-capable model.',
  missing_prompt: 'A non-empty prompt is required to generate an image.',
  unsupported_quality: 'The requested quality is not supported by this model. Check supported_qualities from action="list".',
  unauthorized: 'The gateway is not authorised to call the image service (check the proxy secret).',
  insufficient_credit: 'Not enough daily credit to generate this image on the managed pool. Connect your own provider key (BYOK) or try later.',
  no_credential: 'No provider key is available: connect your own key (BYOK) or pick a pool-eligible model.',
  rate_limited: 'Image generation is rate-limited right now. Wait a moment and try again.',
  no_supply: 'No managed provider key is available for this provider right now. Try a different model or use BYOK.',
  provider_error: 'The image provider returned an error. Try again or adjust the prompt.',
  provider_timeout: 'The image provider timed out. Try again.',
  content_policy: 'The prompt was rejected by the provider content policy. Rephrase and try again.',
  job_not_found: 'That image job was not found (it may have expired or belongs to another user).',
  result_expired: 'The generated image expired before it was fetched (credit was already spent). Generate it again.',
};

type JobResponse = {
  task_id?: string;
  status?: 'queued' | 'running' | 'done' | 'failed';
  byok?: boolean;
  cost?: number;
  images?: string[];
  error?: { code?: string; message?: string };
};

export class ImageModule implements ToolModule {
  id = 'image';
  toolVisibility: ToolVisibility = 'all-configured';

  isEnabled(): boolean {
    // Enabled when the image service endpoint is configured (env-driven, like browser).
    return !!this.baseUrl() && process.env.GETPOD_IMAGE_DISABLED !== 'true';
  }

  getTools(): McpToolDefinition[] {
    return imageToolDefs;
  }

  async handleTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (name !== 'generate_image') {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
    const action = typeof args.action === 'string' ? args.action : 'generate';
    switch (action) {
      case 'generate':
        return this.handleGenerate(args);
      case 'status':
        return this.handleStatus(args);
      case 'list':
        return this.handleList();
      default:
        return {
          content: [{ type: 'text', text: `generate_image: unknown action "${action}" (expected generate | status | list)` }],
          isError: true,
        };
    }
  }

  // ── config ────────────────────────────────────────────────────────────────

  private baseUrl(): string {
    return (process.env.GETPOD_IMAGE_URL ?? '').replace(/\/+$/, '');
  }

  private authToken(): string {
    // Same M2M proxy secret used by the LLM path; falls back to ANTHROPIC_AUTH_TOKEN.
    return process.env.GETPOD_IMAGE_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || '';
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = this.authToken();
    if (token) h['Authorization'] = `Bearer ${token}`;
    // Optional identity context for api-side logging/trace (contract §0).
    const agentId = process.env.GATEWAY_AGENT_ID;
    const sessionId = process.env.GATEWAY_SESSION_ID;
    if (agentId) h['X-Agent-Id'] = agentId;
    if (sessionId) h['X-Session-Id'] = sessionId;
    return h;
  }

  // ── actions ───────────────────────────────────────────────────────────────

  private async handleList(): Promise<McpToolResult> {
    const url = `${this.baseUrl()}/v1/models?kind=image`;
    let res: Response;
    try {
      res = await fetch(url, { method: 'GET', headers: this.headers(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      return this.unavailable(err);
    }
    const body = await res.text().catch(() => '');
    if (!res.ok) return this.mapHttpError(res.status, body);
    return { content: [{ type: 'text', text: body || '[]' }] };
  }

  private async handleGenerate(args: Record<string, unknown>): Promise<McpToolResult> {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    const model = typeof args.model === 'string' ? args.model.trim() : '';
    if (!prompt) {
      return { content: [{ type: 'text', text: `${ERROR_HINTS.missing_prompt}` }], isError: true };
    }
    if (!model) {
      return { content: [{ type: 'text', text: 'generate_image: "model" is required (use action="list" to see options).' }], isError: true };
    }

    // Build request body — forward only defined optional fields (contract E1).
    const reqBody: Record<string, unknown> = { model, prompt };
    for (const k of ['quality', 'size', 'aspect_ratio', 'style'] as const) {
      if (typeof args[k] === 'string' && (args[k] as string).length) reqBody[k] = args[k];
    }
    if (typeof args.n === 'number' && args.n > 0) reqBody.n = args.n;
    if (typeof args.image === 'string' && args.image.length) reqBody.image = args.image;
    if (Array.isArray(args.images) && args.images.every((x) => typeof x === 'string') && args.images.length) {
      reqBody.images = args.images;
    }

    // Submit (E1)
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl()}/v1/images/generations`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      return this.unavailable(err);
    }
    const submitText = await res.text().catch(() => '');
    if (!res.ok) return this.mapHttpError(res.status, submitText);

    let submit: JobResponse;
    try {
      submit = JSON.parse(submitText) as JobResponse;
    } catch {
      return { content: [{ type: 'text', text: 'generate_image: invalid JSON from image service on submit' }], isError: true };
    }
    const taskId = submit.task_id;
    if (!taskId) {
      return { content: [{ type: 'text', text: 'generate_image: image service did not return a task_id' }], isError: true };
    }

    // Poll (E2) until done/failed or budget exceeded.
    const deadline = Date.now() + this.pollTimeoutMs();
    let last: JobResponse = submit;
    while (Date.now() < deadline) {
      await sleep(DEFAULT_POLL_INTERVAL_MS);
      const polled = await this.fetchJob(taskId);
      if (polled.__transportError) {
        // transient transport error — keep polling until deadline
        continue;
      }
      if (polled.httpError) return this.mapHttpError(polled.httpError.status, polled.httpError.body);
      last = polled.job!;
      if (last.status === 'done') return this.deliver(last, taskId);
      if (last.status === 'failed') return this.mapJobError(last);
    }

    // Still running after the local poll budget — hand the task_id back so the
    // agent can poll with action="status" (the api keeps the buffered result).
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: last.status ?? 'running',
          task_id: taskId,
          byok: last.byok ?? submit.byok ?? false,
          cost: last.cost ?? submit.cost ?? 0,
          note: 'Image is still generating. Call generate_image again with action="status" and this task_id to fetch the result.',
        }),
      }],
    };
  }

  private async handleStatus(args: Record<string, unknown>): Promise<McpToolResult> {
    const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';
    if (!taskId) {
      return { content: [{ type: 'text', text: 'generate_image: action="status" requires "task_id"' }], isError: true };
    }
    const polled = await this.fetchJob(taskId);
    if (polled.__transportError) return this.unavailable(polled.__transportError);
    if (polled.httpError) return this.mapHttpError(polled.httpError.status, polled.httpError.body);
    const job = polled.job!;
    if (job.status === 'done') return this.deliver(job, taskId);
    if (job.status === 'failed') return this.mapJobError(job);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ status: job.status ?? 'running', task_id: taskId, byok: job.byok ?? false, cost: job.cost ?? 0 }),
      }],
    };
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private pollTimeoutMs(): number {
    const raw = Number(process.env.GETPOD_IMAGE_POLL_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_POLL_TIMEOUT_MS;
  }

  /** Fetch a job (E2), classifying transport vs HTTP errors so the poller can retry transient ones. */
  private async fetchJob(taskId: string): Promise<{ job?: JobResponse; httpError?: { status: number; body: string }; __transportError?: unknown }> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl()}/v1/images/jobs/${encodeURIComponent(taskId)}`, {
        method: 'GET',
        headers: this.headers(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      return { __transportError: err };
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) return { httpError: { status: res.status, body: text } };
    try {
      return { job: JSON.parse(text) as JobResponse };
    } catch {
      return { httpError: { status: res.status, body: 'invalid JSON from image service' } };
    }
  }

  /** Write done-job b64 images into the session media dir and return their paths. */
  private deliver(job: JobResponse, taskId: string): McpToolResult {
    const images = Array.isArray(job.images) ? job.images.filter((s) => typeof s === 'string' && s.length) : [];
    if (!images.length) {
      // done but empty buffer → result_expired (credit already spent, D20)
      const code = job.error?.code ?? 'result_expired';
      const msg = job.error?.message ?? ERROR_HINTS[code] ?? 'The generated image is no longer available.';
      return { content: [{ type: 'text', text: `${code}: ${msg}` }], isError: true };
    }
    const mediaDir = this.resolveMediaDir();
    const files: string[] = [];
    try {
      fs.mkdirSync(mediaDir, { recursive: true });
      images.forEach((b64, idx) => {
        const buf = Buffer.from(b64, 'base64');
        const ext = detectImageExt(buf);
        const filename = `image_${sanitize(process.env.GATEWAY_SESSION_ID ?? 'default')}_${Date.now()}_${idx}.${ext}`;
        const filePath = path.join(mediaDir, filename);
        fs.writeFileSync(filePath, buf);
        files.push(filePath);
      });
    } catch (err) {
      return { content: [{ type: 'text', text: `generate_image: failed to save image: ${(err as Error).message}` }], isError: true };
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'done',
          task_id: taskId,
          byok: job.byok ?? false,
          cost: job.cost ?? 0,
          files,
          note: 'Image saved. Deliver it to the user with your channel reply tool (files: [...]) — e.g. api_reply, reply, or line_image.',
        }),
      }],
    };
  }

  /**
   * Where to write result images. Prefer the per-session media dir the gateway
   * already provisions (GATEWAY_SESSION_MEDIA_DIR); otherwise derive the agent
   * media root from the workspace (…/agents/<id>/media) so the file is reachable
   * by the reply/attachment routes; last resort /tmp (path still returned).
   */
  private resolveMediaDir(): string {
    const sessionMediaDir = process.env.GATEWAY_SESSION_MEDIA_DIR;
    if (sessionMediaDir) return sessionMediaDir;
    const workspace = process.env.GATEWAY_WORKSPACE_DIR;
    if (workspace) {
      const sid = sanitize(process.env.GATEWAY_SESSION_ID ?? 'default');
      return path.resolve(workspace, '..', 'media', `session-${sid}`);
    }
    return '/tmp';
  }

  private unavailable(err: unknown): McpToolResult {
    return {
      content: [{ type: 'text', text: `generate_image: image service unavailable: ${(err as Error).message}` }],
      isError: true,
    };
  }

  private mapHttpError(status: number, body: string): McpToolResult {
    let code = '';
    let message = '';
    try {
      const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } };
      code = parsed.error?.code ?? '';
      message = parsed.error?.message ?? '';
    } catch {
      /* non-JSON error body */
    }
    if (!code) code = defaultCodeForStatus(status);
    const hint = ERROR_HINTS[code];
    const text = [`${code}${message ? `: ${message}` : ''}`, hint && hint !== message ? hint : '']
      .filter(Boolean)
      .join(' — ');
    return { content: [{ type: 'text', text: text || `image service error (HTTP ${status})` }], isError: true };
  }

  private mapJobError(job: JobResponse): McpToolResult {
    const code = job.error?.code ?? 'provider_error';
    const message = job.error?.message ?? '';
    const hint = ERROR_HINTS[code];
    const text = [`${code}${message ? `: ${message}` : ''}`, hint && hint !== message ? hint : '']
      .filter(Boolean)
      .join(' — ');
    return { content: [{ type: 'text', text: text || `image generation failed (${code})` }], isError: true };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'default';
}

function defaultCodeForStatus(status: number): string {
  switch (status) {
    case 400: return 'invalid_model';
    case 401: return 'unauthorized';
    case 402: return 'insufficient_credit';
    case 403: return 'no_credential';
    case 404: return 'job_not_found';
    case 429: return 'rate_limited';
    case 503: return 'no_supply';
    default: return 'provider_error';
  }
}

/** Detect image extension from magic bytes; default png. */
function detectImageExt(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  return 'png';
}

const imageToolDefs: McpToolDefinition[] = [
  {
    name: 'generate_image',
    description:
      'Generate an image from a text prompt via the GetPod image service. ' +
      'action="generate" submits a prompt and returns the saved image file path(s) once ready — ' +
      'then deliver them with your channel reply tool (files: [...]). ' +
      'action="status" polls a previously returned task_id. ' +
      'action="list" returns the available image models with their supported qualities/sizes and cost. ' +
      'When the user selected options in the composer (an <image-params .../> tag in the turn), pass those values.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['generate', 'status', 'list'],
          description: 'generate (default) | status | list',
        },
        model: {
          type: 'string',
          description: 'Model id "provider/model" (required for generate). Use action="list" to discover valid ids.',
        },
        prompt: { type: 'string', description: 'Text prompt (required for generate).' },
        quality: { type: 'string', description: 'Optional quality (must be in the model supported_qualities).' },
        size: { type: 'string', description: 'Optional size, e.g. "1024x1024".' },
        aspect_ratio: { type: 'string', description: 'Optional aspect ratio, e.g. "1:1" (converted to size if the provider needs it).' },
        n: { type: 'integer', description: 'Optional number of images (default 1).' },
        image: { type: 'string', description: 'Optional reference-image media path for image-to-image/edit (e.g. "media/xxx.png").' },
        images: { type: 'array', items: { type: 'string' }, description: 'Optional multiple reference-image media paths.' },
        style: { type: 'string', description: 'Optional native style parameter (e.g. "vivid").' },
        task_id: { type: 'string', description: 'Job id to poll (required for action="status").' },
      },
      required: [],
    },
  },
];
