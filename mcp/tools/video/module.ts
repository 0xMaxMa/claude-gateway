import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolModule, McpToolDefinition, McpToolResult, ToolVisibility } from '../../types';
import {
  ShareClientError,
  createShares,
  listSessionImages,
  revokeSharesBestEffort,
  shareBridgeEnabled,
  type ShareRef,
  type ShareItem,
} from '../shared/share-client';

/**
 * Video-generation tool module — the moving-picture parallel of the image module
 * (tools/image/module.ts), sharing the same env-configured endpoint and M2M
 * `Authorization: Bearer <proxy_secret>` seam. A single `generate_video` tool with
 * generate | status | list | list_refs actions, results written into the session
 * media dir (like generate_image) so the existing reply tools deliver them.
 *
 * Flow (api contract, mirrors E1/E2 of the image path):
 *   generate → POST /v1/videos/generations (202 { task_id })
 *   → poll GET /v1/videos/jobs/:id → on done the job carries a `video_url`
 *   (a stable, M2M-authed api path /v1/videos/files/:id.mp4). We download that
 *   clip WITH the proxy secret — it is our own trusted api host, NOT an untrusted
 *   provider URL — and write the mp4 into GATEWAY_SESSION_MEDIA_DIR.
 *
 * Key differences from the image tool, all driven by the medium:
 *   - one clip per request (no `n`), so no batch delivery;
 *   - the result is always a large binary the api streams back over an authed
 *     path — never base64-in-JSON — so `deliver()` re-fetches by task_id with the
 *     Bearer secret instead of running the image path's public-URL SSRF screen;
 *   - a longer default poll budget (video generation legitimately runs minutes).
 *   - `image` is a single optional SOURCE FRAME for image-to-video (share-bridge
 *     minted to a public URL the provider fetches), not a batch of edit refs, and
 *     there is no `continue_from` resume concept.
 */

const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_POLL_TIMEOUT_MS = 300_000; // 5 min — video runs longer than an image
const REQUEST_TIMEOUT_MS = 30_000;
// A finished clip is a few MB, but bound the download so a hung/oversized upstream
// can't OOM the tool. The api streams it off the microservice's disk.
const DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024; // 200 MB
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Human-readable guidance per api error code (mirrors the video api taxonomy). */
const ERROR_HINTS: Record<string, string> = {
  invalid_model: 'The model id is not recognised. Call generate_video with action="list" to see valid video models.',
  model_not_video: 'That model is not a video model. Use action="list" to pick a video-capable model.',
  missing_prompt: 'A non-empty prompt is required to generate a video.',
  unsupported_duration: 'The requested duration is out of range for this model. Try a shorter clip.',
  unauthorized: 'The gateway is not authorised to call the video service (check the proxy secret).',
  insufficient_credit: 'Not enough daily credit to generate this video on the managed pool. Try later.',
  not_pool_eligible: 'That model is not pool-eligible for video generation. Pick a pool-eligible video model (action="list").',
  no_credential: 'No provider key is available for video generation.',
  rate_limited: 'Video generation is rate-limited right now. Wait a moment and try again.',
  no_supply: 'No managed provider key is available for this provider right now. Try again later.',
  provider_error: 'The video provider returned an error. Try again or adjust the prompt.',
  provider_timeout: 'The video provider timed out. Try again.',
  content_policy: 'The prompt was rejected by the provider content policy. Rephrase and try again.',
  job_not_found: 'That video job was not found (it may have expired or belongs to another user).',
  result_expired: 'The generated video expired before it was fetched (credit was already spent). Generate it again.',
};

type JobResponse = {
  task_id?: string;
  status?: 'queued' | 'running' | 'done' | 'failed';
  // What actually generated (or is generating) the clip — echoed on every poll so
  // a status re-poll in a LATER turn (no longer holding the original "model" arg)
  // can still recover them instead of falling back to "unknown".
  provider?: string;
  model?: string;
  provider_task_id?: string;
  byok?: boolean;
  cost?: number;
  // Stable, M2M-authed api path (/v1/videos/files/:id.mp4) to the finished clip.
  // Present only on a done job.
  video_url?: string;
  error?: { code?: string; message?: string };
};

export class VideoModule implements ToolModule {
  id = 'video';
  toolVisibility: ToolVisibility = 'all-configured';

