import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as dns from 'node:dns';
import * as net from 'node:net';
import type { ToolModule, McpToolDefinition, McpToolResult, ToolVisibility } from '../../types';
import {
  ShareClientError,
  createShares,
  listSessionImages,
  registerArtifacts,
  revokeSharesBestEffort,
  shareBridgeEnabled,
  type ShareRef,
  type ShareItem,
} from '../shared/share-client';

/**
 * Image-generation tool module (#184, Track B).
 *
 * Mirrors the browser module shape: an env-configured image-service endpoint reached
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
// deliver() hardening: cap per-image download (a provider URL could stream GBs →
// OOM) and cap how many images we write per job (unbounded sequential downloads
// would hang the tool ~N×30s).
const DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024; // 25 MB per image
const MAX_DELIVER_IMAGES = 10;

/** Human-readable guidance per api error code (contract §6 taxonomy). */
const ERROR_HINTS: Record<string, string> = {
  invalid_model: 'The model id is not recognised. Call generate_image with action="list" to see valid image models.',
  model_not_image: 'That model is not an image model. Use action="list" to pick an image-capable model.',
  missing_prompt: 'A non-empty prompt is required to generate an image.',
  unsupported_quality: 'The requested quality is not supported by this model. Check supported_qualities from action="list".',
  image_ref_unsupported: 'This model cannot take a reference image (supports_image_ref is false). Either retry WITHOUT the "image" param — look at the reference image yourself and describe it in the prompt (text-to-image) — or switch to a model whose supports_image_ref is true (see action="list").',
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
    // Enabled when the image endpoint is configured in ~/.claude/settings.json (see
    // baseUrl()) and not explicitly turned off.
    if (!this.baseUrl() || process.env.IMAGE_DISABLED === 'true') return false;
    // The Bearer proxy_secret rides every call — refuse a cleartext http URL to a
    // PUBLIC host (that would leak the secret). http to a local/internal host is a
    // trusted hop (e.g. host.docker.internal in dev) and stays allowed.
    if (!baseUrlIsSecure(this.baseUrl())) {
      if (!this.warnedInsecureUrl) {
        this.warnedInsecureUrl = true;
        console.error(
          `[image] ANTHROPIC_BASE_URL is http to a non-local host — refusing to send the proxy secret in cleartext. Use https (or a local/internal host).`
        );
      }
      return false;
    }
    return true;
  }

  private warnedInsecureUrl = false;

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
      case 'list_refs':
        return this.handleListRefs();
      default:
        return {
          content: [{ type: 'text', text: `generate_image: unknown action "${action}" (expected generate | status | list | list_refs)` }],
          isError: true,
        };
    }
  }

  // ── config ────────────────────────────────────────────────────────────────

  private baseUrl(): string {
    // Image generation may target a provider separate from the LLM: IMAGE_BASE_URL
    // (or ANTHROPIC_BASE_URL when they share a provider that fronts /v1/images
    // alongside /v1/messages) overrides. When neither env var is set, fall back to
    // the Claude Code CLI config at ~/.claude/settings.json — its `env` block carries
    // ANTHROPIC_BASE_URL, and the CLI applies that block internally (not to the OS
    // environment), so an MCP subprocess can't inherit it and reads the file instead.
    const raw =
      process.env.IMAGE_BASE_URL ||
      process.env.ANTHROPIC_BASE_URL ||
      this.settingsEnv('ANTHROPIC_BASE_URL');
    return raw.replace(/\/+$/, '');
  }

  private authToken(): string {
    // IMAGE_API_KEY overrides so a separate image endpoint can carry its own secret;
    // falls back to ANTHROPIC_AUTH_TOKEN, then to the CLI config's `env` block in
    // ~/.claude/settings.json. Check BOTH token keys there: a proxy deployment may store the
    // M2M secret under ANTHROPIC_AUTH_TOKEN (the same key the env path uses) or under
    // CLAUDE_CODE_OAUTH_TOKEN — mirror the env precedence and accept either.
    return (
      process.env.IMAGE_API_KEY ||
      process.env.ANTHROPIC_AUTH_TOKEN ||
      this.settingsEnv('ANTHROPIC_AUTH_TOKEN') ||
      this.settingsEnv('CLAUDE_CODE_OAUTH_TOKEN')
    );
  }

  // Parsed `env` block of the CLI config, read once per instance (settings don't
  // change within a session). undefined = not read yet; null = unreadable.
  private settingsEnvCache?: Record<string, unknown> | null;

  // settingsEnv reads a single key out of ~/.claude/settings.json's `env` block.
  // CLAUDE_CONFIG_DIR overrides the ~/.claude location, matching Claude Code. Returns
  // '' on any error (missing file, bad JSON, absent/non-string key) so callers degrade
  // to "not configured" rather than throwing.
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

  /**
   * action="list_refs" (#72) — return the deterministic, gateway-computed catalog
   * of every image in this session so the agent never has to count images from its
   * own transcript (which breaks after compaction/resume). Read-only.
   *
   * Gated on the share bridge exactly like reference minting: with the bridge off
   * there is no catalog endpoint to read, so the action stays inert (legacy mode
   * gains no new behavior).
   */
  private async handleListRefs(): Promise<McpToolResult> {
    if (!shareBridgeEnabled()) {
      return {
        content: [{ type: 'text', text: 'generate_image: list_refs is unavailable (image share bridge is not configured).' }],
        isError: true,
      };
    }
    let items;
    try {
      items = await listSessionImages();
    } catch (err) {
      if (err instanceof ShareClientError) {
        return { content: [{ type: 'text', text: `generate_image: ${err.code}: ${err.message}` }], isError: true };
      }
      return {
        content: [{ type: 'text', text: `generate_image: image share service unavailable: ${(err as Error).message}` }],
        isError: true,
      };
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          images: items,
          note: 'Ground-truth catalog of every image in this session, numbered in order of first appearance ("image 1" = index 1). '
            + 'To use one as a reference, pass its "ref" value in the "image"/"images" argument of action="generate". '
            + 'Do NOT count images from conversation memory. '
            + 'Resolution precedence: (1) when the user names an index ("Image 3", "the third image") or attached an image this turn, '
            + 'trust that EXACTLY — never let "desc" override an explicit reference; '
            + '(2) when the user refers by content ("the dog picture"), match against each item\'s "desc" '
            + '(the generation prompt, or the user text that came with an upload); '
            + '(3) if the reference is ambiguous or the index does not exist, ask the user instead of guessing. '
            + 'Items with available:false can no longer be used.',
        }),
      }],
    };
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
    if (typeof args.n === 'number' && args.n > 0) {
      // Clamp the requested image count — an unbounded n is forwarded straight to
      // the provider (cost / abuse). MAX_DELIVER_IMAGES is the most we can deliver
      // back anyway, so generating more is wasted spend.
      reqBody.n = Math.min(Math.floor(args.n), MAX_DELIVER_IMAGES);
    }

    // Reference images (#70): when the share bridge is enabled, local paths and
    // artifact:<id> refs are auto-converted to short-lived public share URLs via
    // the authenticated gateway API (plan §7). With the bridge off, behavior is
    // EXACTLY the legacy pass-through (regression guarantee).
    const rawImage = typeof args.image === 'string' && args.image.length ? args.image : undefined;
    const rawImages =
      Array.isArray(args.images) && args.images.every((x) => typeof x === 'string') && args.images.length
        ? (args.images as string[])
        : undefined;
    let mintedShareIds: string[] = [];
    if (shareBridgeEnabled() && (rawImage || rawImages)) {
      if (rawImage && rawImages) {
        return { content: [{ type: 'text', text: 'generate_image: pass either "image" or "images", not both.' }], isError: true };
      }
      const normalized = await this.normalizeRefs(rawImage ? [rawImage] : rawImages!);
      if ('error' in normalized) return normalized.error;
      mintedShareIds = normalized.mintedShareIds;
      if (rawImage) reqBody.image = normalized.urls[0];
      else reqBody.images = normalized.urls;
    } else {
      if (rawImage) reqBody.image = rawImage;
      if (rawImages) reqBody.images = rawImages;
    }

    // Submit (E1). On an immediate submit failure, best-effort revoke any share
    // URLs minted for this call (§18) — the TTL still bounds exposure otherwise.
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl()}/v1/images/generations`, {
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
      return { content: [{ type: 'text', text: 'generate_image: invalid JSON from image service on submit' }], isError: true };
    }
    const taskId = submit.task_id;
    if (!taskId) {
      await revokeSharesBestEffort(mintedShareIds);
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
      if (last.status === 'done') return await this.deliver(last, taskId, model, prompt);
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
   * Normalize reference inputs (#70, plan §7), preserving order:
   *   https URL          → validate syntax, pass through
   *   http URL           → reject (phase 1 requires HTTPS)
   *   artifact:<id>      → resolve+mint via gateway share API
   *   local media path   → validate+mint via gateway share API
   * Rejects duplicates and over-count BEFORE any minting/billing.
   */
  private async normalizeRefs(
    refs: string[],
  ): Promise<{ urls: string[]; mintedShareIds: string[] } | { error: McpToolResult }> {
    const fail = (text: string): { error: McpToolResult } => ({
      error: { content: [{ type: 'text', text }], isError: true },
    });
    const maxRefs = (() => {
      const n = Number(process.env.IMAGE_SHARE_MAX_REFS);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
    })();
    if (refs.length > maxRefs) {
      return fail(`generate_image: too many reference images (max ${maxRefs}).`);
    }
    if (new Set(refs).size !== refs.length) {
      return fail('generate_image: duplicate reference images are not allowed.');
    }
    type Entry = { kind: 'url'; url: string } | { kind: 'local'; ref: ShareRef };
    const entries: Entry[] = [];
    for (const raw of refs) {
      const ref = raw.trim();
      if (/^https:\/\//i.test(ref)) {
        try {
          new URL(ref);
        } catch {
          return fail(`generate_image: reference URL is malformed.`);
        }
        entries.push({ kind: 'url', url: ref });
      } else if (/^http:\/\//i.test(ref)) {
        return fail('generate_image: http:// reference URLs are not allowed — use https.');
      } else if (ref.startsWith('artifact:')) {
        const id = ref.slice('artifact:'.length).trim();
        if (!id) return fail('generate_image: empty artifact reference.');
        entries.push({ kind: 'local', ref: { artifact_id: id } });
      } else {
        entries.push({ kind: 'local', ref: { path: ref } });
      }
    }
    const localRefs = entries.filter((e): e is Extract<Entry, { kind: 'local' }> => e.kind === 'local');
    let minted: ShareItem[] = [];
    if (localRefs.length) {
      try {
        minted = await createShares(localRefs.map((e) => e.ref), { purpose: 'codex_ref' });
      } catch (err) {
        if (err instanceof ShareClientError) {
          if (err.code === 'image_ref_not_found') {
            return fail('generate_image: image_ref_not_found: the referenced image/artifact does not exist in this session.');
          }
          return fail(`generate_image: ${err.code}: ${err.message}`);
        }
        return fail(`generate_image: image share service unavailable: ${(err as Error).message}`);
      }
      if (minted.length !== localRefs.length) {
        await revokeSharesBestEffort(minted.map((m) => m.share_id));
        return fail('generate_image: image share service returned a mismatched share count.');
      }
      // Provider fetches these refs over HTTPS, so each needs an absolute URL —
      // which the share API only fills when gateway.publicUrl is configured.
      if (minted.some((m) => !m.url)) {
        await revokeSharesBestEffort(minted.map((m) => m.share_id));
        return fail('generate_image: image reference sharing requires gateway.publicUrl to be configured.');
      }
    }
    // Merge back preserving the caller's order.
    let next = 0;
    const urls = entries.map((e) => (e.kind === 'url' ? e.url : minted[next++]!.url!));
    return { urls, mintedShareIds: minted.map((m) => m.share_id) };
  }

  private pollTimeoutMs(): number {
    const raw = Number(process.env.IMAGE_POLL_TIMEOUT_MS);
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

  /** Write done-job images into the session media dir and return their paths. Each
   *  item is either base64 bytes (sync providers like openai/gemini) OR an https URL
   *  (async providers like nanobanana/bfl/fal, which return a hosted file) — download
   *  URLs, decode base64. */
  // `prompt` is only known on the generate path (same-turn poll); the
  // action="status" path re-enters in a later turn without it, so those
  // artifacts register promptless.
  private async deliver(job: JobResponse, taskId: string, model?: string, prompt?: string): Promise<McpToolResult> {
    const allImages = Array.isArray(job.images) ? job.images.filter((s) => typeof s === 'string' && s.length) : [];
    // Cap how many we process — downloads are sequential (~30s each), so an
    // over-long list would hang the tool call far past the poll budget.
    const images = allImages.slice(0, MAX_DELIVER_IMAGES);
    const droppedImages = allImages.length - images.length;
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
      for (let idx = 0; idx < images.length; idx++) {
        const item = images[idx]!;
        let buf: Buffer;
        if (/^https?:\/\//i.test(item)) {
          // Async providers (nanobanana / bfl / fal / runway) return a hosted image
          // URL — download the bytes. SSRF guard: https-only + reject any host that
          // resolves to a private/loopback/link-local/metadata address, and
          // redirect:'error' so a 3xx hop can't bounce to an internal target.
          //
          // Residual risk (accepted): this is a best-effort screen, NOT a full
          // rebinding defence. assertSafeImageUrl resolves DNS once; fetch()
          // resolves again (Node/undici does not pin the vetted IP), so a
          // low-TTL record could answer public here and 127.0.0.1 at fetch time.
          // redirect:'error' does NOT close this — it only blocks HTTP redirects,
          // not DNS rebinding. The backstop is downstream: the response body must
          // pass detectImageExt() below, so an internal non-image endpoint yields
          // unrecognized bytes and is rejected before anything is written to disk.
          await assertSafeImageUrl(item);
          const res = await fetch(item, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
          if (!res.ok) throw new Error(`download image failed: HTTP ${res.status}`);
          buf = await readCapped(res, DOWNLOAD_MAX_BYTES);
        } else {
          // Base64 bytes (openai / gemini / stability / hf) — tolerate a data: URI
          // wrapper as well as raw base64.
          const m = /^data:[^;,]*;base64,(.*)$/is.exec(item);
          buf = Buffer.from(m ? m[1]! : item, 'base64');
          if (buf.length > DOWNLOAD_MAX_BYTES) {
            throw new Error(`inline image too large: ${buf.length} bytes (max ${DOWNLOAD_MAX_BYTES})`);
          }
        }
        const ext = detectImageExt(buf);
        if (!ext) {
          // Not a recognized image — reject instead of saving garbage. This is what
          // the old code did: base64-decode a URL string into ~60 bytes and save it
          // as a .png the web then failed to render.
          throw new Error('provider returned data that is not a recognized image');
        }
        const filename = `image_${sanitize(process.env.GATEWAY_SESSION_ID ?? 'default')}_${Date.now()}_${idx}.${ext}`;
        const filePath = path.join(mediaDir, filename);
        fs.writeFileSync(filePath, buf);
        files.push(filePath);
      }
    } catch (err) {
      return { content: [{ type: 'text', text: `generate_image: failed to save image: ${(err as Error).message}` }], isError: true };
    }

    // Register the written files as private artifacts (#70, plan §8) so a later
    // turn can reference them as artifact:<id> for editing. Best-effort: when
    // the bridge is off or registration fails, the response simply carries no
    // artifacts — file delivery is unaffected.
    let artifacts: Array<Record<string, unknown>> | undefined;
    if (shareBridgeEnabled() && files.length) {
      const slash = (model ?? '').indexOf('/');
      const provider = slash > 0 ? (model as string).slice(0, slash) : 'unknown';
      const modelName = slash > 0 ? (model as string).slice(slash + 1) : (model || 'unknown');
      const registered = await registerArtifacts(files, { provider, model: modelName, taskId, prompt });
      if (registered) {
        artifacts = registered.map((item, index) => ({
          artifact_id: item.artifact_id,
          artifact_ref: item.artifact_ref,
          index,
          path: files[index],
          provider,
          model: modelName,
        }));
      }
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
          ...(artifacts ? { artifacts } : {}),
          ...(droppedImages > 0 ? { dropped_images: droppedImages } : {}),
          note: 'Image saved. Deliver it to the user with your channel delivery tool — api_reply/reply (files: [...]), or line_image on LINE. Do NOT open/Read the file to inspect it first; attach it and answer briefly.'
            + (artifacts ? ' To edit this image later, reference it via its artifact_ref (e.g. image: "artifact:...").' : '')
            + (droppedImages > 0 ? ` (${droppedImages} extra image(s) beyond the cap were not saved)` : ''),
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

// SSRF guard for provider image URLs. Require https, then resolve the host and
// reject if ANY resolved address is private / loopback / link-local / metadata —
// so a compromised provider response can't make the gateway fetch internal or
// cloud-metadata endpoints. Best-effort screen only: a DNS rebind between this
// lookup and the fetch is NOT prevented here (Node does not let us pin the vetted
// IP without a custom undici dispatcher). The real backstop is the caller's
// post-download detectImageExt() check — non-image bytes are rejected before use.
async function assertSafeImageUrl(raw: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('image url is malformed');
  }
  if (u.protocol !== 'https:') throw new Error('refusing to download image over a non-https url');
  let addrs: { address: string }[];
  try {
    addrs = await dns.promises.lookup(u.hostname, { all: true });
  } catch {
    throw new Error('image url host could not be resolved');
  }
  if (!addrs.length || addrs.some((a) => isBlockedAddress(a.address))) {
    throw new Error('refusing to download image from a non-public address');
  }
}

// True for private / loopback / link-local / metadata / reserved IPs (v4 + v6),
// or anything that isn't a valid IP literal (fail closed).
function isBlockedAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = p as [number, number, number, number];
    if (a === 0 || a === 127) return true; // unspecified / loopback
    if (a === 10) return true; // 10/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 169 && b === 254) return true; // link-local + 169.254.169.254 metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (kind === 6) {
    const lo = ip.toLowerCase();
    if (lo === '::1' || lo === '::') return true; // loopback / unspecified
    if (lo.startsWith('fe80')) return true; // link-local
    if (lo.startsWith('fc') || lo.startsWith('fd')) return true; // unique-local fc00::/7
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lo); // IPv4-mapped (dotted)
    if (mapped) return isBlockedAddress(mapped[1]!);
    // IPv4-mapped in hex form, e.g. ::ffff:7f00:1 == 127.0.0.1 — decode both
    // 16-bit groups to dotted octets so it can't slip past the dotted check above.
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lo);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1]!, 16);
      const low = parseInt(mappedHex[2]!, 16);
      return isBlockedAddress(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`);
    }
    return false;
  }
  return true; // not a valid IP → block
}

