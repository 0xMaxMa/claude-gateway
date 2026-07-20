import { Router, Request, Response } from 'express';
import { randomUUID, createHash } from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { AgentRunner } from '../agent/runner';
import { AgentConfig, ApiKey, ModelConfig, SessionMeta } from '../types';
import { createApiAuthMiddleware, canAccessAgent, canWriteAgent, isAdmin } from './auth';
import { MediaStore } from '../history/media-store';
import { HistoryDB } from '../history/db';
import type { AgentSessionSummary } from '../history/types';
import { wizardStore } from './wizard-state';
import { getPendingSenders, clearPendingSender } from './line-pending-senders';
import { buildGenerationPrompt, parseGeneratedFiles } from '../agent/create-agent-prompts';

const MAX_MESSAGE_LENGTH = 10_000;
const DEFAULT_TIMEOUT_MS = 60_000;

type AuthedRequest = Request & { apiKey: ApiKey };

const AGENT_ID_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const SAFE_FILENAME_RE = /^[a-zA-Z0-9._\-() ]+$/;

function maskToken(token: string): string {
  if (token.length <= 12) return '•'.repeat(token.length);
  return token.slice(0, 8) + '•••••' + token.slice(-4);
}

/** Detect MIME type from file magic bytes (first 12 bytes). */
function detectMimeFromMagic(header: Buffer): string | null {
  if (header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF) return 'image/jpeg';
  if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47) return 'image/png';
  if (header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46) return 'image/gif';
  if (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46 &&
      header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50) return 'image/webp';
  if (header[0] === 0x25 && header[1] === 0x50 && header[2] === 0x44 && header[3] === 0x46) return 'application/pdf';
  return null;
}

const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const AVATAR_MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const TELEGRAM_API_BASE = process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org';

/** Max simultaneous wizard/start Claude subprocesses to prevent resource exhaustion. */
let wizardStartsInFlight = 0;
const WIZARD_MAX_CONCURRENT = 2;