  isEnabled(): boolean {
    // Enabled when the api endpoint is configured (same resolution as the image
    // tool — video shares the getpod api) and not explicitly turned off.
    if (!this.baseUrl() || process.env.VIDEO_DISABLED === 'true') return false;
    // The Bearer proxy_secret rides every call — refuse a cleartext http URL to a
    // PUBLIC host (that would leak the secret). http to a local/internal host is a
    // trusted hop (e.g. host.docker.internal in dev) and stays allowed.
    if (!baseUrlIsSecure(this.baseUrl())) {
      if (!this.warnedInsecureUrl) {
        this.warnedInsecureUrl = true;
        console.error(
          `[video] ANTHROPIC_BASE_URL is http to a non-local host — refusing to send the proxy secret in cleartext. Use https (or a local/internal host).`
        );
      }
      return false;
    }
    return true;
  }

  private warnedInsecureUrl = false;

  getTools(): McpToolDefinition[] {
    return videoToolDefs;
  }

  async handleTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
    if (name !== 'generate_video') {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
    const action = typeof args.action === 'string' ? args.action : 'generate';
    switch (action) {
      case 'generate':
        // Only "generate" gets the signal — it's the one action with a multi-second
        // poll loop worth reacting to a Stop mid-flight. status/list/list_refs are
        // single bounded requests already.
        return this.handleGenerate(args, signal);
      case 'status':
        return this.handleStatus(args);
      case 'list':
        return this.handleList();
      case 'list_refs':
        return this.handleListRefs();
      default:
        return {
          content: [{ type: 'text', text: `generate_video: unknown action "${action}" (expected generate | status | list | list_refs)` }],
          isError: true,
        };
    }
  }

  // ── config ────────────────────────────────────────────────────────────────
  // Identical resolution to the image tool: video targets the same getpod api.

  private baseUrl(): string {
    const raw =
      process.env.VIDEO_BASE_URL ||
      process.env.IMAGE_BASE_URL ||
      process.env.ANTHROPIC_BASE_URL ||
      this.settingsEnv('ANTHROPIC_BASE_URL');
    return raw.replace(/\/+$/, '');
  }

  private authToken(): string {
    return (
      process.env.VIDEO_API_KEY ||
      process.env.IMAGE_API_KEY ||
      process.env.ANTHROPIC_AUTH_TOKEN ||
      this.settingsEnv('ANTHROPIC_AUTH_TOKEN') ||
      this.settingsEnv('CLAUDE_CODE_OAUTH_TOKEN')
    );
  }

  // Parsed `env` block of the CLI config, read once per instance.
  private settingsEnvCache?: Record<string, unknown> | null;