// Read a response body into a Buffer with a hard byte ceiling: reject early on a
// too-large Content-Length, and stream-count actual bytes so a chunked response
// without Content-Length can't blow past the cap (OOM guard).
async function readCapped(res: Response, cap: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) {
    throw new Error(`download image too large: ${declared} bytes (max ${cap})`);
  }
  if (!res.body) {
    const ab = await res.arrayBuffer();
    if (ab.byteLength > cap) throw new Error(`download image too large (max ${cap} bytes)`);
    return Buffer.from(ab);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > cap) throw new Error(`download image exceeded ${cap} bytes`);
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

/** Detect image extension from magic bytes; default png. */
// Returns the extension for a recognized image (by magic bytes), or null when the
// buffer is NOT a known image — callers must reject that instead of saving garbage
// (a provider returning a URL parsed as base64, or a download that yielded an HTML
// error page, both land here).
function detectImageExt(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  return null;
}

// https is required for a PUBLIC image endpoint (the Bearer proxy_secret is sent on
// every call); http is tolerated only for a local/internal host — a trusted hop such
// as host.docker.internal in dev, where cleartext never leaves the machine/network.
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

const imageToolDefs: McpToolDefinition[] = [
  {
    name: 'generate_image',
    description:
      'Use this WHENEVER the user asks to create, draw, make, or edit an image — it is built in, no app install needed. ' +
      'Generate images from a text prompt (optionally guided by a reference image) via the configured image generation service. ' +
      'action="generate" submits the request and returns the saved image file path(s) once ready — ' +
      'then deliver them with your channel reply tool (files: [...]). AFTER A SUCCESSFUL GENERATE: do NOT ' +
      'open/Read the produced file to inspect it and do NOT re-analyze it — the generation already succeeded; ' +
      'attach it with your reply tool and answer in one or two short sentences. Every extra step risks pushing ' +
      'the request past its timeout. ' +
      'action="status" polls a previously returned task_id. ' +
      'action="list" returns every available image model with its supported_qualities, supported_sizes, cost, and ' +
      'the capability flags supports_image_ref (image-to-image / edit) and supports_style_ref. Call it FIRST when ' +
      'choosing a model or when you need to know what a provider can do — you are NOT limited to the composer ' +
      'options; you may set any parameter the chosen model actually supports. ' +
      'REFERENCE IMAGE: when the turn includes an image the user wants to transform or edit, prefer a model whose ' +
      'supports_image_ref is true and pass that image\'s media path in "image" (real image-to-image). If no ' +
      'img2img-capable model is available — or the model you picked has supports_image_ref=false — do NOT pass ' +
      '"image": instead look at the reference image yourself, describe what matters in the "prompt", and generate ' +
      'text-to-image. Never send "image" to a model that does not support it. ' +
      'EARLIER IMAGES IN THE CHAT: when the user points at an image from earlier in this conversation ' +
      '("image number 2", "the first image", "the picture you just made", "that logo from before"), call ' +
      'action="list_refs" FIRST. It returns the ground-truth catalog of this session\'s images numbered by ' +
      'first appearance; pass the chosen item\'s "ref" into "image"/"images". NEVER work out which earlier ' +
      'image the user means by counting from your own memory of the conversation — the numbering there is ' +
      'not reliable, and not remembering any images is NOT evidence there are none (your context may have ' +
      'been reset while the chat history still has them): never answer "no images attached" to such a ' +
      'request before list_refs has returned an empty catalog. If the catalog makes the request ambiguous ' +
      '(or the requested index does not exist), ask the user which image they mean instead of guessing. ' +
      'When the user selected options in the composer (an <image-params .../> tag in the turn), honor those values.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['generate', 'status', 'list', 'list_refs'],
          description: 'generate (default) | status | list | list_refs (numbered catalog of this session\'s images, for resolving "the second image" style references)',
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
        image: { type: 'string', description: 'Optional reference image for image-to-image/edit: a media path (e.g. "media/xxx.png"), an "artifact:<id>" ref from a previous generate_image result, or an https URL. Local/artifact refs are converted to short-lived URLs automatically. ONLY pass this to a model whose supports_image_ref is true (check action="list"); for any other model, describe the reference image in the prompt instead of sending it here. Do not pass both "image" and "images".' },
        images: { type: 'array', items: { type: 'string' }, description: 'Optional multiple reference images (max 5; media paths, artifact:<id> refs, or https URLs — same supports_image_ref rule as "image"). Order is preserved.' },
        style: { type: 'string', description: 'Optional native style parameter (e.g. "vivid") — only for models whose supports_style_ref is true.' },
        task_id: { type: 'string', description: 'Job id to poll (required for action="status").' },
      },
      required: [],
    },
  },
];