/** Call Claude --print with stdin prompt; resolves with stdout on exit 0. */
function runClaude(prompt: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['--print', '--dangerously-skip-permissions'], {
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    const timer = setTimeout(() => { child.kill(); reject(new Error('Claude generation timed out')); }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out).toString('utf-8'));
      else reject(new Error(`Claude exited ${code}: ${Buffer.concat(err).toString('utf-8').slice(0, 200)}`));
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** Extract leading single emoji from first line of text. */
function extractLeadingEmoji(text: string): { emoji: string | undefined; rest: string } {
  const m = text.match(/^(\p{Emoji_Presentation}|\p{Emoji}️)\s*\n/u);
  if (m) return { emoji: m[1], rest: text.slice(m[0].length) };
  return { emoji: undefined, rest: text };
}

/** Read raw binary body up to maxBytes; rejects with 413 if exceeded. */
function readRawBody(req: Request, res: Response, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        if (!res.headersSent) res.status(413).json({ error: `File too large (max ${maxBytes / 1024 / 1024}MB)` });
        req.destroy();
        reject(new Error('too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Convert an absolute path back to a tilde-relative form when under $HOME. */
function absToTildePath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home + path.sep) ? path.join('~', p.slice(home.length + 1)) : p;
}

/** Verify a Telegram bot token via getMe; returns username on success. */
async function verifyTelegramToken(token: string): Promise<string | null> {
  try {
    const res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/getMe`);
    const json = await res.json() as { ok: boolean; result?: { username?: string } };
    return (json.ok && json.result?.username) ? json.result.username : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// In-memory rate limiter for media uploads (per API key)
// ---------------------------------------------------------------------------
const UPLOAD_RATE_LIMIT = 20;          // max uploads
const UPLOAD_RATE_WINDOW_MS = 60_000;  // per 60 seconds

const uploadRateMap = new Map<string, { count: number; resetAt: number }>();

function checkUploadRateLimit(apiKeyValue: string): boolean {
  const now = Date.now();
  const entry = uploadRateMap.get(apiKeyValue);
  if (!entry || now >= entry.resetAt) {
    uploadRateMap.set(apiKeyValue, { count: 1, resetAt: now + UPLOAD_RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= UPLOAD_RATE_LIMIT) return false;
  entry.count++;
  return true;
}

// Periodically evict expired entries so uploadRateMap doesn't grow indefinitely
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of uploadRateMap) {
    if (now >= entry.resetAt) uploadRateMap.delete(key);
  }
}, UPLOAD_RATE_WINDOW_MS).unref();

/** Derive a stable short ID from an API key value (never log the raw key). */
function apiKeyId(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export function createApiRouter(
  agentRunners: Map<string, AgentRunner>,
  agentConfigs: Map<string, AgentConfig>,
  apiKeys: ApiKey[],
  configPath?: string,
  models?: ModelConfig[],
): Router {
  const router = Router();
  const auth = createApiAuthMiddleware(apiKeys);

  // Closure-scoped lock: serialises concurrent writes to config.json within this router instance.
  let configWriteLock: Promise<void> = Promise.resolve();

  async function writeAgentsToConfigImpl(
    cfgPath: string,
    mutate: (agents: unknown[]) => void,
    newId?: string,
  ): Promise<void> {
    const raw = await fsp.readFile(cfgPath, 'utf-8');
    const config = JSON.parse(raw) as { agents: unknown[]; [k: string]: unknown };
    if (newId) {
      const exists = (config.agents as Record<string, unknown>[]).some((a) => a.id === newId);
      if (exists) throw Object.assign(new Error(`Agent '${newId}' already exists in config`), { code: 'DUPLICATE' });
    }
    mutate(config.agents);
    const tmp = cfgPath + '.tmp.' + randomUUID();
    await fsp.writeFile(tmp, JSON.stringify(config, null, 2), 'utf-8');
    await fsp.rename(tmp, cfgPath);
  }

  function writeAgentsToConfig(
    cfgPath: string,
    mutate: (agents: unknown[]) => void,
    newId?: string,
  ): Promise<void> {
    const next = configWriteLock.catch(() => {}).then(() => writeAgentsToConfigImpl(cfgPath, mutate, newId));
    configWriteLock = next.catch(() => {});
    return next;
  }

  /**
   * GET /api/v1/commands
   *
   * Return the list of slash commands available in the chat UI. No auth required.
   */
  router.get('/v1/commands', (_req: Request, res: Response) => {
    res.json({
      commands: [
        { name: '/session',  description: 'Show current session info (name, message count, context %)' },
        { name: '/clear',    description: 'Clear current session history' },
        { name: '/compact',  description: 'Summarise old history and keep only recent messages' },
        { name: '/stop',     description: 'Interrupt the in-flight turn' },
        { name: '/restart',  description: 'Graceful session restart' },
        { name: '/model',    description: 'Show the current AI model' },
      ],
    });
  });

  /**
   * POST /api/v1/agents/:agentId/messages
   *
   * Send a message to an agent and receive its response synchronously.
   * Body: { message: string, chat_id: string, session_id?: string }
   */
  router.post('/v1/agents/:agentId/messages', auth, async (req: Request, res: Response) => {
    const { agentId } = req.params as { agentId: string };
    const apiKey = (req as AuthedRequest).apiKey;

    if (!canAccessAgent(apiKey, agentId)) {
      res.status(403).json({ error: `API key has no access to agent '${agentId}'` });
      return;
    }

    const runner = agentRunners.get(agentId);
    if (!runner) {
      res.status(404).json({ error: `Agent '${agentId}' not found` });
      return;
    }

    const body = req.body as {
      message?: unknown;
      chat_id?: unknown;
      session_id?: unknown;
      stream?: unknown;
      timeout_ms?: unknown;
      media_files?: unknown;
      model?: unknown;
      store_user_message?: unknown;
    };
    const { message, chat_id, session_id, stream, timeout_ms, media_files, model: requestModel, store_user_message } = body;

    if (message !== undefined && typeof message !== 'string') {
      res.status(400).json({ error: 'message must be a string if provided' });
      return;
    }
    if (typeof message === 'string' && message.length > MAX_MESSAGE_LENGTH) {
      res.status(400).json({ error: `message too long (max ${MAX_MESSAGE_LENGTH} characters)` });
      return;
    }
    if (!chat_id || typeof chat_id !== 'string' || !chat_id.trim()) {
      res.status(400).json({ error: 'chat_id is required and must be a non-empty string' });
      return;
    }
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test((chat_id as string).trim())) {
      res.status(400).json({ error: 'chat_id must be 1-64 alphanumeric characters, hyphens, or underscores' });
      return;
    }
    if (session_id !== undefined && typeof session_id !== 'string') {
      res.status(400).json({ error: 'session_id must be a string if provided' });
      return;
    }

    // Validate media_files
    let validatedMediaFiles: string[] | undefined;
    if (media_files !== undefined) {
      if (!Array.isArray(media_files) || media_files.some((f) => typeof f !== 'string')) {
        res.status(400).json({ error: 'media_files must be an array of strings' });
        return;
      }
      if (media_files.length > 5) {
        res.status(400).json({ error: 'media_files exceeds maximum of 5 images per message' });
        return;
      }
      // Validate each path is within agent media root (path traversal guard)
      const routerAgentsBaseDir = runner.getAgentsBaseDir();
      for (const f of media_files as string[]) {
        try {
          MediaStore.resolvePath(routerAgentsBaseDir, agentId, f);
        } catch {
          res.status(400).json({ error: `Invalid media path: ${f}` });
          return;
        }
      }
      validatedMediaFiles = media_files as string[];
    }

    // Allow message OR media_files. Image-only sends pass an empty text
    // alongside the image_path attribute on channelXml so Claude can Read the file.
    const trimmedMessage = typeof message === 'string' ? message.trim() : '';
    const hasMedia = !!(validatedMediaFiles && validatedMediaFiles.length);
    if (!trimmedMessage && !hasMedia) {
      res.status(400).json({ error: 'message is required and must be a non-empty string (or provide media_files)' });
      return;
    }

    if (store_user_message !== undefined && typeof store_user_message !== 'boolean') {
      res.status(400).json({ error: 'store_user_message must be a boolean if provided' });
      return;
    }
    const skipUserMessage = store_user_message === false;
    if (skipUserMessage && !apiKey.write && !apiKey.admin) {
      res.status(403).json({ error: 'store_user_message: false requires a write or admin API key' });
      return;
    }

    // Allow any model string — BYOK/third-party models (e.g. openrouter/*) are validated
    // by the upstream provider, not the local config list.
    const modelStr = typeof requestModel === 'string' ? requestModel.trim() : undefined;
    const requestId = randomUUID();
    const sessionId = (session_id as string | undefined) ?? randomUUID();
    const chatIdStr = (chat_id as string).trim();
    const startTime = Date.now();
    const timeoutMs =
      typeof timeout_ms === 'number' && timeout_ms > 0 && timeout_ms <= 600_000
        ? timeout_ms
        : DEFAULT_TIMEOUT_MS;

    // Built-in commands (e.g. /model, /session) are intercepted and answered locally
    // instead of being sent to Claude. They flow through the SAME response path as a
    // normal message — same SSE events when stream, same JSON shape when sync — so the
    // client treats a command reply exactly like any other assistant reply.
    const isBuiltinCommand = !!trimmedMessage && AgentRunner.isApiBuiltinCommand(trimmedMessage);

    if (stream) {
      // SSE streaming mode
      let onClientDisconnect: (() => void) | undefined;
      try {
        const sseCallbacks = {
          onChunk: (event: import('../types').StreamEvent) => {
            try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* client gone */ }
          },
          onDone: (fullText: string, attachments: import('../types').ApiAttachment[]) => {
            try {
              const resultEvent: Record<string, unknown> = { type: 'result', text: fullText, request_id: requestId, session_id: sessionId, duration_ms: Date.now() - startTime };
              if (attachments.length) resultEvent['attachments'] = attachments;
              res.write(`data: ${JSON.stringify(resultEvent)}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
            } catch { /* client gone */ }
          },
          onError: (err: Error) => {
            try {
              res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
              res.end();
            } catch { /* client gone */ }
          },
        };
        const openSseStream = () => {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          res.flushHeaders();
        };

        // Built-in command — emit its response through the same SSE callbacks as a
        // normal reply. Commands bypass the 409 preflight (they must work mid-session,
        // e.g. /stop) and never reach Claude.
        if (isBuiltinCommand) {
          openSseStream();
          res.socket?.setNoDelay(true);
          try {
            const { responseText } = await runner.executeApiCommand(
              sessionId, chatIdStr, trimmedMessage, { skipPersist: skipUserMessage },
            );
            sseCallbacks.onChunk({ type: 'text_delta', text: responseText } as import('../types').StreamEvent);
            sseCallbacks.onDone(responseText, []);
          } catch (err: unknown) {
            sseCallbacks.onError(err as Error);
          }
          return;
        }

        // Preflight conflict check — return 409 JSON before SSE headers are sent
        if (runner.hasActiveApiSession(sessionId)) {
          res.status(409).json({ error: 'Session already has a pending request' });
          return;
        }

        openSseStream();
        res.socket?.setNoDelay(true);

        const agentCfg = agentConfigs.get(agentId)!;
        const allowTools = agentCfg.allow_tools ?? !!apiKey.allow_tools;
        onClientDisconnect = await runner.sendApiMessageStream(
          sessionId,
          chatIdStr,
          trimmedMessage,
          sseCallbacks,
          { timeoutMs, allowTools, mediaFiles: validatedMediaFiles, model: modelStr, skipUserMessage },
        );

        // Client disconnect — marks SSE writes as no-op; stream continues server-side until result is saved to DB
        res.on('close', onClientDisconnect);
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (!res.headersSent) {
          if (code === 'CONFLICT') {
            res.status(409).json({ error: 'Session already has a pending request' });
          } else {
            res.status(500).json({ error: 'Internal error' });
          }
        } else {
          try {
            res.write(`data: ${JSON.stringify({ type: 'error', message: 'Internal error' })}\n\n`);
            res.end();
          } catch { /* client gone */ }
        }
      }
    } else {
      // Synchronous mode (existing behavior)
      try {
        let responseText: string;
        let attachments: import('../types').ApiAttachment[] = [];
        if (isBuiltinCommand) {
          // Built-in command — answer locally, return the same JSON shape as a normal reply.
          ({ responseText } = await runner.executeApiCommand(
            sessionId, chatIdStr, trimmedMessage, { skipPersist: skipUserMessage },
          ));
        } else {
          const agentCfgSync = agentConfigs.get(agentId)!;
          const allowToolsSync = agentCfgSync.allow_tools ?? !!apiKey.allow_tools;
          ({ text: responseText, attachments } = await runner.sendApiMessage(sessionId, chatIdStr, trimmedMessage, {
            timeoutMs,
            allowTools: allowToolsSync,
            mediaFiles: validatedMediaFiles,
            model: modelStr,
            skipUserMessage,
          }));
        }
        const syncResult: Record<string, unknown> = {
          request_id: requestId,
          agent_id: agentId,
          response: responseText,
          session_id: sessionId,
          duration_ms: Date.now() - startTime,
        };
        if (attachments.length) syncResult['attachments'] = attachments;
        res.json(syncResult);
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code === 'TIMEOUT') {
          res.status(504).json({ error: 'Agent response timeout' });
        } else if (code === 'CONFLICT') {
          res.status(409).json({ error: 'Session already has a pending request' });
        } else {
          res.status(500).json({ error: 'Internal error' });
        }
      }
    }
  });

  /**
   * GET /api/v1/models
   *
   * List all supported Claude models from gateway config (falls back to defaults).
   */
  router.get('/v1/models', auth, (_req: Request, res: Response) => {
    res.json({ models: (models ?? []).map((m) => ({ id: m.id, name: m.label, alias: m.alias, contextWindow: m.contextWindow, multiplier: m.multiplier ?? 1 })) });
  });

  /**
   * GET /api/v1/agents
   *
   * List agents scoped to the API key. Admin keys see all agents.
   */
  router.get('/v1/agents', auth, (req: Request, res: Response) => {
    const apiKey = (req as AuthedRequest).apiKey;
    const agents = [...agentConfigs.entries()]
      .filter(([id]) => canAccessAgent(apiKey, id))
      .map(([id, cfg]) => ({
        id,
        name: cfg.name ?? null,
        description: cfg.description,
        model: cfg.claude?.model ?? null,
        allow_tools: cfg.allow_tools ?? false,
        avatarUrl: cfg.avatar ? `/api/v1/agents/${id}/avatar` : null,
        telegram_connected: !!cfg.telegram?.botToken,
        discord_connected: !!cfg.discord?.botToken,
        telegram_token_preview: cfg.telegram?.botToken ? maskToken(cfg.telegram.botToken) : null,
        discord_token_preview: cfg.discord?.botToken ? maskToken(cfg.discord.botToken) : null,
        telegram_dm_policy: cfg.telegram?.botToken ? readTelegramAccess(id).dmPolicy : null,
        // Orthogonal pairing toggle (mirrors line_pairing below). Absent ⇒ on.
        telegram_pairing: cfg.telegram?.botToken ? readTelegramAccess(id).pairing : null,
        // Group tier (mirrors line_group_* below). Null when Telegram not connected.
        telegram_group_policy: cfg.telegram?.botToken ? readTelegramAccess(id).groupPolicy : null,
        telegram_group_allowlist: cfg.telegram?.botToken ? readTelegramAccess(id).groupAllowlist : null,
        telegram_require_mention: cfg.telegram?.botToken ? readTelegramAccess(id).requireMention : null,
        discord_dm_policy: cfg.discord?.botToken ? readDiscordAccess(id).dmPolicy : null,
        discord_pairing: cfg.discord?.botToken ? readDiscordAccess(id).pairing : null,
        // Discord approves at guild level — guildAllowlist IS the group allowlist.
        discord_group_policy: cfg.discord?.botToken ? readDiscordAccess(id).groupPolicy : null,
        discord_guild_allowlist: cfg.discord?.botToken ? readDiscordAccess(id).guildAllowlist : null,
        discord_require_mention: cfg.discord?.botToken ? readDiscordAccess(id).requireMention : null,
        line_connected: !!cfg.line?.channelSecret,
        line_token_preview: cfg.line?.channelAccessToken ? maskToken(cfg.line.channelAccessToken) : null,
        line_webhook_path: cfg.line?.channelSecret ? `/webhooks/line/${id}` : null,
        // DM access (Tier 1). Stored directly in the line config (no separate
        // access file like Telegram). `dmPolicy` absent ⇒ closed/allowlist
        // semantics at runtime; surface the raw value (null when unset) so the
        // UI can render the effective state.
        line_dm_policy: cfg.line?.channelSecret ? (cfg.line?.dmPolicy ?? null) : null,
        line_dm_allowlist: cfg.line?.channelSecret ? (cfg.line?.dmAllowlist ?? []) : null,
        // Group/room access (Tier 3). Same storage + semantics as DM, keyed on
        // group/room ids. `requireMention` absent ⇒ true (only answer when the
        // bot is @mentioned in a group).
        line_group_policy: cfg.line?.channelSecret ? (cfg.line?.groupPolicy ?? null) : null,
        line_group_allowlist: cfg.line?.channelSecret ? (cfg.line?.groupAllowlist ?? []) : null,
        line_require_mention: cfg.line?.channelSecret ? (cfg.line?.requireMention ?? null) : null,
        // Pairing toggle (orthogonal to dm/groupPolicy). Absent ⇒ on; surface a
        // concrete boolean so the UI toggle reflects the effective default.
        line_pairing: cfg.line?.channelSecret ? (cfg.line?.pairing ?? true) : null,
      }));
    res.json({ agents });
  });

  /**
   * GET /api/v1/agents/sessions
   *
   * List all sessions across all agents. Admin only.
   * Queries each agent's history DB sequentially and returns a nested agents → sessions structure.
   */
  router.get('/v1/agents/sessions', auth, async (req: Request, res: Response) => {
    const apiKey = (req as AuthedRequest).apiKey;
    if (!isAdmin(apiKey)) {
      res.status(403).json({ error: 'Admin key required' });
      return;
    }
    const agents = await Promise.all(
      [...agentRunners.entries()].map(async ([agentId, runner]) => {
        const cfg = agentConfigs.get(agentId);
        const [sessions, metaMap] = await Promise.all([
          Promise.resolve(runner.getHistoryDb().listSessions()),
          runner.getAllSessionMeta(),
        ]);
        return {
          agentId,
          description: cfg?.description ?? '',
          sessions: sessions.map((s) => {
            const meta = metaMap.get(s.sessionId);
            return { ...s, sessionName: meta?.name ?? null };
          }),
        };
      }),
    );
    res.json({ agents });
  });

  /**
   * POST /api/v1/agents
   *
   * Create a new agent entry in config.json. Requires admin key.
   * Body: { id, description, model? }
   */
  router.post('/v1/agents', auth, async (req: Request, res: Response) => {
    const apiKey = (req as AuthedRequest).apiKey;
    if (!isAdmin(apiKey)) {
      res.status(403).json({ error: 'Admin key required to create agents' });
      return;
    }
    if (!configPath) {
      res.status(501).json({ error: 'Agent management not available (no configPath)' });
      return;
    }
    const body = req.body as { id?: unknown; description?: unknown; model?: unknown };
    const { id, description, model } = body;

    if (!id || typeof id !== 'string' || !AGENT_ID_RE.test(id)) {
      res.status(400).json({ error: 'id must match pattern [a-z][a-z0-9_-]{1,31}' });
      return;
    }
    if (!description || typeof description !== 'string' || !description.trim()) {
      res.status(400).json({ error: 'description is required' });
      return;
    }
    if (agentConfigs.has(id)) {
      res.status(409).json({ error: `Agent '${id}' already exists` });
      return;
    }

    const workspace = path.join('~', '.claude-gateway', 'agents', id, 'workspace');
    const workspaceAbs = path.join(os.homedir(), '.claude-gateway', 'agents', id, 'workspace');
    const newAgent: Record<string, unknown> = {
      id,
      description: (description as string).trim(),
      workspace,
      env: path.join('~', '.claude-gateway', 'agents', id, 'workspace', '.env'),
      claude: {
        model: typeof model === 'string' && model.trim() ? model.trim() : 'claude-sonnet-4-6',
        extraFlags: [],
      },
    };

    // Write config first — if this fails, no workspace is created (avoids orphaned directories).
    try {
      await writeAgentsToConfig(configPath, (agents) => agents.push(newAgent), id);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'DUPLICATE') {
        res.status(409).json({ error: `Agent '${id}' already exists` });
      } else {
        res.status(500).json({ error: `Failed to write config: ${(err as Error).message}` });
      }
      return;
    }

    // Update in-memory agentConfigs immediately so GET /api/v1/agents returns the new agent
    // without waiting for the file watcher (~500ms debounce).
    agentConfigs.set(id, {
      id,
      description: (description as string).trim(),
      workspace: workspaceAbs,
      env: path.join(workspaceAbs, '.env'),
      claude: {
        model: typeof model === 'string' && model.trim() ? model.trim() : 'claude-sonnet-4-6',
        extraFlags: [],
      },
    });

    // Config written successfully — now create workspace directory and stub files.
    const stubFiles: Record<string, string> = {
      'AGENTS.md': `# Agent: ${id}\n\n${(description as string).trim()}\n`,
      'SOUL.md': `# Soul\n\n`,
      'USER.md': `# User Profile\n\n`,
      'MEMORY.md': `# Memory\n\n`,
    };
    try {
      fs.mkdirSync(workspaceAbs, { recursive: true });
      for (const [filename, stub] of Object.entries(stubFiles)) {
        const filePath = path.join(workspaceAbs, filename);
        if (!fs.existsSync(filePath)) {
          fs.writeFileSync(filePath, stub, 'utf8');
        }
      }
    } catch (err) {
      // Config was already written — log the workspace failure but still return 201.
      // The agent is valid; workspace will be auto-created on next gateway start.
      console.error(`[api] Warning: agent '${id}' created in config but workspace setup failed: ${(err as Error).message}`);
    }

    res.status(201).json({ agent: { id, description: newAgent.description, model: (newAgent.claude as Record<string, unknown>).model } });
  });

  // ──────────────────────────────────────────────────────────────
  // Wizard API — stateful multi-step agent creation
  // ──────────────────────────────────────────────────────────────

  function getAgentsBaseDir(): string {
    return configPath
      ? path.join(path.dirname(configPath), 'agents')
      : path.join(os.homedir(), '.claude-gateway', 'agents');
  }

  function getTelegramStateDir(agentId: string): string {
    const agentsBase = getAgentsBaseDir();
    const cfg = agentConfigs.get(agentId);
    const workspace = cfg?.workspace
      ? (cfg.workspace.startsWith('~') ? path.join(os.homedir(), cfg.workspace.slice(1)) : cfg.workspace)
      : path.join(agentsBase, agentId, 'workspace');
    return path.join(workspace, '.telegram-state');
  }

  type TelegramAccess = {
    dmPolicy: 'open' | 'allowlist' | 'disabled';
    // Orthogonal pairing toggle (mirrors LINE). Meaningful only when
    // dmPolicy === 'allowlist'. Kept in sync with the runtime shape in
    // mcp/tools/telegram/pure.ts (migrateAccess).
    pairing: boolean;
    allowFrom: string[];
    // Group tier (mirrors LINE): flat allowlist + single mention gate.
    groupPolicy: 'open' | 'allowlist' | 'disabled';
    groupAllowlist: string[];
    requireMention: boolean;
    // Migration-only artifact — mirrors pure.ts Access — keep in sync. Never
    // written by any endpoint; only preserved so a pre-split group's per-user
    // restriction survives being read+written back through this API.
    legacyGroupAllowFrom?: Record<string, string[]>;
    pending: Record<string, { senderId: string; chatId: string; createdAt: number; expiresAt: number; replies: number; kind?: 'dm' | 'group' }>;
  };

  function readTelegramAccess(agentId: string): TelegramAccess {
    const accessFile = path.join(getTelegramStateDir(agentId), 'access.json');
    try {
      const raw = fs.readFileSync(accessFile, 'utf8');
      const parsed = JSON.parse(raw) as {
        dmPolicy?: string;
        pairing?: boolean;
        allowFrom?: string[];
        groups?: Record<string, { requireMention?: boolean; allowFrom?: string[] }>;
        groupPolicy?: string;
        groupAllowlist?: string[];
        requireMention?: boolean;
        legacyGroupAllowFrom?: Record<string, string[]>;
        pending?: TelegramAccess['pending'];
      };
      // Migrate the legacy 4-value dmPolicy (pairing folded in) to the split
      // model. SECURITY: a legacy 'allowlist' file was locked down → pairing:false
      // (an absent pairing on an existing file means pre-split); 'pairing' → mint on.
      // Mirrors migrateAccess() in mcp/tools/telegram/pure.ts — keep in sync.
      const legacy = parsed.dmPolicy;
      let dmPolicy: TelegramAccess['dmPolicy'];
      let pairing: boolean;
      if (legacy === 'pairing') {
        dmPolicy = 'allowlist';
        pairing = true;
      } else {
        dmPolicy = (legacy as TelegramAccess['dmPolicy']) ?? 'allowlist';
        pairing = parsed.pairing ?? false;
      }
      // Group tier: flatten legacy per-group `groups` map to a flat allowlist,
      // behavior-preserving (groups were closed-by-default). Mirrors pure.ts.
      // A group's per-user `allowFrom` override has no flat-model equivalent,
      // but it's a real restriction — preserve it (mirrors
      // deriveLegacyGroupAllowFrom in pure.ts, keep in sync) rather than
      // silently dropping it and widening the group to every member.
      const groupAllowlist = parsed.groupAllowlist ?? Object.keys(parsed.groups ?? {});
      const groupPolicy = (parsed.groupPolicy as TelegramAccess['groupPolicy']) ?? 'allowlist';
      const requireMention = parsed.requireMention ?? true;
      let legacyGroupAllowFrom = parsed.legacyGroupAllowFrom;
      if (!legacyGroupAllowFrom && parsed.groups) {
        const derived: Record<string, string[]> = {};
        for (const [groupId, g] of Object.entries(parsed.groups)) {
          if (g.allowFrom && g.allowFrom.length > 0) derived[groupId] = [...g.allowFrom];
        }
        if (Object.keys(derived).length > 0) legacyGroupAllowFrom = derived;
      }
      return {
        dmPolicy,
        pairing,
        allowFrom: parsed.allowFrom ?? [],
        groupPolicy,
        groupAllowlist,
        requireMention,
        legacyGroupAllowFrom,
        pending: parsed.pending ?? {},
      };
    } catch {
      // Brand-new agent (no file): closed base + pairing on (capture owner id).
      return { dmPolicy: 'allowlist', pairing: true, allowFrom: [], groupPolicy: 'allowlist', groupAllowlist: [], requireMention: true, pending: {} };
    }
  }

  function writeTelegramAccess(agentId: string, access: TelegramAccess): void {
    const stateDir = getTelegramStateDir(agentId);
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'access.json'), JSON.stringify(access, null, 2));
    } catch (err) {
      throw new Error(`Failed to write Telegram access config: ${(err as Error).message}`);
    }
  }

  function getDiscordStateDir(agentId: string): string {
    const agentsBase = getAgentsBaseDir();
    const cfg = agentConfigs.get(agentId);
    const workspace = cfg?.workspace
      ? (cfg.workspace.startsWith('~') ? path.join(os.homedir(), cfg.workspace.slice(1)) : cfg.workspace)
      : path.join(agentsBase, agentId, 'workspace');
    return path.join(workspace, '.discord-state');
  }

  type DiscordAccessShape = {
    dmPolicy: 'open' | 'allowlist' | 'disabled';
    // Orthogonal pairing toggle (mirrors Telegram). Meaningful only when
    // dmPolicy === 'allowlist'. Kept in sync with the runtime shape in
    // mcp/tools/discord/access.ts (migrateAccess).
    pairing: boolean;
    allowFrom: string[];
    // Guild tier (mirrors LINE): guildAllowlist IS the group allowlist.
    groupPolicy: 'open' | 'allowlist' | 'disabled';
    requireMention: boolean;
    guildAllowlist: string[];
    channelAllowlist: string[];
    roleAllowlist: string[];
    pending: Record<string, { senderId: string; channelId: string; createdAt: number; expiresAt: number; replies: number; kind?: 'dm' | 'guild'; guildId?: string }>;
  };

  function readDiscordAccess(agentId: string): DiscordAccessShape {
    const accessFile = path.join(getDiscordStateDir(agentId), 'access.json');
    try {
      const raw = fs.readFileSync(accessFile, 'utf8');
      const parsed = JSON.parse(raw) as {
        dmPolicy?: string;
        pairing?: boolean;
        allowFrom?: string[];
        groupPolicy?: string;
        requireMention?: boolean;
        guildAllowlist?: string[];
        channelAllowlist?: string[];
        roleAllowlist?: string[];
        pending?: DiscordAccessShape['pending'];
      };
      // Migrate the legacy fused dmPolicy ('pairing' folded pairing in) to the
      // split model. SECURITY: a legacy 'allowlist' file was locked down →
      // pairing:false (an absent pairing on an existing file means pre-split);
      // 'pairing' → mint on. Mirrors migrateAccess() in
      // mcp/tools/discord/access.ts — keep in sync.
      const legacy = parsed.dmPolicy;
      let dmPolicy: DiscordAccessShape['dmPolicy'];
      let pairing: boolean;
      if (legacy === 'pairing') {
        dmPolicy = 'allowlist';
        pairing = true;
      } else {
        dmPolicy = (legacy as DiscordAccessShape['dmPolicy']) ?? 'allowlist';
        pairing = parsed.pairing ?? false;
      }
      // Guild tier migration is behavior-preserving: today an empty
      // guildAllowlist means "deliver to all guilds" → derive 'open' when empty,
      // 'allowlist' when non-empty; requireMention defaults false for existing
      // files (no prior mention gate). Mirrors discord/access.ts migrateAccess.
      const guildAllowlist = parsed.guildAllowlist ?? [];
      const groupPolicy = (parsed.groupPolicy as DiscordAccessShape['groupPolicy'])
        ?? (guildAllowlist.length > 0 ? 'allowlist' : 'open');
      const requireMention = parsed.requireMention ?? false;
      return {
        dmPolicy,
        pairing,
        allowFrom: parsed.allowFrom ?? [],
        groupPolicy,
        requireMention,
        guildAllowlist,
        channelAllowlist: parsed.channelAllowlist ?? [],
        roleAllowlist: parsed.roleAllowlist ?? [],
        pending: parsed.pending ?? {},
      };
    } catch {
      // Brand-new agent (no file): secure defaults (mirrors defaultAccess()).
      return { dmPolicy: 'allowlist', pairing: true, allowFrom: [], groupPolicy: 'allowlist', requireMention: true, guildAllowlist: [], channelAllowlist: [], roleAllowlist: [], pending: {} };
    }
  }

  function writeDiscordAccess(agentId: string, access: DiscordAccessShape): void {
    const stateDir = getDiscordStateDir(agentId);
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'access.json'), JSON.stringify(access, null, 2));
    } catch (err) {
      throw new Error(`Failed to write Discord access config: ${(err as Error).message}`);
    }
  }

  /**
   * POST /api/v1/agents/wizard/start
   * Start wizard: call Claude to generate workspace files, return wizardId + preview.
   */
  router.post('/v1/agents/wizard/start', auth, async (req: Request, res: Response) => {
    const apiKey = (req as AuthedRequest).apiKey;
    if (!isAdmin(apiKey)) { res.status(403).json({ error: 'Admin key required' }); return; }
    if (!configPath) { res.status(501).json({ error: 'Agent management not available (no configPath)' }); return; }

    const body = req.body as { id?: unknown; prompt?: unknown };
    const { id, prompt } = body;

    if (!id || typeof id !== 'string' || !AGENT_ID_RE.test(id)) {
      res.status(400).json({ error: 'id must match pattern [a-z][a-z0-9_-]{1,31}' });
      return;
    }
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }
    if (agentConfigs.has(id)) {
      res.status(409).json({ error: `Agent '${id}' already exists` });
      return;
    }
    if (wizardStore.findByAgentId(id)) {
      res.status(409).json({ error: `Wizard for agent '${id}' is already in progress` });
      return;
    }

    if (wizardStartsInFlight >= WIZARD_MAX_CONCURRENT) {
      res.status(429).json({ error: 'Too many wizard starts in progress, please retry later' });
      return;
    }

    const agentName = id.charAt(0).toUpperCase() + id.slice(1);
    let rawOutput: string;
    wizardStartsInFlight++;
    try {
      const genPrompt = buildGenerationPrompt(agentName, prompt.trim());
      rawOutput = await runClaude(genPrompt);
    } catch (err) {
      res.status(500).json({ error: `Claude generation failed: ${(err as Error).message}` });
      return;
    } finally {
      wizardStartsInFlight--;
    }

    let raw = rawOutput.trim();
    const fenceMatch = raw.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/);
    if (fenceMatch) raw = (fenceMatch[1] ?? '').trim();

    const { emoji: signatureEmoji, rest } = extractLeadingEmoji(raw);
    if (signatureEmoji) raw = rest;

    const parsedFiles = parseGeneratedFiles(raw);
    if (!parsedFiles.has('AGENTS.md')) {
      const headingIdx = raw.indexOf('# ');
      if (headingIdx >= 0) {
        const content = raw.slice(headingIdx).trim();
        if (content.length > 50) parsedFiles.set('AGENTS.md', content);
      }
    }
    for (const f of ['MEMORY.md', 'SOUL.md', 'USER.md'] as const) {
      if (!parsedFiles.has(f)) parsedFiles.set(f, '');
    }
    if (!parsedFiles.has('AGENTS.md')) {
      parsedFiles.set('AGENTS.md', `# Agent: ${id}\n\n${prompt.trim().slice(0, 400)}\n`);
    }

    const files = Object.fromEntries(parsedFiles);
    const state = wizardStore.create(id, prompt.trim(), files);
    if (signatureEmoji) wizardStore.update(state.wizardId, { signatureEmoji });

    res.status(201).json({
      wizardId: state.wizardId,
      agentId: id,
      files,
      expiresAt: new Date(state.expiresAt).toISOString(),
    });
  });

  /**
   * PUT /api/v1/agents/wizard/:wizardId/avatar
   * Upload avatar into wizard state (in-memory until confirm).
   */
  router.put('/v1/agents/wizard/:wizardId/avatar', auth, async (req: Request, res: Response) => {
    const apiKey = (req as AuthedRequest).apiKey;
    if (!isAdmin(apiKey)) { res.status(403).json({ error: 'Admin key required' }); return; }

    const { wizardId } = req.params as { wizardId: string };
    const wizard = wizardStore.get(wizardId);
    if (!wizard) { res.status(404).json({ error: 'Wizard not found or expired' }); return; }
    if (wizard.step !== 'pending') { res.status(409).json({ error: 'Avatar must be uploaded before confirm' }); return; }

    let buf: Buffer;
    try {
      buf = await readRawBody(req, res, AVATAR_MAX_BYTES);
    } catch {
      return;
    }
    if (!buf.length) { res.status(400).json({ error: 'No file body received' }); return; }
    if (buf.length < 12) { res.status(400).json({ error: 'File too small to detect type' }); return; }

    const mime = detectMimeFromMagic(buf.subarray(0, 12));
    if (!mime || !AVATAR_MIME_EXT[mime]) {
      res.status(415).json({ error: 'Unsupported image type. Allowed: jpeg, png, gif, webp' });
      return;
    }
    wizardStore.update(wizardId, { avatarData: buf, avatarMime: mime });
    res.json({ preview: true });
  });

  /**
   * POST /api/v1/agents/wizard/:wizardId/confirm
   * Write workspace files + optional avatar to disk, add agent to config.json.
   */
  router.post('/v1/agents/wizard/:wizardId/confirm', auth, async (req: Request, res: Response) => {
    const apiKey = (req as AuthedRequest).apiKey;
    if (!isAdmin(apiKey)) { res.status(403).json({ error: 'Admin key required' }); return; }
    if (!configPath) { res.status(501).json({ error: 'Agent management not available (no configPath)' }); return; }

    const { wizardId } = req.params as { wizardId: string };
    const wizard = wizardStore.get(wizardId);
    if (!wizard) { res.status(404).json({ error: 'Wizard not found or expired' }); return; }
    if (wizard.step !== 'pending') { res.status(409).json({ error: `Wizard already in step: ${wizard.step}` }); return; }

    const body = req.body as { files?: unknown };
    const rawFiles = typeof body.files === 'object' && body.files !== null
      ? body.files as Record<string, unknown>
      : wizard.files;

    const sanitizedFiles: Record<string, string> = {};
    for (const [name, content] of Object.entries(rawFiles)) {
      if (typeof name !== 'string' || typeof content !== 'string') continue;
      if (!/^[A-Z][A-Z0-9_.-]*\.md$/i.test(name)) continue;
      sanitizedFiles[name] = content;
    }
    if (!sanitizedFiles['AGENTS.md']) {
      res.status(400).json({ error: 'AGENTS.md is required in files' });
      return;
    }

    const agentId = wizard.agentId;
    if (agentConfigs.has(agentId)) {
      res.status(409).json({ error: `Agent '${agentId}' already exists` });
      return;
    }

    const agentsBase = getAgentsBaseDir();
    const agentDirAbs = path.join(agentsBase, agentId);
    const workspaceDirAbs = path.join(agentDirAbs, 'workspace');
    const resolvedWorkspace = path.resolve(workspaceDirAbs);

    try {
      fs.mkdirSync(workspaceDirAbs, { recursive: true });
      for (const [filename, content] of Object.entries(sanitizedFiles)) {
        const filePath = path.resolve(path.join(workspaceDirAbs, filename));
        if (!filePath.startsWith(resolvedWorkspace + path.sep)) continue;
        await fsp.writeFile(filePath, content, 'utf-8');
      }
    } catch (err) {
      res.status(500).json({ error: `Failed to write workspace: ${(err as Error).message}` });
      return;
    }

    let avatarFilename: string | undefined;
    if (wizard.avatarData && wizard.avatarMime && AVATAR_MIME_EXT[wizard.avatarMime]) {
      const ext = AVATAR_MIME_EXT[wizard.avatarMime];
      avatarFilename = `avatar.${ext}`;
      try {
        await fsp.writeFile(path.join(agentDirAbs, avatarFilename), wizard.avatarData);
      } catch (err) {
        console.error(`[wizard] Failed to write avatar for '${agentId}': ${(err as Error).message}`);
        avatarFilename = undefined;
      }
    }

    const defaultModel = 'claude-sonnet-4-6';
    const newAgent: Record<string, unknown> = {
      id: agentId,
      description: wizard.prompt.slice(0, 200).trim(),
      workspace: absToTildePath(workspaceDirAbs),
      env: absToTildePath(path.join(workspaceDirAbs, '.env')),
      claude: { model: defaultModel, extraFlags: [] },
    };
    if (wizard.signatureEmoji) newAgent.signatureEmoji = wizard.signatureEmoji;
    if (avatarFilename) newAgent.avatar = avatarFilename;

    try {
      await writeAgentsToConfig(configPath, (agents) => agents.push(newAgent), agentId);
    } catch (err) {
      const code = (err as { code?: string }).code;
      res.status(code === 'DUPLICATE' ? 409 : 500).json({
        error: code === 'DUPLICATE' ? `Agent '${agentId}' already exists` : `Failed to write config: ${(err as Error).message}`,
      });
      return;
    }

    // Update in-memory agentConfigs immediately so GET /api/v1/agents returns the new agent
    // without waiting for the file watcher (~500ms debounce).
    agentConfigs.set(agentId, {
      id: agentId,
      description: wizard.prompt.slice(0, 200).trim(),
      workspace: workspaceDirAbs,
      env: path.join(workspaceDirAbs, '.env'),
      claude: { model: defaultModel, extraFlags: [] },
      ...(wizard.signatureEmoji ? { signatureEmoji: wizard.signatureEmoji } : {}),
      ...(avatarFilename ? { avatar: avatarFilename } : {}),
    });

    wizardStore.update(wizardId, { step: 'confirmed' });
    const avatarUrl = avatarFilename ? `/api/v1/agents/${agentId}/avatar` : null;
    res.json({
      agentId,
      avatarUrl,
      next: `channel via POST /api/v1/agents/wizard/${wizardId}/channel, or skip via POST /api/v1/agents/wizard/${wizardId}/complete`,
    });
  });

  /**
   * POST /api/v1/agents/wizard/:wizardId/channel
   * Verify bot token and generate pairing code.
   */
  router.post('/v1/agents/wizard/:wizardId/channel', auth, async (req: Request, res: Response) => {
    const apiKey = (req as AuthedRequest).apiKey;
    if (!isAdmin(apiKey)) { res.status(403).json({ error: 'Admin key required' }); return; }

    const { wizardId } = req.params as { wizardId: string };
    const wizard = wizardStore.get(wizardId);
    if (!wizard) { res.status(404).json({ error: 'Wizard not found or expired' }); return; }
    if (wizard.step !== 'confirmed') { res.status(409).json({ error: `Expected step 'confirmed', got '${wizard.step}'` }); return; }

    const body = req.body as { channel?: unknown; botToken?: unknown };
    const channel = body.channel;
    const botToken = typeof body.botToken === 'string' ? body.botToken.trim() : '';

    if (channel !== 'telegram' && channel !== 'discord') {
      res.status(400).json({ error: "channel must be 'telegram' or 'discord'" });
      return;
    }
    if (!botToken) {
      res.status(400).json({ error: 'botToken is required' });
      return;
    }

    let botName: string;
    if (channel === 'telegram') {
      const username = await verifyTelegramToken(botToken);
      if (!username) {
        res.status(400).json({ error: 'Invalid Telegram bot token (getMe failed)' });
        return;
      }
      botName = `@${username}`;
    } else {
      try {
        const r = await fetch('https://discord.com/api/v10/users/@me', {
          headers: { Authorization: `Bot ${botToken}` },
        });
        const json = await r.json() as { username?: string };
        if (!r.ok || !json.username) {
          res.status(400).json({ error: 'Invalid Discord bot token' });
          return;
        }
        botName = `@${json.username}`;
      } catch {
        res.status(400).json({ error: 'Failed to verify Discord bot token' });
        return;
      }
    }

    // Token-only connect: persist the bot token to the agent config now. The
    // wizard no longer mints/relays a pairing code — pairing is incoming-first
    // and happens later on the edit-page Channels card (user DMs the bot → code
    // lands in Pending → admin approves). This mirrors the LINE flow.
    if (!configPath) { res.status(501).json({ error: 'Agent management not available (no configPath)' }); return; }
    try {
      await writeAgentsToConfig(configPath, (agents) => {
        const agent = (agents as Record<string, unknown>[]).find((a) => a.id === wizard.agentId);
        if (agent) {
          if (channel === 'telegram') agent.telegram = { botToken };
          else agent.discord = { botToken };
        }
      });
    } catch (err) {
      res.status(500).json({ error: `Failed to update config: ${(err as Error).message}` });
      return;
    }

    // Seed a secure access.json immediately for a brand-new Discord connection.
    // Without this, the receiver's env-derived fallback (DISCORD_GUILD_ALLOWLIST
    // empty ⇒ groupPolicy 'open') answers in any server with no pairing/approval —
    // only DMs were ever gated. Skip if a file already exists (don't clobber a
    // prior connect/reconnect).
    if (channel === 'discord') {
      const accessFile = path.join(getDiscordStateDir(wizard.agentId!), 'access.json');
      if (!fs.existsSync(accessFile)) {
        try {
          writeDiscordAccess(wizard.agentId!, {
            dmPolicy: 'allowlist', pairing: true, allowFrom: [],
            groupPolicy: 'allowlist', requireMention: true,
            guildAllowlist: [], channelAllowlist: [], roleAllowlist: [], pending: {},
          });
        } catch { /* non-fatal — receiver still has a (less safe) env fallback */ }
      }
    }

    wizardStore.update(wizardId, {
      step: 'complete',
      channel: channel as 'telegram' | 'discord',
      botToken,
    });

    // Hot-start the receiver so the bot comes online immediately without a
    // gateway restart. The first DM from the owner then produces a pairing code
    // they approve on the edit-page Channels card.
    const runner = agentRunners.get(wizard.agentId!);
    if (runner) {
      const base = runner.getAgentConfig();
      if (channel === 'telegram') {
        runner.updateAgentConfig({ ...base, telegram: { botToken } });
        runner.startTelegramReceiver();
      } else {
        runner.updateAgentConfig({ ...base, discord: { botToken } });
        runner.startDiscordReceiver();
      }
    }

    res.json({ channel, botName, connected: true });
  });

  /**
   * POST /api/v1/agents/wizard/:wizardId/complete
   * Skip channel setup and finalize wizard.
   */
  router.post('/v1/agents/wizard/:wizardId/complete', auth, (req: Request, res: Response) => {
    const apiKey = (req as AuthedRequest).apiKey;
    if (!isAdmin(apiKey)) { res.status(403).json({ error: 'Admin key required' }); return; }

    const { wizardId } = req.params as { wizardId: string };
    const wizard = wizardStore.get(wizardId);
    if (!wizard) { res.status(404).json({ error: 'Wizard not found or expired' }); return; }
    if (wizard.step === 'pending') {
      res.status(409).json({ error: 'Must confirm workspace before completing wizard' });
      return;
    }

    const agentId = wizard.agentId;
    wizardStore.delete(wizardId);
    res.json({ agentId });
  });

  /**
   * PATCH /api/v1/agents/:agentId
   *
   * Update agent name, description, and/or model. Requires write access to the agent.
   * Body: { name?, description?, model? }
   */
  router.patch('/v1/agents/:agentId', auth, async (req: Request, res: Response) => {
    const apiKey = (req as AuthedRequest).apiKey;
    const { agentId } = req.params as { agentId: string };
    if (!canWriteAgent(apiKey, agentId)) {
      res.status(403).json({ error: 'Write permission required' });
      return;
    }
    if (!configPath) {
      res.status(501).json({ error: 'Agent management not available (no configPath)' });
      return;
    }
    if (!agentConfigs.has(agentId)) {
      res.status(404).json({ error: `Agent '${agentId}' not found` });
      return;
    }

    const body = req.body as { name?: unknown; description?: unknown; model?: unknown; allow_tools?: unknown; telegram_bot_token?: unknown; discord_bot_token?: unknown; line_channel_access_token?: unknown; line_channel_secret?: unknown; line_dm_policy?: unknown; line_dm_allowlist?: unknown; line_group_policy?: unknown; line_group_allowlist?: unknown; line_require_mention?: unknown; line_pairing?: unknown };
    const { name, description, model, allow_tools, telegram_bot_token, discord_bot_token, line_channel_access_token, line_channel_secret, line_dm_policy, line_dm_allowlist, line_group_policy, line_group_allowlist, line_require_mention, line_pairing } = body;
    if (name !== undefined && name !== null && typeof name !== 'string') {
      res.status(400).json({ error: 'name must be a string or null' });
      return;
    }
    if (description !== undefined && (typeof description !== 'string' || !description.trim())) {
      res.status(400).json({ error: 'description must be a non-empty string' });
      return;
    }
    if (model !== undefined && (typeof model !== 'string' || !model.trim())) {
      res.status(400).json({ error: 'model must be a non-empty string' });
      return;
    }
    if (allow_tools !== undefined && typeof allow_tools !== 'boolean') {
      res.status(400).json({ error: 'allow_tools must be a boolean' });
      return;
    }
    if (telegram_bot_token !== undefined && telegram_bot_token !== null && typeof telegram_bot_token !== 'string') {
      res.status(400).json({ error: 'telegram_bot_token must be a string or null' });
      return;
    }
    if (discord_bot_token !== undefined && discord_bot_token !== null && typeof discord_bot_token !== 'string') {
      res.status(400).json({ error: 'discord_bot_token must be a string or null' });
      return;
    }
    if (line_channel_access_token !== undefined && line_channel_access_token !== null && typeof line_channel_access_token !== 'string') {
      res.status(400).json({ error: 'line_channel_access_token must be a string or null' });
      return;
    }
    if (line_channel_secret !== undefined && line_channel_secret !== null && typeof line_channel_secret !== 'string') {
      res.status(400).json({ error: 'line_channel_secret must be a string or null' });
      return;
    }
    // LINE needs BOTH credentials together. Reject a half-set (one without the other),
    // unless both are being cleared (disconnect).
    const lineTouched = line_channel_access_token !== undefined || line_channel_secret !== undefined;
    if (lineTouched) {
      const at = typeof line_channel_access_token === 'string' ? line_channel_access_token.trim() : '';
      const sec = typeof line_channel_secret === 'string' ? line_channel_secret.trim() : '';
      const bothSet = at !== '' && sec !== '';
      const bothClear = at === '' && sec === '';
      if (!bothSet && !bothClear) {
        res.status(400).json({ error: 'line_channel_access_token and line_channel_secret must be provided together' });
        return;
      }
    }
    // LINE DM access control (Tier 1). Validated independently of the credentials so
    // policy/allowlist can be changed without re-sending the tokens.
    if (line_dm_policy !== undefined && line_dm_policy !== null &&
        !(typeof line_dm_policy === 'string' && ['open', 'allowlist', 'disabled'].includes(line_dm_policy))) {
      res.status(400).json({ error: "line_dm_policy must be 'open', 'allowlist', 'disabled', or null" });
      return;
    }
    if (line_dm_allowlist !== undefined && line_dm_allowlist !== null &&
        !(Array.isArray(line_dm_allowlist) && line_dm_allowlist.every((u) => typeof u === 'string'))) {
      res.status(400).json({ error: 'line_dm_allowlist must be an array of strings or null' });
      return;
    }
    // LINE group/room access control (Tier 3). Same independence as DM access.
    if (line_group_policy !== undefined && line_group_policy !== null &&
        !(typeof line_group_policy === 'string' && ['open', 'allowlist', 'disabled'].includes(line_group_policy))) {
      res.status(400).json({ error: "line_group_policy must be 'open', 'allowlist', 'disabled', or null" });
      return;
    }
    if (line_group_allowlist !== undefined && line_group_allowlist !== null &&
        !(Array.isArray(line_group_allowlist) && line_group_allowlist.every((u) => typeof u === 'string'))) {
      res.status(400).json({ error: 'line_group_allowlist must be an array of strings or null' });
      return;
    }
    if (line_require_mention !== undefined && line_require_mention !== null &&
        typeof line_require_mention !== 'boolean') {
      res.status(400).json({ error: 'line_require_mention must be a boolean or null' });
      return;
    }
    if (line_pairing !== undefined && line_pairing !== null &&
        typeof line_pairing !== 'boolean') {
      res.status(400).json({ error: 'line_pairing must be a boolean or null' });
      return;
    }
    const lineAccessTouched = line_dm_policy !== undefined || line_dm_allowlist !== undefined ||
      line_group_policy !== undefined || line_group_allowlist !== undefined || line_require_mention !== undefined ||
      line_pairing !== undefined;

    try {
      await writeAgentsToConfig(configPath, (agents) => {
        const agent = (agents as Record<string, unknown>[]).find((a) => a.id === agentId);
        if (!agent) return;
        if (name !== undefined) {
          const trimmed = typeof name === 'string' ? name.trim() : '';
          if (trimmed === '') delete (agent as Record<string, unknown>).name;
          else agent.name = trimmed;
        }
        if (description !== undefined) agent.description = (description as string).trim();
        if (model !== undefined) {
          const claude = agent.claude as Record<string, unknown> | undefined;
          if (claude) claude.model = (model as string).trim();
        }
        if (allow_tools !== undefined) agent.allow_tools = allow_tools;
        if (telegram_bot_token !== undefined) {
          if (telegram_bot_token === null || telegram_bot_token === '') {
            delete (agent as Record<string, unknown>).telegram;
          } else {
            agent.telegram = { botToken: (telegram_bot_token as string).trim() };
          }
        }
        if (discord_bot_token !== undefined) {
          if (discord_bot_token === null || discord_bot_token === '') {
            delete (agent as Record<string, unknown>).discord;
          } else {
            const existing = agent.discord as Record<string, unknown> | undefined;
            agent.discord = { ...(existing ?? {}), botToken: (discord_bot_token as string).trim() };
          }
        }
        if (lineTouched) {
          const at = typeof line_channel_access_token === 'string' ? line_channel_access_token.trim() : '';
          const sec = typeof line_channel_secret === 'string' ? line_channel_secret.trim() : '';
          if (at === '' && sec === '') {
            delete (agent as Record<string, unknown>).line;
          } else {
            const existing = agent.line as Record<string, unknown> | undefined;
            agent.line = { ...(existing ?? {}), channelAccessToken: at, channelSecret: sec };
          }
        }
        // DM access — merge into the existing line block (re-read after the token
        // block above, which may have just created or deleted it). Skip silently
        // when no line channel exists; policy without credentials is meaningless.
        if (lineAccessTouched) {
          const existing = agent.line as Record<string, unknown> | undefined;
          if (existing) {
            if (line_dm_policy !== undefined) {
              if (line_dm_policy === null) delete existing.dmPolicy;
              else existing.dmPolicy = line_dm_policy;
            }
            if (line_dm_allowlist !== undefined) {
              if (line_dm_allowlist === null) delete existing.dmAllowlist;
              else existing.dmAllowlist = line_dm_allowlist;
            }
            if (line_group_policy !== undefined) {
              if (line_group_policy === null) delete existing.groupPolicy;
              else existing.groupPolicy = line_group_policy;
            }
            if (line_group_allowlist !== undefined) {
              if (line_group_allowlist === null) delete existing.groupAllowlist;
              else existing.groupAllowlist = line_group_allowlist;
            }
            if (line_require_mention !== undefined) {
              if (line_require_mention === null) delete existing.requireMention;
              else existing.requireMention = line_require_mention;
            }
            if (line_pairing !== undefined) {
              if (line_pairing === null) delete existing.pairing;
              else existing.pairing = line_pairing;
            }
          }
        }
      });
    } catch (err) {
      res.status(500).json({ error: `Failed to write config: ${(err as Error).message}` });
      return;
    }

    // Sync in-memory map with what was written to disk
    const cfg = agentConfigs.get(agentId)!;
    if (name !== undefined) {
      const trimmed = typeof name === 'string' ? name.trim() : '';
      cfg.name = trimmed === '' ? null : trimmed;
    }
    if (description !== undefined) cfg.description = (description as string).trim();
    if (model !== undefined && cfg.claude) cfg.claude.model = (model as string).trim();
    if (allow_tools !== undefined) cfg.allow_tools = allow_tools;
    if (telegram_bot_token !== undefined) {
      const token = typeof telegram_bot_token === 'string' ? telegram_bot_token.trim() : null;
      if (token) {
        cfg.telegram = { botToken: token };
        // Hot-start receiver if not already running
        const runner = agentRunners.get(agentId);
        if (runner) {
          runner.updateAgentConfig(cfg);
          runner.startTelegramReceiver();
        }
      } else {
        delete cfg.telegram;
        agentRunners.get(agentId)?.stopTelegramReceiver();
      }
    }
    if (discord_bot_token !== undefined) {
      const token = typeof discord_bot_token === 'string' ? discord_bot_token.trim() : null;
      if (token) {
        const isNewConnection = !cfg.discord?.botToken;
        cfg.discord = { ...(cfg.discord ?? {}), botToken: token };
        // Seed a secure access.json for a brand-new connection — see matching
        // comment on the wizard /channel handler for why this can't be left to
        // the receiver's env-derived fallback.
        if (isNewConnection) {
          const accessFile = path.join(getDiscordStateDir(agentId), 'access.json');
          if (!fs.existsSync(accessFile)) {
            try {
              writeDiscordAccess(agentId, {
                dmPolicy: 'allowlist', pairing: true, allowFrom: [],
                groupPolicy: 'allowlist', requireMention: true,
                guildAllowlist: [], channelAllowlist: [], roleAllowlist: [], pending: {},
              });
            } catch { /* non-fatal — receiver still has a (less safe) env fallback */ }
          }
        }
        // Hot-start receiver if not already running
        const runner = agentRunners.get(agentId);
        if (runner) {
          runner.updateAgentConfig(cfg);
          runner.startDiscordReceiver();
        }
      } else {
        delete cfg.discord;
        agentRunners.get(agentId)?.stopDiscordReceiver();
      }
    }
    if (lineTouched) {
      const at = typeof line_channel_access_token === 'string' ? line_channel_access_token.trim() : '';
      const sec = typeof line_channel_secret === 'string' ? line_channel_secret.trim() : '';
      if (at && sec) {
        cfg.line = { ...(cfg.line ?? {}), channelAccessToken: at, channelSecret: sec };
      } else {
        delete cfg.line;
      }
      // LINE is webhook-based — no receiver to start/stop. The webhook router reads
      // config live via runner.getAgentConfig(); just keep the runner's copy in sync.
      agentRunners.get(agentId)?.updateAgentConfig(cfg);
    }
    if (lineAccessTouched && cfg.line) {
      if (line_dm_policy !== undefined) {
        if (line_dm_policy === null) delete cfg.line.dmPolicy;
        else cfg.line.dmPolicy = line_dm_policy as 'open' | 'allowlist' | 'disabled';
      }
      if (line_dm_allowlist !== undefined) {
        if (line_dm_allowlist === null) delete cfg.line.dmAllowlist;
        else cfg.line.dmAllowlist = line_dm_allowlist as string[];
      }
      if (line_group_policy !== undefined) {
        if (line_group_policy === null) delete cfg.line.groupPolicy;
        else cfg.line.groupPolicy = line_group_policy as 'open' | 'allowlist' | 'disabled';
      }
      if (line_group_allowlist !== undefined) {
        if (line_group_allowlist === null) delete cfg.line.groupAllowlist;
        else cfg.line.groupAllowlist = line_group_allowlist as string[];
      }
      if (line_require_mention !== undefined) {
        if (line_require_mention === null) delete cfg.line.requireMention;
        else cfg.line.requireMention = line_require_mention as boolean;
      }
      if (line_pairing !== undefined) {
        if (line_pairing === null) delete cfg.line.pairing;
        else cfg.line.pairing = line_pairing as boolean;
      }
      agentRunners.get(agentId)?.updateAgentConfig(cfg);
      // Anyone just added to an allowlist is now allowed — drop them from the
      // in-memory knock list so the discovery UI stops surfacing them.
      if (Array.isArray(line_dm_allowlist)) {
        for (const userId of line_dm_allowlist) clearPendingSender(agentId, userId);
      }
      if (Array.isArray(line_group_allowlist)) {
        for (const id of line_group_allowlist) clearPendingSender(agentId, id);
      }
    }

    res.json({
      agent: {
        id: agentId,
        name: cfg.name ?? null,
        description: cfg.description,
        model: cfg.claude?.model,
        allow_tools: cfg.allow_tools ?? false,
        telegram_connected: !!cfg.telegram?.botToken,
        discord_connected: !!cfg.discord?.botToken,
        telegram_token_preview: cfg.telegram?.botToken ? maskToken(cfg.telegram.botToken) : null,
        discord_token_preview: cfg.discord?.botToken ? maskToken(cfg.discord.botToken) : null,
        telegram_dm_policy: cfg.telegram?.botToken ? readTelegramAccess(agentId).dmPolicy : null,
        telegram_pairing: cfg.telegram?.botToken ? readTelegramAccess(agentId).pairing : null,
        telegram_group_policy: cfg.telegram?.botToken ? readTelegramAccess(agentId).groupPolicy : null,
        telegram_group_allowlist: cfg.telegram?.botToken ? readTelegramAccess(agentId).groupAllowlist : null,
        telegram_require_mention: cfg.telegram?.botToken ? readTelegramAccess(agentId).requireMention : null,
        discord_dm_policy: cfg.discord?.botToken ? readDiscordAccess(agentId).dmPolicy : null,
        discord_pairing: cfg.discord?.botToken ? readDiscordAccess(agentId).pairing : null,
        discord_group_policy: cfg.discord?.botToken ? readDiscordAccess(agentId).groupPolicy : null,
        discord_guild_allowlist: cfg.discord?.botToken ? readDiscordAccess(agentId).guildAllowlist : null,
        discord_require_mention: cfg.discord?.botToken ? readDiscordAccess(agentId).requireMention : null,
        line_connected: !!cfg.line?.channelSecret,
        line_token_preview: cfg.line?.channelAccessToken ? maskToken(cfg.line.channelAccessToken) : null,
        line_webhook_path: cfg.line?.channelSecret ? `/webhooks/line/${agentId}` : null,
      },
    });
  });

  /**
   * GET /api/v1/agents/:agentId/telegram/pending
   * List pending Telegram pairing requests (non-expired).
   */
  router.get('/v1/agents/:agentId/telegram/pending', auth, (req: Request, res: Response) => {
    const { agentId } = req.params as { agentId: string };
    const apiKey = (req as AuthedRequest).apiKey;
    if (!isAdmin(apiKey)) { res.status(403).json({ error: 'Admin key required' }); return; }
    if (!agentConfigs.has(agentId)) { res.status(404).json({ error: `Agent '${agentId}' not found` }); return; }
    const access = readTelegramAccess(agentId);
    const now = Date.now();
    const expired = Object.keys(access.pending).filter((code) => access.pending[code].expiresAt <= now);
    if (expired.length > 0) {
      expired.forEach((code) => { delete access.pending[code]; });
      try { writeTelegramAccess(agentId, access); } catch { /* non-fatal cleanup */ }
    }
    const pending = Object.entries(access.pending)
      .map(([code, p]) => ({ code, senderId: p.senderId, chatId: p.chatId, createdAt: p.createdAt, expiresAt: p.expiresAt, kind: p.kind ?? 'dm' }));
    res.json({ pending });
  });

  /**
   * POST /api/v1/agents/:agentId/telegram/approve
   * Approve a pending Telegram pairing by code. Kind-aware (mirrors LINE): a
   * 'group' knock moves its chatId into groupAllowlist (no approved/ handshake —
   * a group has no single recipient); a 'dm' knock allowlists the sender and
   * drops the approved/<senderId> file so the receiver sends a confirmation.
   */
  router.post('/v1/agents/:agentId/telegram/approve', auth, (req: Request, res: Response) => {
    const { agentId } = req.params as { agentId: string };
    const apiKey = (req as AuthedRequest).apiKey;
    if (!isAdmin(apiKey)) { res.status(403).json({ error: 'Admin key required' }); return; }
    if (!agentConfigs.has(agentId)) { res.status(404).json({ error: `Agent '${agentId}' not found` }); return; }
    const { code } = req.body as { code?: string };
    if (!code) { res.status(400).json({ error: 'code required' }); return; }
    const access = readTelegramAccess(agentId);
    const entry = access.pending[code];
    if (!entry || entry.expiresAt < Date.now()) { res.status(404).json({ error: 'Pairing code not found or expired' }); return; }
    const isGroup = entry.kind === 'group';
    if (isGroup) {
      if (!access.groupAllowlist.includes(entry.chatId)) access.groupAllowlist.push(entry.chatId);
    } else {
      if (!access.allowFrom.includes(entry.senderId)) access.allowFrom.push(entry.senderId);
    }
    delete access.pending[code];
    try {
      writeTelegramAccess(agentId, access);
      if (!isGroup) {
        const approvedDir = path.join(getTelegramStateDir(agentId), 'approved');
        fs.mkdirSync(approvedDir, { recursive: true });
        fs.writeFileSync(path.join(approvedDir, entry.senderId), entry.chatId);
      }
    } catch (err) {
      res.status(500).json({ error: `Failed to approve pairing: ${(err as Error).message}` });
      return;
    }
    res.json({ ok: true, senderId: entry.senderId, groupId: isGroup ? entry.chatId : undefined });
  });

  /**
   * POST /api/v1/agents/:agentId/telegram/deny
   * Deny and remove a pending Telegram pairing by code.
   */
  router.post('/v1/agents/:agentId/telegram/deny', auth, (req: Request, res: Response) => {
    const { agentId } = req.params as { agentId: string };
    const apiKey = (req as AuthedRequest).apiKey;
    if (!isAdmin(apiKey)) { res.status(403).json({ error: 'Admin key required' }); return; }
    if (!agentConfigs.has(agentId)) { res.status(404).json({ error: `Agent '${agentId}' not found` }); return; }
    const { code } = req.body as { code?: string };
    if (!code) { res.status(400).json({ error: 'code required' }); return; }
    const access = readTelegramAccess(agentId);
    if (!access.pending[code]) { res.status(404).json({ error: 'Pairing code not found' }); return; }
    delete access.pending[code];
    try {
      writeTelegramAccess(agentId, access);
    } catch (err) {
      res.status(500).json({ error: `Failed to deny pairing: ${(err as Error).message}` });
      return;
    }
    res.json({ ok: true });
  });

  /**
   * PATCH /api/v1/agents/:agentId/telegram/policy
   * Update the Telegram DM policy, the orthogonal pairing toggle, the group
   * policy, and/or the group mention gate.
   * Body: { dmPolicy?, pairing?, groupPolicy?: 'open'|'allowlist'|'disabled', requireMention?: boolean }.
   * At least one field must be present; each is applied only if provided.
   */
  router.patch('/v1/agents/:agentId/telegram/policy', auth, (req: Request, res: Response) => {
    const { agentId } = req.params as { agentId: string };
    const apiKey = (req as AuthedRequest).apiKey;
    if (!isAdmin(apiKey)) { res.status(403).json({ error: 'Admin key required' }); return; }
    if (!agentConfigs.has(agentId)) { res.status(404).json({ error: `Agent '${agentId}' not found` }); return; }
    const { dmPolicy, pairing, groupPolicy, requireMention } = req.body as { dmPolicy?: string; pairing?: boolean; groupPolicy?: string; requireMention?: boolean };
    const valid = ['open', 'allowlist', 'disabled'];
    if (dmPolicy !== undefined && !valid.includes(dmPolicy)) {
      res.status(400).json({ error: `dmPolicy must be one of: ${valid.join(', ')}` }); return;
    }
    if (pairing !== undefined && typeof pairing !== 'boolean') {
      res.status(400).json({ error: 'pairing must be a boolean' }); return;
    }
    if (groupPolicy !== undefined && !valid.includes(groupPolicy)) {
      res.status(400).json({ error: `groupPolicy must be one of: ${valid.join(', ')}` }); return;
    }
    if (requireMention !== undefined && typeof requireMention !== 'boolean') {
      res.status(400).json({ error: 'requireMention must be a boolean' }); return;
    }
    if (dmPolicy === undefined && pairing === undefined && groupPolicy === undefined && requireMention === undefined) {
      res.status(400).json({ error: 'provide dmPolicy, pairing, groupPolicy and/or requireMention' }); return;
    }
    const access = readTelegramAccess(agentId);
    if (dmPolicy !== undefined) access.dmPolicy = dmPolicy as TelegramAccess['dmPolicy'];
    if (pairing !== undefined) access.pairing = pairing;
    if (groupPolicy !== undefined) access.groupPolicy = groupPolicy as TelegramAccess['groupPolicy'];
    if (requireMention !== undefined) access.requireMention = requireMention;
    try {
      writeTelegramAccess(agentId, access);
    } catch (err) {
      res.status(500).json({ error: `Failed to update policy: ${(err as Error).message}` });
      return;
    }
    res.json({ ok: true, dmPolicy: access.dmPolicy, pairing: access.pairing, groupPolicy: access.groupPolicy, requireMention: access.requireMention });
  });

  /**
   * GET /api/v1/agents/:agentId/telegram/allowlist
   * Return all users in allowFrom for an agent's Telegram channel.
   */
  router.get('/v1/agents/:agentId/telegram/allowlist', auth, (req: Request, res: Response) => {
    const { agentId } = req.params as { agentId: string };
    const apiKey = (req as AuthedRequest).apiKey;
    if (!isAdmin(apiKey)) { res.status(403).json({ error: 'Admin key required' }); return; }
    if (!agentConfigs.has(agentId)) { res.status(404).json({ error: `Agent '${agentId}' not found` }); return; }
    const access = readTelegramAccess(agentId);
    res.json({ allowFrom: access.allowFrom });
  });

  /**
   * GET /api/v1/agents/:agentId/line/pending
   * Recently denied LINE senders (Tier 1 allowlist discovery aid). Admin only.
   * In-memory + ephemeral — populated by the webhook gate when it drops a sender.
   */
  router.get('/v1/agents/:agentId/line/pending', auth, (req: Request, res: Response) => {
    const { agentId } = req.params as { agentId: string };
    const apiKey = (req as AuthedRequest).apiKey;
    if (!isAdmin(apiKey)) { res.status(403).json({ error: 'Admin key required' }); return; }
    if (!agentConfigs.has(agentId)) { res.status(404).json({ error: `Agent '${agentId}' not found` }); return; }
    res.json({ senders: getPendingSenders(agentId) });
  });

  /**
   * DELETE /api/v1/agents/:agentId/line/pending/:senderId
   * Dismiss one knock from the in-memory pending list (admin only). Used
   * by the UI "Delete" action — distinct from "+ Add" (which allowlists). The
   * id is a LINE userId/groupId/roomId (U/C/R + hex), so no numeric validation.
   * Idempotent: clearing an unknown id is a no-op. Ephemeral — a later message
   * from the same sender re-adds it (and, under pairing, re-mints a code).
   */
  router.delete('/v1/agents/:agentId/line/pending/:senderId', auth, (req: Request, res: Response) => {
    const apiKey = (req as AuthedRequest).apiKey;
    if (!isAdmin(apiKey)) { res.status(403).json({ error: 'Admin key required' }); return; }
    const { agentId, senderId } = req.params as { agentId: string; senderId: string };
    if (!agentConfigs.has(agentId)) { res.status(404).json({ error: `Agent '${agentId}' not found` }); return; }
    clearPendingSender(agentId, senderId);
    res.json({ ok: true });
  });

  /**
   * DELETE /api/v1/agents/:agentId/telegram/allow/:userId
   * Remove a user from the allowFrom list. Admin only.
   */
  router.delete('/v1/agents/:agentId/telegram/allow/:userId', auth, (req: Request, res: Response) => {
    const apiKey = (req as AuthedRequest).apiKey;
    if (!isAdmin(apiKey)) { res.status(403).json({ error: 'Admin key required' }); return; }
    const { agentId, userId } = req.params as { agentId: string; userId: string };
    if (!/^\d+$/.test(userId)) { res.status(400).json({ error: 'Invalid userId: must be a numeric Telegram user ID' }); return; }
    if (!agentConfigs.has(agentId)) { res.status(404).json({ error: `Agent '${agentId}' not found` }); return; }
    const access = readTelegramAccess(agentId);
    access.allowFrom = access.allowFrom.filter((id) => id !== userId);
    try {
      writeTelegramAccess(agentId, access);
    } catch (err) {
      res.status(500).json({ error: `Failed to update allowlist: ${(err as Error).message}` });
      return;
    }
    res.json({ ok: true });
  });

  /**
   * GET /api/v1/agents/:agentId/telegram/group/allowlist
   * Return the allowlisted group ids for an agent's Telegram channel. Admin only.
   */
  router.get('/v1/agents/:agentId/telegram/group/allowlist', auth, (req: Request, res: Response) => {
    const { agentId } = req.params as { agentId: string };
    const apiKey = (req as AuthedRequest).apiKey;
    if (!isAdmin(apiKey)) { res.status(403).json({ error: 'Admin key required' }); return; }
    if (!agentConfigs.has(agentId)) { res.status(404).json({ error: `Agent '${agentId}' not found` }); return; }
    const access = readTelegramAccess(agentId);
    res.json({ groupAllowlist: access.groupAllowlist });
  });

  /**
   * DELETE /api/v1/agents/:agentId/telegram/group/allow/:groupId
   * Remove a group from the group allowlist. Admin only. Telegram group ids are
   * negative (e.g. -1001234567890) so the validation allows a leading minus.
   */
  router.delete('/v1/agents/:agentId/telegram/group/allow/:groupId', auth, (req: Request, res: Response) => {
    const apiKey = (req as AuthedRequest).apiKey;
    if (!isAdmin(apiKey)) { res.status(403).json({ error: 'Admin key required' }); return; }
    const { agentId, groupId } = req.params as { agentId: string; groupId: string };
    if (!/^-?\d+$/.test(groupId)) { res.status(400).json({ error: 'Invalid groupId: must be a numeric Telegram chat ID' }); return; }
    if (!agentConfigs.has(agentId)) { res.status(404).json({ error: `Agent '${agentId}' not found` }); return; }
    const access = readTelegramAccess(agentId);
    access.groupAllowlist = access.groupAllowlist.filter((id) => id !== groupId);
    // Also drop any legacy per-sender restriction for this group so a later
    // re-add (via a fresh pairing knock) doesn't resurrect a stale allowlist.
    if (access.legacyGroupAllowFrom) delete access.legacyGroupAllowFrom[groupId];
    try {
      writeTelegramAccess(agentId, access);
    } catch (err) {
      res.status(500).json({ error: `Failed to update group allowlist: ${(err as Error).message}` });
      return;
    }
    res.json({ ok: true });
  });

  /**
   * GET /api/v1/agents/:agentId/discord/pending
   * List pending Discord pairing requests (non-expired).
   */
  router.get('/v1/agents/:agentId/discord/pending', auth, (req: Request, res: Response) => {
    const { agentId } = req.params as { agentId: string };
    const apiKey = (req as AuthedRequest).apiKey;
    if (!isAdmin(apiKey)) { res.status(403).json({ error: 'Admin key required' }); return; }
    if (!agentConfigs.has(agentId)) { res.status(404).json({ error: `Agent '${agentId}' not found` }); return; }
    const access = readDiscordAccess(agentId);
    const now = Date.now();
    const expired = Object.keys(access.pending).filter((code) => access.pending[code].expiresAt <= now);
    if (expired.length > 0) {
      expired.forEach((code) => { delete access.pending[code]; });
      try { writeDiscordAccess(agentId, access); } catch { /* non-fatal cleanup */ }
    }
    const pending = Object.entries(access.pending)
      .map(([code, p]) => ({ code, senderId: p.senderId, channelId: p.channelId, createdAt: p.createdAt, expiresAt: p.expiresAt, kind: p.kind ?? 'dm', guildId: p.guildId }));
    res.json({ pending });
  });

  /**
   * POST /api/v1/agents/:agentId/discord/approve
   * Approve a pending Discord pairing by code. Kind-aware (mirrors LINE): a
   * 'guild' knock moves its guildId into guildAllowlist (no approved/ handshake
   * — a guild has no single recipient); a 'dm' knock allowlists the sender and
   * drops the approved/<senderId> file for the "You're connected!" reply.
   */
  router.post('/v1/agents/:agentId/discord/approve', auth, (req: Request, res: Response) => {
    const { agentId } = req.params as { agentId: string };
    const apiKey = (req as AuthedRequest).apiKey;
    if (!isAdmin(apiKey)) { res.status(403).json({ error: 'Admin key required' }); return; }
    if (!agentConfigs.has(agentId)) { res.status(404).json({ error: `Agent '${agentId}' not found` }); return; }
    const { code } = req.body as { code?: string };
    if (!code) { res.status(400).json({ error: 'code required' }); return; }
    const access = readDiscordAccess(agentId);
    const entry = access.pending[code];
    if (!entry || entry.expiresAt < Date.now()) { res.status(404).json({ error: 'Pairing code not found or expired' }); return; }
    const isGuild = entry.kind === 'guild';
    if (isGuild) {
      if (entry.guildId && !access.guildAllowlist.includes(entry.guildId)) access.guildAllowlist.push(entry.guildId);
    } else {
      if (!access.allowFrom.includes(entry.senderId)) access.allowFrom.push(entry.senderId);
    }
    delete access.pending[code];
    try {
      writeDiscordAccess(agentId, access);
      if (!isGuild) {
        // Handshake consumed by module.ts:checkApprovals() — file name is the
        // senderId, content is the channelId to DM "You're connected!".
        const approvedDir = path.join(getDiscordStateDir(agentId), 'approved');
        fs.mkdirSync(approvedDir, { recursive: true });
        fs.writeFileSync(path.join(approvedDir, entry.senderId), entry.channelId);
      }
    } catch (err) {
      res.status(500).json({ error: `Failed to approve pairing: ${(err as Error).message}` });
      return;
    }
    res.json({ ok: true, senderId: entry.senderId, guildId: isGuild ? entry.guildId : undefined });
  });

  /**
   * POST /api/v1/agents/:agentId/discord/deny
   * Deny and remove a pending Discord pairing by code.
   */
  router.post('/v1/agents/:agentId/discord/deny', auth, (req: Request, res: Response) => {
    const { agentId } = req.params as { agentId: string };
    const apiKey = (req as AuthedRequest).apiKey;
    if (!isAdmin(apiKey)) { res.status(403).json({ error: 'Admin key required' }); return; }
    if (!agentConfigs.has(agentId)) { res.status(404).json({ error: `Agent '${agentId}' not found` }); return; }
    const { code } = req.body as { code?: string };
    if (!code) { res.status(400).json({ error: 'code required' }); return; }
    const access = readDiscordAccess(agentId);
    if (!access.pending[code]) { res.status(404).json({ error: 'Pairing code not found' }); return; }
    delete access.pending[code];
    try {
      writeDiscordAccess(agentId, access);
    } catch (err) {
      res.status(500).json({ error: `Failed to deny pairing: ${(err as Error).message}` });
      return;
    }
    res.json({ ok: true });
  });

  /**
   * PATCH /api/v1/agents/:agentId/discord/policy
   * Update the Discord DM policy, the orthogonal pairing toggle, the guild
   * policy, and/or the guild mention gate.
   * Body: { dmPolicy?, pairing?, groupPolicy?: 'open'|'allowlist'|'disabled', requireMention?: boolean }.
   * At least one field must be present; each is applied only if provided.
   */
  router.patch('/v1/agents/:agentId/discord/policy', auth, (req: Request, res: Response) => {
    const { agentId } = req.params as { agentId: string };
    const apiKey = (req as AuthedRequest).apiKey;
    if (!isAdmin(apiKey)) { res.status(403).json({ error: 'Admin key required' }); return; }
    if (!agentConfigs.has(agentId)) { res.status(404).json({ error: `Agent '${agentId}' not found` }); return; }
    const { dmPolicy, pairing, groupPolicy, requireMention } = req.body as { dmPolicy?: string; pairing?: boolean; groupPolicy?: string; requireMention?: boolean };
    const valid = ['open', 'allowlist', 'disabled'];
    if (dmPolicy !== undefined && !valid.includes(dmPolicy)) {
      res.status(400).json({ error: `dmPolicy must be one of: ${valid.join(', ')}` }); return;
    }
    if (pairing !== undefined && typeof pairing !== 'boolean') {
      res.status(400).json({ error: 'pairing must be a boolean' }); return;
    }
    if (groupPolicy !== undefined && !valid.includes(groupPolicy)) {
      res.status(400).json({ error: `groupPolicy must be one of: ${valid.join(', ')}` }); return;
    }
    if (requireMention !== undefined && typeof requireMention !== 'boolean') {
      res.status(400).json({ error: 'requireMention must be a boolean' }); return;
    }
    if (dmPolicy === undefined && pairing === undefined && groupPolicy === undefined && requireMention === undefined) {
      res.status(400).json({ error: 'provide dmPolicy, pairing, groupPolicy and/or requireMention' }); return;
    }
    const access = readDiscordAccess(agentId);
    if (dmPolicy !== undefined) access.dmPolicy = dmPolicy as DiscordAccessShape['dmPolicy'];
    if (pairing !== undefined) access.pairing = pairing;
    if (groupPolicy !== undefined) access.groupPolicy = groupPolicy as DiscordAccessShape['groupPolicy'];
    if (requireMention !== undefined) access.requireMention = requireMention;
    try {
      writeDiscordAccess(agentId, access);
    } catch (err) {
      res.status(500).json({ error: `Failed to update policy: ${(err as Error).message}` });
      return;
    }
    res.json({ ok: true, dmPolicy: access.dmPolicy, pairing: access.pairing, groupPolicy: access.groupPolicy, requireMention: access.requireMention });
  });

  /**
   * GET /api/v1/agents/:agentId/discord/allowlist
   * Return all users in allowFrom for an agent's Discord channel.
   */
  router.get('/v1/agents/:agentId/discord/allowlist', auth, (req: Request, res: Response) => {
    const { agentId } = req.params as { agentId: string };
    const apiKey = (req as AuthedRequest).apiKey;
    if (!isAdmin(apiKey)) { res.status(403).json({ error: 'Admin key required' }); return; }
    if (!agentConfigs.has(agentId)) { res.status(404).json({ error: `Agent '${agentId}' not found` }); return; }
    const access = readDiscordAccess(agentId);
    res.json({ allowFrom: access.allowFrom });
  });

  /**
   * DELETE /api/v1/agents/:agentId/discord/allow/:userId
   * Remove a user from the allowFrom list. Admin only.
   */
  router.delete('/v1/agents/:agentId/discord/allow/:userId', auth, (req: Request, res: Response) => {
    const apiKey = (req as AuthedRequest).apiKey;
    if (!isAdmin(apiKey)) { res.status(403).json({ error: 'Admin key required' }); return; }
    const { agentId, userId } = req.params as { agentId: string; userId: string };
    if (!/^\d+$/.test(userId)) { res.status(400).json({ error: 'Invalid userId: must be a numeric Discord user ID' }); return; }
    if (!agentConfigs.has(agentId)) { res.status(404).json({ error: `Agent '${agentId}' not found` }); return; }
    const access = readDiscordAccess(agentId);
    access.allowFrom = access.allowFrom.filter((id) => id !== userId);
    try {
      writeDiscordAccess(agentId, access);
    } catch (err) {
      res.status(500).json({ error: `Failed to update allowlist: ${(err as Error).message}` });
      return;
    }
    res.json({ ok: true });
  });

  /**
   * GET /api/v1/agents/:agentId/discord/guild/allowlist
   * Return the allowlisted guild ids for an agent's Discord channel. Admin only.
   */
  router.get('/v1/agents/:agentId/discord/guild/allowlist', auth, (req: Request, res: Response) => {
    const { agentId } = req.params as { agentId: string };
    const apiKey = (req as AuthedRequest).apiKey;
    if (!isAdmin(apiKey)) { res.status(403).json({ error: 'Admin key required' }); return; }
    if (!agentConfigs.has(agentId)) { res.status(404).json({ error: `Agent '${agentId}' not found` }); return; }
    const access = readDiscordAccess(agentId);
    res.json({ guildAllowlist: access.guildAllowlist });
  });

  /**
   * DELETE /api/v1/agents/:agentId/discord/guild/allow/:guildId
   * Remove a guild from the guild allowlist. Admin only. Discord guild ids are
   * numeric snowflakes (no leading minus).
   */
  router.delete('/v1/agents/:agentId/discord/guild/allow/:guildId', auth, (req: Request, res: Response) => {
    const apiKey = (req as AuthedRequest).apiKey;
    if (!isAdmin(apiKey)) { res.status(403).json({ error: 'Admin key required' }); return; }
    const { agentId, guildId } = req.params as { agentId: string; guildId: string };
    if (!/^\d+$/.test(guildId)) { res.status(400).json({ error: 'Invalid guildId: must be a numeric Discord guild ID' }); return; }
    if (!agentConfigs.has(agentId)) { res.status(404).json({ error: `Agent '${agentId}' not found` }); return; }
    const access = readDiscordAccess(agentId);
    access.guildAllowlist = access.guildAllowlist.filter((id) => id !== guildId);
    try {
      writeDiscordAccess(agentId, access);
    } catch (err) {
      res.status(500).json({ error: `Failed to update guild allowlist: ${(err as Error).message}` });
      return;
    }
    res.json({ ok: true });
  });

  /**
   * DELETE /api/v1/agents/:agentId
   *
   * Remove agent from config.json and stop the running runner. Requires admin key.
   */
  router.delete('/v1/agents/:agentId', auth, async (req: Request, res: Response) => {
    const apiKey = (req as AuthedRequest).apiKey;
    if (!isAdmin(apiKey)) {
      res.status(403).json({ error: 'Admin key required' });
      return;
    }
    if (!configPath) {
      res.status(501).json({ error: 'Agent management not available (no configPath)' });
      return;
    }
    const { agentId } = req.params as { agentId: string };
    if (!agentConfigs.has(agentId)) {
      res.status(404).json({ error: `Agent '${agentId}' not found` });
      return;
    }

    try {
      await writeAgentsToConfig(configPath, (agents) => {
        const idx = (agents as Record<string, unknown>[]).findIndex((a) => a.id === agentId);
        if (idx !== -1) agents.splice(idx, 1);
      });
    } catch (err) {
      res.status(500).json({ error: `Failed to write config: ${(err as Error).message}` });
      return;
    }

    // Stop and remove the running runner so the agent no longer responds after deletion.
    const runner = agentRunners.get(agentId);
    if (runner) {
      try { await runner.stop(); } catch { /* ignore stop errors */ }
      agentRunners.delete(agentId);
      HistoryDB.evictDir(runner.getAgentDir(), agentId);
    }
    agentConfigs.delete(agentId);

    res.json({ success: true, id: agentId });
  });

  // ─── Chat History API ─────────────────────────────────────────────────────────

  /**
   * GET /api/v1/agents/:agentId/chats
   * List all chats (across all channels) for an agent from the history DB.
   */
  router.get('/v1/agents/:agentId/chats', auth, (req: Request, res: Response) => {
    const { agentId } = req.params as { agentId: string };
    const apiKey = (req as AuthedRequest).apiKey;
    if (!canAccessAgent(apiKey, agentId)) {
      res.status(403).json({ error: `API key has no access to agent '${agentId}'` });
      return;
    }
    const runner = agentRunners.get(agentId);
    if (!runner) {
      res.status(404).json({ error: `Agent '${agentId}' not found` });
      return;
    }
    const chats = runner.getHistoryDb().listChats();
    res.json({ chats });
  });

  /**
   * GET /api/v1/agents/:agentId/chats/:chatId/sessions
   * List sessions for a specific chat (delegated to SessionStore).
   * chatId format: "telegram-{rawId}" | "discord-{rawId}"
   */
  router.get('/v1/agents/:agentId/chats/:chatId/sessions', auth, async (req: Request, res: Response) => {
    const { agentId, chatId } = req.params as { agentId: string; chatId: string };
    const apiKey = (req as AuthedRequest).apiKey;
    if (!canAccessAgent(apiKey, agentId)) {
      res.status(403).json({ error: `API key has no access to agent '${agentId}'` });
      return;
    }
    const runner = agentRunners.get(agentId);
    if (!runner) {
      res.status(404).json({ error: `Agent '${agentId}' not found` });
      return;
    }
    const { source, rawChatId } = parseHistoryChatId(chatId);
    if (source !== 'telegram' && source !== 'discord' && source !== 'line') {
      res.status(400).json({ error: 'Sessions endpoint only supports telegram/discord/line chats' });
      return;
    }
    try {
      const index = await runner.listSessionsForChat(rawChatId, source as 'telegram' | 'discord' | 'line');
      res.json(index);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * GET /api/v1/agents/:agentId/chats/:chatId/messages
   * Paginated message history (cursor-based).
   * Query: limit, before (ts ms), after (ts ms), session_id, order (asc|desc, default desc)
   */
  router.get('/v1/agents/:agentId/chats/:chatId/messages', auth, (req: Request, res: Response) => {
    const { agentId, chatId } = req.params as { agentId: string; chatId: string };
    const apiKey = (req as AuthedRequest).apiKey;
    if (!canAccessAgent(apiKey, agentId)) {
      res.status(403).json({ error: `API key has no access to agent '${agentId}'` });
      return;
    }
    const runner = agentRunners.get(agentId);
    if (!runner) {
      res.status(404).json({ error: `Agent '${agentId}' not found` });
      return;
    }
    const query = req.query as Record<string, string>;
    const limit = query['limit'] ? Math.min(parseInt(query['limit'], 10) || 50, 200) : 50;
    // Numeric cursor params. before/after are ms timestamps; before_id/after_id are the id
    // component of the composite (ts, id) cursor, echoed from a prior page's nextCursorId —
    // paired with before/after they stop paging from skipping messages that share a ts
    // (ignored unless the matching before/after is present). A present-but-non-numeric value
    // (?before=abc, or a duplicate/structured param) is a malformed request: reject with 400
    // so client bugs surface, mirroring the `order` guard below, rather than coercing to NaN
    // and silently returning an empty page.
    const cursorInts: Record<string, number | undefined> = {};
    for (const name of ['before', 'after', 'before_id', 'after_id']) {
      const raw = query[name] as unknown;
      if (raw === undefined) continue;
      const n = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
      if (!Number.isFinite(n)) {
        res.status(400).json({ error: `${name} must be a number` });
        return;
      }
      cursorInts[name] = n;
    }
    const before = cursorInts['before'];
    const after = cursorInts['after'];
    const beforeId = cursorInts['before_id'];
    const afterId = cursorInts['after_id'];
    const sessionId = query['session_id'] ?? undefined;

    // order: case-insensitive; 'asc' seeks forward, 'desc' (or omitted) is the db default.
    // Reject any other explicit value with 400 so client typos surface instead of silently defaulting.
    let order: 'asc' | undefined;
    const rawOrder = query['order'] as unknown;
    if (rawOrder !== undefined) {
      // Express parses a repeated/structured param (?order=asc&order=asc) as an
      // array/object, not a string — guard so .toLowerCase() can't throw a 500.
      if (typeof rawOrder !== 'string') {
        res.status(400).json({ error: "order must be 'asc' or 'desc'" });
        return;
      }
      const normalized = rawOrder.toLowerCase();
      if (normalized === 'asc') {
        order = 'asc';
      } else if (normalized === 'desc') {
        order = undefined; // explicit desc == db default
      } else {
        res.status(400).json({ error: "order must be 'asc' or 'desc'" });
        return;
      }
    }

    const page = runner.getHistoryDb().getMessages(chatId, { limit, before, after, beforeId, afterId, sessionId, order });
    res.json(page);
  });

  /**
   * GET /api/v1/agents/:agentId/chats/:chatId/messages/search
   * Full-text search using SQLite FTS5.
   * Query: q, limit, offset
   */
  router.get('/v1/agents/:agentId/chats/:chatId/messages/search', auth, (req: Request, res: Response) => {
    const { agentId, chatId } = req.params as { agentId: string; chatId: string };
    const apiKey = (req as AuthedRequest).apiKey;
    if (!canAccessAgent(apiKey, agentId)) {
      res.status(403).json({ error: `API key has no access to agent '${agentId}'` });
      return;
    }
    const runner = agentRunners.get(agentId);
    if (!runner) {
      res.status(404).json({ error: `Agent '${agentId}' not found` });
      return;
    }
    const query = req.query as Record<string, string>;
    const q = (query['q'] ?? '').trim();
    if (!q) {
      res.status(400).json({ error: 'q is required' });
      return;
    }
    const limit = query['limit'] ? Math.min(parseInt(query['limit'], 10) || 20, 100) : 20;
    const offset = query['offset'] ? parseInt(query['offset'], 10) : 0;

    const page = runner.getHistoryDb().searchMessages(chatId, q, { limit, offset });
    res.json(page);
  });

  /**
   * GET /api/v1/agents/:agentId/chats/:chatId/messages/active-days
   * Distinct local calendar days (YYYY-MM-DD) with >= 1 message in a [from, to) window.
   * Powers the jump-to-date calendar's per-day "has history" dot in one bounded index scan.
   * Query: from (ts ms, inclusive), to (ts ms, exclusive), tz_offset (min east of UTC, Bangkok=+420), session_id
   */
  router.get('/v1/agents/:agentId/chats/:chatId/messages/active-days', auth, (req: Request, res: Response) => {
    const { agentId, chatId } = req.params as { agentId: string; chatId: string };
    const apiKey = (req as AuthedRequest).apiKey;
    if (!canAccessAgent(apiKey, agentId)) {
      res.status(403).json({ error: `API key has no access to agent '${agentId}'` });
      return;
    }
    const runner = agentRunners.get(agentId);
    if (!runner) {
      res.status(404).json({ error: `Agent '${agentId}' not found` });
      return;
    }
    const query = req.query as Record<string, string>;
    // Number(), not parseInt() — parseInt("100garbage") silently returns 100, masking a malformed
    // client value the same way a case-sensitive/silently-defaulting enum param would (see order).
    const from = query['from'] ? Number(query['from']) : NaN;
    const to = query['to'] ? Number(query['to']) : NaN;
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      res.status(400).json({ error: 'from and to (ts ms) are required' });
      return;
    }
    // Bound the window so a malformed client can't turn this into a near-full-history scan.
    // 366 days is far wider than the one-month view the calendar sends, so it never bites
    // legitimate navigation while still capping a pathological range (E5 in the design notes).
    const MAX_ACTIVE_DAYS_SPAN_MS = 366 * 24 * 60 * 60 * 1000;
    if (to - from > MAX_ACTIVE_DAYS_SPAN_MS) {
      res.status(400).json({ error: 'window too large (max 366 days between from and to)' });
      return;
    }
    let tzOffset = 0;
    if (query['tz_offset'] !== undefined) {
      const parsed = Number(query['tz_offset']);
      if (!Number.isFinite(parsed)) {
        res.status(400).json({ error: 'tz_offset must be a number (minutes east of UTC)' });
        return;
      }
      tzOffset = parsed;
    }
    // session_id, like order, can arrive as an array when the param is repeated
    // (?session_id=a&session_id=b). Guard so it can't reach the sqlite bind as an
    // array and throw a 500 — surface a 400 instead. (Mirrors the order guard above.)
    const rawSessionId = query['session_id'] as unknown;
    if (rawSessionId !== undefined && typeof rawSessionId !== 'string') {
      res.status(400).json({ error: 'session_id must be a single value' });
      return;
    }
    const sessionId = rawSessionId ?? undefined;

    const days = runner.getHistoryDb().getActiveDays(chatId, { from, to, tzOffset, sessionId });
    res.json({ days });
  });

  /**
   * POST /api/v1/agents/:agentId/chats/:chatId/sessions/:sessionId/messages
   * Inject a message into an existing channel session (cross-channel continuation).
   * Streams the assistant response as SSE.
   * Body: { content: string, senderName?: string }
   */
  router.post('/v1/agents/:agentId/chats/:chatId/sessions/:sessionId/messages', auth, async (req: Request, res: Response) => {
    const { agentId, chatId, sessionId } = req.params as { agentId: string; chatId: string; sessionId: string };
    const apiKey = (req as AuthedRequest).apiKey;
    if (!canAccessAgent(apiKey, agentId)) {
      res.status(403).json({ error: `API key has no access to agent '${agentId}'` });
      return;
    }
    const runner = agentRunners.get(agentId);
    if (!runner) {
      res.status(404).json({ error: `Agent '${agentId}' not found` });
      return;
    }
    const { source, rawChatId } = parseHistoryChatId(chatId);
    if (source !== 'telegram' && source !== 'discord' && source !== 'line') {
      res.status(400).json({ error: 'Cross-channel messaging only supported for telegram/discord/line chats' });
      return;
    }

    const body = req.body as { content?: unknown; senderName?: unknown };
    const content = body.content;
    if (!content || typeof content !== 'string' || !content.trim()) {
      res.status(400).json({ error: 'content is required and must be a non-empty string' });
      return;
    }
    if (content.length > MAX_MESSAGE_LENGTH) {
      res.status(400).json({ error: `content too long (max ${MAX_MESSAGE_LENGTH} characters)` });
      return;
    }
    const senderName = typeof body.senderName === 'string' ? body.senderName : undefined;

    let cleanup: (() => void) | undefined;
    try {
      const sseCallbacks = {
        onChunk: (event: import('../types').StreamEvent) => {
          try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* client gone */ }
        },
        onDone: (fullText: string) => {
          try {
            res.write(`data: ${JSON.stringify({ type: 'result', text: fullText, session_id: sessionId })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          } catch { /* client gone */ }
        },
        onError: (err: Error) => {
          try {
            res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
            res.end();
          } catch { /* client gone */ }
        },
      };

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      res.socket?.setNoDelay(true);

      cleanup = await runner.sendMessageToSession(
        rawChatId,
        source as 'telegram' | 'discord' | 'line',
        sessionId,
        content.trim(),
        senderName,
        sseCallbacks,
        { timeoutMs: DEFAULT_TIMEOUT_MS },
      );
      res.on('close', cleanup);
    } catch (err: unknown) {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal error' });
      } else {
        try {
          res.write(`data: ${JSON.stringify({ type: 'error', message: 'Internal error' })}\n\n`);
          res.end();
        } catch { /* client gone */ }
      }
    }
  });

  /**
   * POST /api/v1/agents/:agentId/sessions/:sessionId/attachments
   * Register file paths as attachments for the current API session turn.
   * Called by the api_reply MCP tool from within the agent subprocess.
   * Body: { files: string[] }  — absolute file paths within the agent's media directory.
   */
  router.post(
    '/v1/agents/:agentId/sessions/:sessionId/attachments',
    auth,
    (req: Request, res: Response) => {
      const { agentId, sessionId } = req.params as { agentId: string; sessionId: string };
      const apiKey = (req as AuthedRequest).apiKey;
      if (!canAccessAgent(apiKey, agentId)) {
        res.status(403).json({ error: `API key has no access to agent '${agentId}'` });
        return;
      }
      const runner = agentRunners.get(agentId);
      if (!runner) {
        res.status(404).json({ error: `Agent '${agentId}' not found` });
        return;
      }
      const body = req.body as Record<string, unknown>;
      const files = body['files'];
      if (!Array.isArray(files) || files.some((f) => typeof f !== 'string')) {
        res.status(400).json({ error: 'files must be an array of strings' });
        return;
      }
      // Validate all paths stay within the agent's media directory
      const agentsBaseDir = runner.getAgentsBaseDir();
      const mediaRoot = path.join(agentsBaseDir, agentId, 'media') + path.sep;
      const validFiles: string[] = [];
      for (const f of files as string[]) {
        const real = path.resolve(f);
        if (!real.startsWith(mediaRoot)) {
          res.status(400).json({ error: `File path outside media directory: ${f}` });
          return;
        }
        validFiles.push(real);
      }
      runner.addApiAttachments(sessionId, validFiles);
      res.json({ ok: true, count: validFiles.length });
    },
  );

  /**
   * POST /api/v1/agents/:agentId/media
   * Upload a media file as raw binary body (image/* or application/pdf).
   * Headers: Content-Type (mime type), X-Filename (optional original filename)
   * Body: raw file bytes
   * Returns: { mediaPath: string }  — relative path usable in message mediaFiles[]
   */
  router.post(
    '/v1/agents/:agentId/media',
    auth,
    (req: Request, res: Response, next) => {
      // Buffer raw body up to maxUploadBytes; express.json/urlencoded don't handle binary
      const mimeType = (req.headers['content-type'] ?? '').split(';')[0]!.trim();
      if (!MediaStore.isAllowedMime(mimeType)) {
        res.status(415).json({ error: 'Unsupported file type. Allowed: image/*, application/pdf' });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MediaStore.maxUploadBytes) {
          if (!res.headersSent) res.status(413).json({ error: `File too large (max ${MediaStore.maxUploadBytes / 1024 / 1024}MB)` });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        (req as Request & { rawFileBuffer?: Buffer; rawFileMime?: string }).rawFileBuffer = Buffer.concat(chunks);
        (req as Request & { rawFileMime?: string }).rawFileMime = mimeType;
        next();
      });
      req.on('error', () => {
        if (!res.headersSent) res.status(500).json({ error: 'Upload stream error' });
      });
    },
    async (req: Request, res: Response) => {
      const { agentId } = req.params as { agentId: string };
      const apiKey = (req as AuthedRequest).apiKey;
      if (!canAccessAgent(apiKey, agentId)) {
        res.status(403).json({ error: `API key has no access to agent '${agentId}'` });
        return;
      }
      const runner = agentRunners.get(agentId);
      if (!runner) {
        res.status(404).json({ error: `Agent '${agentId}' not found` });
        return;
      }
      // Rate limit: max 20 uploads/min per API key
      const keyHash = createHash('sha256').update(apiKey.key).digest('hex').slice(0, 16);
      if (!checkUploadRateLimit(keyHash)) {
        res.status(429).json({ error: 'Too many uploads. Limit: 20 per minute.' });
        return;
      }

      const buf = (req as Request & { rawFileBuffer?: Buffer }).rawFileBuffer;
      const mimeType = (req as Request & { rawFileMime?: string }).rawFileMime ?? '';
      if (!buf || buf.length === 0) {
        res.status(400).json({ error: 'No file body received' });
        return;
      }

      // X-Filename: validate length, strip to basename, allow only safe characters
      const rawFilename = (req.headers['x-filename'] as string | undefined) ?? 'upload';
      if (rawFilename.length > 255) {
        res.status(400).json({ error: 'X-Filename too long (max 255 chars)' });
        return;
      }
      const baseName = path.basename(rawFilename).replace(/\s+/g, '_');
      const safeBaseName = SAFE_FILENAME_RE.test(baseName) ? baseName : 'upload';
      const rawExt = path.extname(safeBaseName).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 10);
      const ext = rawExt || (mimeType.includes('pdf') ? '.pdf' : '.bin');

      const tmpFile = path.join(os.tmpdir(), `gw-${Date.now()}${ext}`);
      try {
        await fsp.writeFile(tmpFile, buf);
        const agentsBaseDir = runner.getAgentsBaseDir();
        // Store under ui-upload/{keyId}/ so each API key's uploads are isolated
        const keySubdir = `ui-upload/${apiKeyId(apiKey.key)}`;
        const mediaPath = MediaStore.copyToMedia(agentsBaseDir, agentId, keySubdir, tmpFile);
        res.json({ mediaPath });
      } catch (err) {
        res.status(500).json({ error: `Upload failed: ${(err as Error).message}` });
      } finally {
        fsp.unlink(tmpFile).catch(() => {});
      }
    },
  );

  /**
   * GET /api/v1/agents/:agentId/media/*filepath
   * Serve a media file. Validates path stays within agent's media directory.
   */
  router.get('/v1/agents/:agentId/media/*', auth, (req: Request, res: Response) => {
    const { agentId } = req.params as { agentId: string };
    const apiKey = (req as AuthedRequest).apiKey;
    if (!canAccessAgent(apiKey, agentId)) {
      res.status(403).json({ error: `API key has no access to agent '${agentId}'` });
      return;
    }
    const runner = agentRunners.get(agentId);
    if (!runner) {
      res.status(404).json({ error: `Agent '${agentId}' not found` });
      return;
    }

    const wildcardParam = (req.params as Record<string, string>)['0'] ?? '';
    const agentsBaseDir = runner.getAgentsBaseDir();
    let absPath: string;
    try {
      absPath = MediaStore.resolvePath(agentsBaseDir, agentId, wildcardParam);
    } catch {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }
    if (!fs.existsSync(absPath)) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    // Cache media files for 7 days — content is immutable once written
    res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');

    // For .bin files (legacy uploads without extension), detect content-type from magic bytes
    const ext = path.extname(absPath).toLowerCase();
    if (ext === '.bin' || ext === '') {
      try {
        const fd = fs.openSync(absPath, 'r');
        const header = Buffer.alloc(12);
        fs.readSync(fd, header, 0, 12, 0);
        fs.closeSync(fd);
        const mime = detectMimeFromMagic(header);
        if (mime) res.setHeader('Content-Type', mime);
      } catch { /* fall through to sendFile default */ }
    }
    res.sendFile(absPath);
  });

  // Schedule hourly cleanup of stale staging uploads (files older than 24h)
  setInterval(() => {
    const firstRunner = agentRunners.values().next().value as AgentRunner | undefined;
    if (firstRunner) {
      try { MediaStore.cleanupStaging(firstRunner.getAgentsBaseDir()); } catch { /* non-critical */ }
    }
  }, 60 * 60 * 1000).unref(); // unref so cleanup timer doesn't keep process alive

  // ──────────────────────────────────────────────────────────────
  // Model management
  // ──────────────────────────────────────────────────────────────

  /**
   * PUT /api/v1/agents/:agentId/model
   *
   * Set the active model for an agent. Persists to config.json.
   */
  router.put('/v1/agents/:agentId/model', auth, async (req: Request, res: Response) => {
    const { agentId } = req.params as { agentId: string };
    const apiKey = (req as AuthedRequest).apiKey;
    if (!isAdmin(apiKey)) {
      res.status(403).json({ error: 'Admin key required' });
      return;
    }
    const runner = agentRunners.get(agentId);
    if (!runner) { res.status(404).json({ error: `Agent '${agentId}' not found` }); return; }
    const body = req.body as { model?: unknown };
    const { model: newModel } = body;
    if (!newModel || typeof newModel !== 'string') {
      res.status(400).json({ error: 'model is required' });
      return;
    }
    try {
      await runner.setModel(newModel);
      res.json({ model: newModel });
    } catch (err: unknown) {
      res.status(500).json({ error: 'Failed to set model' });
    }
  });

  // ──────────────────────────────────────────────────────────────
  // Avatar endpoints
  // ──────────────────────────────────────────────────────────────

  /**
   * PUT /api/v1/agents/:agentId/avatar
   * Upload or replace the agent's avatar image. Requires write permission.
   * Body: raw image binary (image/jpeg, image/png, image/webp, image/gif)
   */
  router.put('/v1/agents/:agentId/avatar', auth, async (req: Request, res: Response) => {
    const apiKey = (req as AuthedRequest).apiKey;
    const { agentId } = req.params as { agentId: string };
    if (!canWriteAgent(apiKey, agentId)) {
      res.status(403).json({ error: 'Write permission required' });
      return;
    }
    if (!configPath) { res.status(501).json({ error: 'Agent management not available (no configPath)' }); return; }
    if (!agentConfigs.has(agentId)) { res.status(404).json({ error: `Agent '${agentId}' not found` }); return; }

    let buf: Buffer;
    try {
      buf = await readRawBody(req, res, AVATAR_MAX_BYTES);
    } catch {
      return;
    }
    if (!buf.length) { res.status(400).json({ error: 'No file body received' }); return; }
    if (buf.length < 12) { res.status(400).json({ error: 'File too small to detect type' }); return; }

    const mime = detectMimeFromMagic(buf.subarray(0, 12));
    if (!mime || !AVATAR_MIME_EXT[mime]) {
      res.status(415).json({ error: 'Unsupported image type. Allowed: jpeg, png, gif, webp' });
      return;
    }

    const ext = AVATAR_MIME_EXT[mime];
    const newFilename = `avatar.${ext}`;
    const agentDirAbs = path.join(getAgentsBaseDir(), agentId);

    // Remove old avatar file if extension differs
    const currentAvatar = agentConfigs.get(agentId)?.avatar;
    if (currentAvatar && currentAvatar !== newFilename) {
      const oldPath = path.join(agentDirAbs, currentAvatar);
      fsp.unlink(oldPath).catch(() => {});
    }

    try {
      fs.mkdirSync(agentDirAbs, { recursive: true });
      await fsp.writeFile(path.join(agentDirAbs, newFilename), buf);
    } catch (err) {
      res.status(500).json({ error: `Failed to write avatar: ${(err as Error).message}` });
      return;
    }

    try {
      await writeAgentsToConfig(configPath, (agents) => {
        const agent = (agents as Record<string, unknown>[]).find((a) => a.id === agentId);
        if (agent) agent.avatar = newFilename;
      });
    } catch (err) {
      res.status(500).json({ error: `Failed to update config: ${(err as Error).message}` });
      return;
    }

    // Update in-memory map immediately — don't wait for the file watcher so the
    // GET handler can serve the new file before the next config reload fires.
    const cfg = agentConfigs.get(agentId);
    if (cfg) cfg.avatar = newFilename;

    res.json({ avatarUrl: `/api/v1/agents/${agentId}/avatar` });
  });

  /**
   * DELETE /api/v1/agents/:agentId/avatar
   * Remove the agent's avatar. Requires write permission.
   */
  router.delete('/v1/agents/:agentId/avatar', auth, async (req: Request, res: Response) => {
    const apiKey = (req as AuthedRequest).apiKey;
    const { agentId } = req.params as { agentId: string };
    if (!canWriteAgent(apiKey, agentId)) {
      res.status(403).json({ error: 'Write permission required' });
      return;
    }
    if (!configPath) { res.status(501).json({ error: 'Agent management not available (no configPath)' }); return; }
    const agentCfg = agentConfigs.get(agentId);
    if (!agentCfg) { res.status(404).json({ error: `Agent '${agentId}' not found` }); return; }

    if (agentCfg.avatar) {
      const avatarPath = path.join(getAgentsBaseDir(), agentId, agentCfg.avatar);
      fsp.unlink(avatarPath).catch(() => {});
    }

    try {
      await writeAgentsToConfig(configPath, (agents) => {
        const agent = (agents as Record<string, unknown>[]).find((a) => a.id === agentId);
        if (agent) delete (agent as Record<string, unknown>).avatar;
      });
    } catch (err) {
      res.status(500).json({ error: `Failed to update config: ${(err as Error).message}` });
      return;
    }

    // Update in-memory map immediately — same reason as PUT handler above.
    const cfg = agentConfigs.get(agentId);
    if (cfg) delete cfg.avatar;

    res.status(204).send();
  });

  /**
   * GET /api/v1/agents/:agentId/avatar
   * Serve the agent's avatar image.
   */
  router.get('/v1/agents/:agentId/avatar', auth, (req: Request, res: Response) => {
    const apiKey = (req as AuthedRequest).apiKey;
    const { agentId } = req.params as { agentId: string };
    if (!canAccessAgent(apiKey, agentId)) {
      res.status(403).json({ error: `API key has no access to agent '${agentId}'` });
      return;
    }
    const agentCfg = agentConfigs.get(agentId);
    if (!agentCfg) { res.status(404).json({ error: `Agent '${agentId}' not found` }); return; }
    if (!agentCfg.avatar) { res.status(404).json({ error: 'No avatar set for this agent' }); return; }

    const base = getAgentsBaseDir();
    const avatarPath = path.resolve(path.join(base, agentId, agentCfg.avatar));
    const agentDirResolved = path.resolve(path.join(base, agentId));
    if (!avatarPath.startsWith(agentDirResolved + path.sep)) {
      res.status(400).json({ error: 'Invalid avatar path' });
      return;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(avatarPath);
    } catch {
      res.status(404).json({ error: 'Avatar file not found' });
      return;
    }

    const ext = path.extname(avatarPath).slice(1).toLowerCase();
    const mimeMap: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
    const contentType = mimeMap[ext] ?? 'application/octet-stream';

    // Weak ETag — mtime+size cannot guarantee byte-identical content so strong ETag is inappropriate.
    const etag = `W/"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;

    // no-cache forces revalidation on every request; ETag allows 304 when file is unchanged.
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', new Date(stat.mtimeMs).toUTCString());
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // If-None-Match may be a comma-separated list of ETags; check each token.
    const ifNoneMatch = req.headers['if-none-match'];
    const matched = ifNoneMatch && ifNoneMatch.split(',').map(t => t.trim()).includes(etag);
    if (matched) {
      res.status(304).end();
      return;
    }
    res.sendFile(avatarPath);
  });

  // ──────────────────────────────────────────────────────────────
  // API Session management  (/v1/agents/:agentId/sessions/...)
  // ──────────────────────────────────────────────────────────────

  function resolveApiSession(req: Request, res: Response): { runner: AgentRunner; agentId: string; chatId: string } | null {
    const { agentId } = req.params as { agentId: string };
    const apiKey = (req as AuthedRequest).apiKey;
    if (!canAccessAgent(apiKey, agentId)) {
      res.status(403).json({ error: `API key has no access to agent '${agentId}'` });
      return null;
    }
    const runner = agentRunners.get(agentId);
    if (!runner) { res.status(404).json({ error: `Agent '${agentId}' not found` }); return null; }
    const chatId = (req.query['chat_id'] ?? (req.body as Record<string, unknown>)?.['chat_id']) as string | undefined;
    if (!chatId || typeof chatId !== 'string' || !chatId.trim()) {
      res.status(400).json({ error: 'chat_id is required' });
      return null;
    }
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(chatId.trim())) {
      res.status(400).json({ error: 'chat_id must be 1-64 alphanumeric characters, hyphens, or underscores' });
      return null;
    }
    return { runner, agentId, chatId: chatId.trim() };
  }

  /**
   * GET /api/v1/agents/:agentId/sessions
   * List API sessions for a chat_id.
   */
  router.get('/v1/agents/:agentId/sessions', auth, async (req: Request, res: Response) => {
    const ctx = resolveApiSession(req, res);
    if (!ctx) return;
    const { runner, chatId } = ctx;
    try {
      const index = await runner.listApiSessions(chatId);
      const historySessions = runner.getHistoryDb().listSessions(`api-${chatId}`);
      const roleMap = new Map(historySessions.map((s) => [s.sessionId, s.lastMessageRole]));
      const enriched = {
        ...index,
        sessions: index.sessions.map((s) => {
          const lastMessageRole = roleMap.get(s.id) ?? undefined;
          return lastMessageRole !== undefined ? { ...s, lastMessageRole } : s;
        }),
      };
      res.json(enriched);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * POST /api/v1/agents/:agentId/sessions
   * Create a new API session. Optionally auto-names from a prompt.
   */
  router.post('/v1/agents/:agentId/sessions', auth, async (req: Request, res: Response) => {
    const ctx = resolveApiSession(req, res);
    if (!ctx) return;
    const { runner, agentId, chatId } = ctx;
    const body = req.body as { prompt?: unknown; name?: unknown };
    const promptText = typeof body.prompt === 'string' ? body.prompt.trim() : undefined;
    const explicitName = typeof body.name === 'string' ? body.name.trim() : undefined;
    try {
      const meta = await runner.createApiSession(chatId, promptText, explicitName);
      res.status(201).json({ sessionId: meta.id, sessionName: meta.name, createdAt: meta.createdAt });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * GET /api/v1/agents/:agentId/sessions/:sessionId/info
   */
  router.get('/v1/agents/:agentId/sessions/:sessionId/info', auth, async (req: Request, res: Response) => {
    const ctx = resolveApiSession(req, res);
    if (!ctx) return;
    const { runner, chatId } = ctx;
    const { sessionId } = req.params as { sessionId: string };
    try {
      const info = await runner.getApiSessionInfo(chatId, sessionId);
      if (!info) { res.status(404).json({ error: 'Session not found' }); return; }
      res.json(info);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * PATCH /api/v1/agents/:agentId/sessions/:sessionId
   * Update session metadata (name and/or model).
   */
  router.patch('/v1/agents/:agentId/sessions/:sessionId', auth, async (req: Request, res: Response) => {
    const ctx = resolveApiSession(req, res);
    if (!ctx) return;
    const { runner, chatId } = ctx;
    const { sessionId } = req.params as { sessionId: string };
    const body = req.body as { session_name?: unknown; sessionName?: unknown };
    // Accept session_name (preferred, snake_case) or sessionName (camelCase, backward compat)
    const rawName = body.session_name ?? body.sessionName;
    const sessionName = typeof rawName === 'string' ? rawName.trim() : undefined;
    if (!sessionName) { res.status(400).json({ error: 'session_name is required' }); return; }
    try {
      const result = await runner.updateApiSession(chatId, sessionId, { sessionName });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * DELETE /api/v1/agents/:agentId/sessions/:sessionId
   */
  router.delete('/v1/agents/:agentId/sessions/:sessionId', auth, async (req: Request, res: Response) => {
    const ctx = resolveApiSession(req, res);
    if (!ctx) return;
    const { runner, chatId } = ctx;
    const { sessionId } = req.params as { sessionId: string };
    try {
      await runner.deleteApiSession(chatId, sessionId);
      res.status(204).send();
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * POST /api/v1/agents/:agentId/sessions/:sessionId/clear
   */
  router.post('/v1/agents/:agentId/sessions/:sessionId/clear', auth, async (req: Request, res: Response) => {
    const ctx = resolveApiSession(req, res);
    if (!ctx) return;
    const { runner, chatId } = ctx;
    const { sessionId } = req.params as { sessionId: string };
    try {
      const { result } = await runner.executeApiCommand(sessionId, chatId, '/clear', { skipPersist: true });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * POST /api/v1/agents/:agentId/sessions/:sessionId/compact
   */
  router.post('/v1/agents/:agentId/sessions/:sessionId/compact', auth, async (req: Request, res: Response) => {
    const ctx = resolveApiSession(req, res);
    if (!ctx) return;
    const { runner, chatId } = ctx;
    const { sessionId } = req.params as { sessionId: string };
    try {
      const { result } = await runner.executeApiCommand(sessionId, chatId, '/compact', { skipPersist: true });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * POST /api/v1/agents/:agentId/sessions/:sessionId/stop
   */
  router.post('/v1/agents/:agentId/sessions/:sessionId/stop', auth, async (req: Request, res: Response) => {
    const ctx = resolveApiSession(req, res);
    if (!ctx) return;
    const { runner, chatId } = ctx;
    const { sessionId } = req.params as { sessionId: string };
    try {
      const { result } = await runner.executeApiCommand(sessionId, chatId, '/stop', { skipPersist: true });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * POST /api/v1/agents/:agentId/sessions/:sessionId/restart
   */
  router.post('/v1/agents/:agentId/sessions/:sessionId/restart', auth, async (req: Request, res: Response) => {
    const ctx = resolveApiSession(req, res);
    if (!ctx) return;
    const { runner, chatId } = ctx;
    const { sessionId } = req.params as { sessionId: string };
    try {
      const { result } = await runner.executeApiCommand(sessionId, chatId, '/restart', { skipPersist: true });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/v1/agents/:agentId/greeting — stream a proactive welcome from GREETING.md into an existing session
  router.post('/v1/agents/:agentId/greeting', auth, async (req: Request, res: Response) => {
    const { agentId } = req.params as { agentId: string };
    const apiKey = (req as AuthedRequest).apiKey;

    if (!canWriteAgent(apiKey, agentId)) {
      res.status(403).json({ error: `greeting requires write or admin access to agent '${agentId}'` });
      return;
    }

    const runner = agentRunners.get(agentId);
    if (!runner) { res.status(404).json({ error: `Agent '${agentId}' not found` }); return; }

    const body = req.body as { session_id?: unknown; chat_id?: unknown };
    const sessionId = typeof body.session_id === 'string' ? body.session_id.trim() : '';
    if (!sessionId) {
      res.status(400).json({ error: 'session_id is required' });
      return;
    }
    // chat_id is optional — provide the same value used when creating the session via POST /sessions
    // so the greeting message lands in the correct historyDb bucket (api-{chatId}).
    // If omitted, sessionId is used as the bucket key, which creates a secondary index entry.
    const chatId = typeof body.chat_id === 'string' && body.chat_id.trim() ? body.chat_id.trim() : sessionId;

    if (runner.hasActiveApiSession(sessionId)) {
      res.status(409).json({ error: 'Session already has a pending request' });
      return;
    }

    const greetingPath = path.join(runner.workspacePath, 'GREETING.md');
    let content: string;
    try {
      content = (await fsp.readFile(greetingPath, 'utf-8')).trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(204).send();
        return;
      }
      res.status(500).json({ error: `Failed to read GREETING.md: ${(err as Error).message}` });
      return;
    }

    if (!content) {
      res.status(204).send();
      return;
    }

    // Unlink before streaming — prevents re-read race if the client retries immediately
    try { await fsp.unlink(greetingPath); } catch (e) {
      console.error(`[api] Failed to delete GREETING.md for '${agentId}': ${(e as Error).message}`);
    }

    let onClientDisconnect: (() => void) | undefined;
    try {
      const sseCallbacks = {
        onChunk: (event: import('../types').StreamEvent) => {
          try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* client gone */ }
        },
        onDone: (fullText: string) => {
          try {
            res.write(`data: ${JSON.stringify({ type: 'result', text: fullText, session_id: sessionId })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          } catch { /* client gone */ }
        },
        onError: (err: Error) => {
          try {
            res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
            res.end();
          } catch { /* client gone */ }
        },
      } satisfies Parameters<typeof runner.sendApiMessageStream>[3];

      // Preflight conflict check already done above; throw-based check catches races after headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      res.socket?.setNoDelay(true);

      onClientDisconnect = await runner.sendApiMessageStream(
        sessionId,
        chatId,
        content,
        sseCallbacks,
        { timeoutMs: DEFAULT_TIMEOUT_MS, skipUserMessage: true },
      );

      res.on('close', onClientDisconnect);
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      // res.headersSent is always true here (writeHead is called before sendApiMessageStream),
      // so the !res.headersSent branches below are kept for parity with the /messages endpoint
      // pattern — they guard against future code reordering, not any current reachable path.
      if (!res.headersSent) {
        if (code === 'CONFLICT') {
          res.status(409).json({ error: 'Session already has a pending request' });
        } else {
          res.status(500).json({ error: (err as Error).message ?? 'Internal error' });
        }
      } else {
        try {
          res.write(`data: ${JSON.stringify({ type: 'error', message: (err as Error).message ?? 'Internal error' })}\n\n`);
          res.end();
        } catch { /* client gone */ }
      }
    }
  });

  return router;
}

function parseHistoryChatId(fullChatId: string): { source: string; rawChatId: string } {
  if (fullChatId.startsWith('telegram-')) return { source: 'telegram', rawChatId: fullChatId.slice(9) };
  if (fullChatId.startsWith('discord-')) return { source: 'discord', rawChatId: fullChatId.slice(8) };
  if (fullChatId.startsWith('line-')) return { source: 'line', rawChatId: fullChatId.slice(5) };
  return { source: 'api', rawChatId: fullChatId };
}