  private settingsEnv(key: string): string {
    if (this.settingsEnvCache === undefined) {
      try {
        const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
        this.settingsEnvCache =
          JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))?.env ?? null;
      } catch {
        this.settingsEnvCache = null;
      }
    }
    const v = this.settingsEnvCache?.[key];
    return typeof v === 'string' ? v : '';
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = this.authToken();
    if (token) h['Authorization'] = `Bearer ${token}`;
    const agentId = process.env.GATEWAY_AGENT_ID;
    const sessionId = process.env.GATEWAY_SESSION_ID;
    if (agentId) h['X-Agent-Id'] = agentId;
    if (sessionId) h['X-Session-Id'] = sessionId;
    return h;
  }

  // ── actions ───────────────────────────────────────────────────────────────

  private async handleList(): Promise<McpToolResult> {
    const url = `${this.baseUrl()}/v1/models?kind=video`;
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

  /**
   * action="list_refs" — the same ground-truth catalog of this session's images
   * the image tool exposes. For video it resolves a SOURCE FRAME for
   * image-to-video ("animate image 2"). Read-only, gated on the share bridge.
   */
  private async handleListRefs(): Promise<McpToolResult> {
    if (!shareBridgeEnabled()) {
      return {
        content: [{ type: 'text', text: 'generate_video: list_refs is unavailable (share bridge is not configured).' }],
        isError: true,
      };
    }
    let items;
    try {
      items = await listSessionImages();
    } catch (err) {
      if (err instanceof ShareClientError) {
        return { content: [{ type: 'text', text: `generate_video: ${err.code}: ${err.message}` }], isError: true };
      }
      return {
        content: [{ type: 'text', text: `generate_video: share service unavailable: ${(err as Error).message}` }],
        isError: true,
      };
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          images: items,
          note: 'Ground-truth catalog of every image in this session, numbered in order of first appearance ("image 1" = index 1). '
            + 'To animate one as the source frame, pass its "ref" value in the "image" argument of action="generate". '
            + 'Do NOT count images from conversation memory. '
            + 'When the user names an index ("Image 3", "the third image") or attached an image this turn, trust that exactly; '
            + 'when they refer by content ("the dog picture"), match against each item\'s "desc". '
            + 'If the reference is ambiguous or the index does not exist, ask the user instead of guessing. '
            + 'Items with available:false can no longer be used.',
        }),
      }],
    };
  }

  private async handleGenerate(args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    const model = typeof args.model === 'string' ? args.model.trim() : '';
    if (!prompt) {
      return { content: [{ type: 'text', text: `${ERROR_HINTS.missing_prompt}` }], isError: true };
    }
    if (!model) {
      return { content: [{ type: 'text', text: 'generate_video: "model" is required (use action="list" to see options).' }], isError: true };
    }

    // Build request body — forward only defined optional fields.
    const reqBody: Record<string, unknown> = { model, prompt };
    for (const k of ['resolution', 'aspect_ratio'] as const) {
      if (typeof args[k] === 'string' && (args[k] as string).length) reqBody[k] = args[k];
    }
    if (typeof args.duration === 'number' && args.duration > 0) {
      reqBody.duration = Math.floor(args.duration);
    }

    // Optional source frame for image-to-video. With the share bridge on, a local
    // media path or artifact:<id> is minted to a short-lived public URL the
    // provider fetches; with the bridge off, it's an exact legacy pass-through.
    const rawImage = typeof args.image === 'string' && args.image.length ? args.image.trim() : undefined;
    let mintedShareIds: string[] = [];
    if (rawImage) {
      if (shareBridgeEnabled()) {
        const normalized = await this.normalizeRef(rawImage);
        if ('error' in normalized) return normalized.error;
        mintedShareIds = normalized.mintedShareIds;
        reqBody.image = normalized.url;
      } else {
        reqBody.image = rawImage;
      }
    }

    // Submit. On an immediate submit failure, best-effort revoke any share URL
    // minted for this call — the TTL still bounds exposure otherwise.
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl()}/v1/videos/generations`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      await revokeSharesBestEffort(mintedShareIds);
      return this.unavailable(err);
    }
    const submitText = await res.text().catch(() => '');
    if (!res.ok) {
      await revokeSharesBestEffort(mintedShareIds);
      return this.mapHttpError(res.status, submitText);
    }

    let submit: JobResponse;
    try {
      submit = JSON.parse(submitText) as JobResponse;
    } catch {
      await revokeSharesBestEffort(mintedShareIds);
      return { content: [{ type: 'text', text: 'generate_video: invalid JSON from video service on submit' }], isError: true };
    }
    const taskId = submit.task_id;
    if (!taskId) {
      await revokeSharesBestEffort(mintedShareIds);
      return { content: [{ type: 'text', text: 'generate_video: video service did not return a task_id' }], isError: true };
    }

    // Poll until done/failed, budget exceeded, or the caller cancels (Stop
    // mid-generation). Checked at the top of every iteration AND inside sleep().
    const deadline = Date.now() + this.pollTimeoutMs();
    let last: JobResponse = submit;
    while (Date.now() < deadline) {
      if (signal?.aborted) return this.cancelledResult(taskId);
      await sleep(DEFAULT_POLL_INTERVAL_MS, signal);
      if (signal?.aborted) return this.cancelledResult(taskId);
      const polled = await this.fetchJob(taskId, signal);
      if (polled.__transportError) {
        if (signal?.aborted) return this.cancelledResult(taskId);
        continue;
      }
      if (polled.httpError) return this.mapHttpError(polled.httpError.status, polled.httpError.body);
      last = polled.job!;
      if (last.status === 'done') return await this.deliver(last, taskId, model);
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
          note: 'Video is still generating. Call generate_video again with action="status" and this task_id to fetch the result.',
        }),
      }],
    };
  }

  private async handleStatus(args: Record<string, unknown>): Promise<McpToolResult> {
    const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';
    if (!taskId) {
      return { content: [{ type: 'text', text: 'generate_video: action="status" requires "task_id"' }], isError: true };
    }
    const polled = await this.fetchJob(taskId);
    if (polled.__transportError) return this.unavailable(polled.__transportError);
    if (polled.httpError) return this.mapHttpError(polled.httpError.status, polled.httpError.body);
    const job = polled.job!;
    if (job.status === 'done') return await this.deliver(job, taskId);
    if (job.status === 'failed') return this.mapJobError(job);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ status: job.status ?? 'running', task_id: taskId, byok: job.byok ?? false, cost: job.cost ?? 0 }),
      }],
    };
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  /**
   * Normalize a single source-frame reference, preserving legacy pass-through when
   * the share bridge is off (caller checks that before invoking this):
   *   https URL     → validate syntax, pass through
   *   http URL      → reject (requires HTTPS)
   *   artifact:<id> → resolve+mint via gateway share API
   *   local path    → validate+mint via gateway share API
   */
  private async normalizeRef(
    raw: string,
  ): Promise<{ url: string; mintedShareIds: string[] } | { error: McpToolResult }> {
    const fail = (text: string): { error: McpToolResult } => ({
      error: { content: [{ type: 'text', text }], isError: true },
    });
    const ref = raw.trim();
    if (/^https:\/\//i.test(ref)) {
      try {
        new URL(ref);
      } catch {
        return fail('generate_video: reference URL is malformed.');
      }
      return { url: ref, mintedShareIds: [] };
    }
    if (/^http:\/\//i.test(ref)) {
      return fail('generate_video: http:// reference URLs are not allowed — use https.');
    }
    let shareRef: ShareRef;
    if (ref.startsWith('artifact:')) {
      const id = ref.slice('artifact:'.length).trim();
      if (!id) return fail('generate_video: empty artifact reference.');
      shareRef = { artifact_id: id };
    } else {
      shareRef = { path: ref };
    }
    let minted: ShareItem[];
    try {
      minted = await createShares([shareRef], { purpose: 'codex_ref' });
    } catch (err) {
      if (err instanceof ShareClientError) {
        if (err.code === 'share_ref_not_found' || err.code === 'image_ref_not_found') {
          return fail(`generate_video: ${err.code}: the referenced image/artifact does not exist in this session.`);
        }
        return fail(`generate_video: ${err.code}: ${err.message}`);
      }
      return fail(`generate_video: share service unavailable: ${(err as Error).message}`);
    }
    const item = minted[0];
    if (!item) return fail('generate_video: share service returned no share for the source frame.');
    // The provider fetches this over HTTPS, so it needs an absolute URL — which the
    // share API only fills when gateway.publicUrl is configured.
    if (!item.url) {
      await revokeSharesBestEffort([item.share_id]);
      return fail('generate_video: source-frame sharing requires gateway.publicUrl to be configured.');
    }
    return { url: item.url, mintedShareIds: [item.share_id] };
  }

  private pollTimeoutMs(): number {
    const raw = Number(process.env.VIDEO_POLL_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_POLL_TIMEOUT_MS;
  }

  /** Best-effort E3 cancel — fires and never throws. */
  private async cancelJob(taskId: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl()}/v1/videos/jobs/${encodeURIComponent(taskId)}/cancel`, {
        method: 'POST',
        headers: this.headers(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // non-fatal — the local tool call already reports itself cancelled either way
    }
  }

  // Tracks the in-flight cancel call so drainCancel() can await it before the
  // server process exits (see the image module for the full stdin-close rationale).
  private activeCancelPromise: Promise<void> | null = null;

  /** Wait for any in-flight E3 cancel to complete. Called by the shutdown handler. */
  async drainCancel(): Promise<void> {
    if (this.activeCancelPromise) await this.activeCancelPromise;
  }

  /** Tool result for a Stop-triggered cancellation, firing the E3 cancel first. */
  private cancelledResult(taskId: string): McpToolResult {
    this.activeCancelPromise = this.cancelJob(taskId).finally(() => {
      this.activeCancelPromise = null;
    });
    return {
      content: [{
        type: 'text',
        text: `generate_video: cancelled (task_id ${taskId}).`,
      }],
      isError: true,
    };
  }

  /** Fetch a job (E2), classifying transport vs HTTP errors so the poller can retry transient ones. */
  private async fetchJob(taskId: string, signal?: AbortSignal): Promise<{ job?: JobResponse; httpError?: { status: number; body: string }; __transportError?: unknown }> {
    let res: Response;
    try {
      const fetchSignal = signal
        ? AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal])
        : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      res = await fetch(`${this.baseUrl()}/v1/videos/jobs/${encodeURIComponent(taskId)}`, {
        method: 'GET',
        headers: this.headers(),
        signal: fetchSignal,
      });
    } catch (err) {
      return { __transportError: err };
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) return { httpError: { status: res.status, body: text } };
    try {
      return { job: JSON.parse(text) as JobResponse };
    } catch {
      return { httpError: { status: res.status, body: 'invalid JSON from video service' } };
    }
  }

  /**
   * Download the finished clip into the session media dir and return its path.
   *
   * Unlike the image path, the clip is not base64 in the job JSON — it is streamed
   * by our OWN api at a stable, M2M-authed path we reconstruct from the task id
   * (/v1/videos/files/:id.mp4). We fetch it WITH the proxy secret. Because that
   * host is the same trusted api we just submitted to (not a provider-controlled
   * URL), the image path's public-address SSRF screen does NOT apply — it would in
   * fact block our own internal api host. The backstop against garbage is the mp4
   * magic-byte check below.
   */
  // `model` is only known on the generate path (same-turn poll); the
  // action="status" path re-enters in a later turn without it.
  private async deliver(job: JobResponse, taskId: string, model?: string): Promise<McpToolResult> {
    // Reconstruct the file URL from the task id rather than trusting job.video_url
    // verbatim (defence in depth — it's our own fixed path shape either way).
    const fileUrl = `${this.baseUrl()}/v1/videos/files/${encodeURIComponent(taskId)}.mp4`;
    const mediaDir = this.resolveMediaDir();
    let filePath: string;
    try {
      let res: Response;
      try {
        res = await fetch(fileUrl, { method: 'GET', headers: this.headers(), signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: 'error' });
      } catch (err) {
        // A done job whose buffered clip is gone (TTL) surfaces here or as a 404.
        return { content: [{ type: 'text', text: `generate_video: failed to fetch the finished clip: ${(err as Error).message}` }], isError: true };
      }
      if (res.status === 404) {
        const code = job.error?.code ?? 'result_expired';
        const msg = job.error?.message ?? ERROR_HINTS[code] ?? 'The generated video is no longer available.';
        return { content: [{ type: 'text', text: `${code}: ${msg}` }], isError: true };
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return this.mapHttpError(res.status, body);
      }
      const buf = await readCapped(res, DOWNLOAD_MAX_BYTES);
      if (!isMp4(buf)) {
        // Not a recognized mp4 — reject instead of saving garbage (e.g. an api
        // error page that slipped through with a 200).
        return { content: [{ type: 'text', text: 'generate_video: the video service returned data that is not a recognized mp4' }], isError: true };
      }
      fs.mkdirSync(mediaDir, { recursive: true });
      const filename = `video_${sanitize(process.env.GATEWAY_SESSION_ID ?? 'default')}_${Date.now()}.mp4`;
      filePath = path.join(mediaDir, filename);
      fs.writeFileSync(filePath, buf);
    } catch (err) {
      return { content: [{ type: 'text', text: `generate_video: failed to save video: ${(err as Error).message}` }], isError: true };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'done',
          task_id: taskId,
          ...(model ? { model } : {}),
          byok: job.byok ?? false,
          cost: job.cost ?? 0,
          files: [filePath],
          note: 'Video saved. Deliver it to the user with your channel delivery tool — api_reply/reply (files: [...]). Do NOT open/Read the file to inspect it first; attach it and answer briefly.'
            + (model ? ` Mention which model made it (${model}).` : ''),
        }),
      }],
    };
  }

  /**
   * Where to write result clips. Prefer the per-session media dir the gateway
   * provisions (GATEWAY_SESSION_MEDIA_DIR); otherwise derive the agent media root
   * from the workspace (…/agents/<id>/media); last resort /tmp.
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
      content: [{ type: 'text', text: `generate_video: video service unavailable: ${(err as Error).message}` }],
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
    return { content: [{ type: 'text', text: text || `video service error (HTTP ${status})` }], isError: true };
  }

  private mapJobError(job: JobResponse): McpToolResult {
    const code = job.error?.code ?? 'provider_error';
    const message = job.error?.message ?? '';
    const hint = ERROR_HINTS[code];
    const text = [`${code}${message ? `: ${message}` : ''}`, hint && hint !== message ? hint : '']
      .filter(Boolean)
      .join(' — ');
    return { content: [{ type: 'text', text: text || `video generation failed (${code})` }], isError: true };
  }
}

// Resolves early (without rejecting) on abort — the poll loop re-checks
// signal.aborted itself right after, so this only needs to shorten the wait.
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((r) => {
    const onAbort = () => { clearTimeout(t); r(); };
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); r(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'default';
}

// Read a response body into a Buffer with a hard byte ceiling: reject early on a
// too-large Content-Length, and stream-count actual bytes so a chunked response
// without Content-Length can't blow past the cap (OOM guard).
async function readCapped(res: Response, cap: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) {
    throw new Error(`download video too large: ${declared} bytes (max ${cap})`);
  }
  if (!res.body) {
    const ab = await res.arrayBuffer();
    if (ab.byteLength > cap) throw new Error(`download video too large (max ${cap} bytes)`);
    return Buffer.from(ab);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > cap) throw new Error(`download video exceeded ${cap} bytes`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
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

// True when the buffer is an ISO-BMFF/mp4 container: the first box's type (bytes
// 4..8) is "ftyp". Covers the H.264/AAC mp4 the grok-video path produces.
function isMp4(buf: Buffer): boolean {
  return buf.length >= 12 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70;
}

// https is required for a PUBLIC api endpoint (the Bearer proxy_secret is sent on
// every call); http is tolerated only for a local/internal host — a trusted hop
// such as host.docker.internal in dev, where cleartext never leaves the network.
function baseUrlIsSecure(raw: string): boolean {
  if (!raw) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  const h = u.hostname.toLowerCase();
  return (
    h === 'localhost' ||
    h === 'host.docker.internal' ||
    h.endsWith('.internal') ||
    h.endsWith('.local') ||
    /^127\./.test(h) ||
    h === '::1' ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)
  );
}

const videoToolDefs: McpToolDefinition[] = [
  {
    name: 'generate_video',
    description:
      'Use this WHENEVER the user asks to create, generate, make, or animate a VIDEO or clip — it is built in, no app install needed. ' +
      'Generate a short video from a text prompt (optionally animating a source image) via the configured video generation service. ' +
      'action="generate" submits the request and returns the saved mp4 file path once ready — then deliver it with your channel reply ' +
      'tool (files: [...]). AFTER A SUCCESSFUL GENERATE: do NOT open/Read the produced file to inspect it and do NOT re-analyze it — ' +
      'the generation already succeeded; attach it with your reply tool and answer in one or two short sentences. ' +
      'action="status" polls a previously returned task_id. ' +
      'PATIENCE: video generation legitimately takes minutes — a "running" status (including the "still generating, call again with ' +
      'action=status" note you get back when the local poll budget runs out) is normal, not stuck. Keep calling action="status" with ' +
      'the SAME task_id until it resolves to done/failed. Do NOT submit a new action="generate" call for the same request while an ' +
      'earlier task_id is still running — the earlier job may finish moments later and you will have generated and charged for the clip ' +
      'twice while delivering only one. ' +
      'action="list" returns every available video model with its parameters (durations, resolutions, cost). Call it FIRST when choosing ' +
      'a model. ' +
      'SOURCE IMAGE (image-to-video): to animate an existing image, pass its media path in "image" (a media path, an "artifact:<id>" ref, ' +
      'or an https URL). When the user points at an image from earlier in the chat ("animate image 2", "the first picture"), call ' +
      'action="list_refs" FIRST and pass the chosen item\'s "ref" — never count images from your own memory of the conversation. ' +
      'Omit "image" for pure text-to-video (the service generates its own source frame from the prompt). ' +
      'When the user selected options in the composer (a <video-params .../> tag in the turn), honor those values.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['generate', 'status', 'list', 'list_refs'],
          description: 'generate (default) | status | list | list_refs (numbered catalog of this session\'s images, for resolving "animate the second image" style references)',
        },
        model: {
          type: 'string',
          description: 'Model id "provider/model" (required for generate). Use action="list" to discover valid ids.',
        },
        prompt: { type: 'string', description: 'Text prompt describing the video (required for generate).' },
        duration: { type: 'integer', description: 'Optional clip length in seconds (provider default if omitted).' },
        resolution: { type: 'string', description: 'Optional resolution, e.g. "480p" or "720p" (must be supported by the model).' },
        aspect_ratio: { type: 'string', description: 'Optional aspect ratio, e.g. "9:16" or "16:9".' },
        image: { type: 'string', description: 'Optional source frame for image-to-video: a media path (e.g. "media/xxx.png"), an "artifact:<id>" ref, or an https URL. Local/artifact refs are converted to short-lived URLs automatically. Omit for text-to-video.' },
        task_id: { type: 'string', description: 'Job id to poll (required for action="status").' },
      },
      required: [],
    },
  },
];
