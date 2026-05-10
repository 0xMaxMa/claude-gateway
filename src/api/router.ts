import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AgentRunner } from '../agent/runner';
import { AgentConfig, ApiKey, ModelConfig } from '../types';
import { createApiAuthMiddleware, canAccessAgent, canWriteAgent, isAdmin } from './auth';
import { MediaStore } from '../history/media-store';
import { HistoryDB } from '../history/db';
import type { AgentSessionSummary } from '../history/types';

const MAX_MESSAGE_LENGTH = 10_000;
const DEFAULT_TIMEOUT_MS = 60_000;

type AuthedRequest = Request & { apiKey: ApiKey };

const AGENT_ID_RE = /^[a-z][a-z0-9_-]{1,31}$/;

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
   * POST /api/v1/agents/:agentId/messages
   *
   * Send a message to an agent and receive its response synchronously.
   * Body: { message: string, session_id?: string }
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
      session_id?: unknown;
      stream?: unknown;
      timeout_ms?: unknown;
    };
    const { message, session_id, stream, timeout_ms } = body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'message is required and must be a non-empty string' });
      return;
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      res.status(400).json({ error: `message too long (max ${MAX_MESSAGE_LENGTH} characters)` });
      return;
    }
    if (session_id !== undefined && typeof session_id !== 'string') {
      res.status(400).json({ error: 'session_id must be a string if provided' });
      return;
    }

    const requestId = randomUUID();
    const sessionId = (session_id as string | undefined) ?? randomUUID();
    const startTime = Date.now();
    const timeoutMs =
      typeof timeout_ms === 'number' && timeout_ms > 0 && timeout_ms <= 600_000
        ? timeout_ms
        : DEFAULT_TIMEOUT_MS;

    if (stream) {
      // SSE streaming mode
      let cleanup: (() => void) | undefined;
      try {
        const sseCallbacks = {
          onChunk: (event: import('../types').StreamEvent) => {
            try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* client gone */ }
          },
          onDone: (fullText: string) => {
            try {
              res.write(`data: ${JSON.stringify({ type: 'result', text: fullText, request_id: requestId, session_id: sessionId, duration_ms: Date.now() - startTime })}\n\n`);
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

        // Preflight conflict check — return 409 JSON before SSE headers are sent
        if (runner.hasActiveApiSession(sessionId)) {
          res.status(409).json({ error: 'Session already has a pending request' });
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.flushHeaders();
        res.socket?.setNoDelay(true);

        const agentCfg = agentConfigs.get(agentId)!;
        const allowTools = agentCfg.allow_tools ?? !!apiKey.allow_tools;
        cleanup = await runner.sendApiMessageStream(
          sessionId,
          message.trim(),
          sseCallbacks,
          { timeoutMs, allowTools },
        );

        // Client disconnect -> cleanup
        res.on('close', cleanup);
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
        const agentCfgSync = agentConfigs.get(agentId)!;
        const allowToolsSync = agentCfgSync.allow_tools ?? !!apiKey.allow_tools;
        const response = await runner.sendApiMessage(sessionId, message.trim(), {
          timeoutMs,
          allowTools: allowToolsSync,
        });
        res.json({
          request_id: requestId,
          agent_id: agentId,
          response,
          session_id: sessionId,
          duration_ms: Date.now() - startTime,
        });
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
        description: cfg.description,
        model: cfg.claude?.model ?? null,
        allow_tools: cfg.allow_tools ?? false,
      }));
    res.json({ agents });
  });

  /**
   * GET /api/v1/agents/sessions
   *
   * List all sessions across all agents. Admin only.
   * Queries each agent's history DB sequentially and returns a nested agents → sessions structure.
   */
  router.get('/v1/agents/sessions', auth, (req: Request, res: Response) => {
    const apiKey = (req as AuthedRequest).apiKey;
    if (!isAdmin(apiKey)) {
      res.status(403).json({ error: 'Admin key required' });
      return;
    }
    const agents: AgentSessionSummary[] = [...agentRunners.entries()].map(([agentId, runner]) => {
      const cfg = agentConfigs.get(agentId);
      return {
        agentId,
        description: cfg?.description ?? '',
        sessions: runner.getHistoryDb().listSessions(),
      };
    });
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
        dangerouslySkipPermissions: false,
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

  /**
   * PATCH /api/v1/agents/:agentId
   *
   * Update agent description and/or model. Requires write access to the agent.
   * Body: { description?, model? }
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

    const body = req.body as { description?: unknown; model?: unknown; allow_tools?: unknown };
    const { description, model, allow_tools } = body;
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

    try {
      await writeAgentsToConfig(configPath, (agents) => {
        const agent = (agents as Record<string, unknown>[]).find((a) => a.id === agentId);
        if (!agent) return;
        if (description !== undefined) agent.description = (description as string).trim();
        if (model !== undefined) {
          const claude = agent.claude as Record<string, unknown> | undefined;
          if (claude) claude.model = (model as string).trim();
        }
        if (allow_tools !== undefined) agent.allow_tools = allow_tools;
      });
    } catch (err) {
      res.status(500).json({ error: `Failed to write config: ${(err as Error).message}` });
      return;
    }

    // Sync in-memory map with what was written to disk
    const cfg = agentConfigs.get(agentId)!;
    if (description !== undefined) cfg.description = (description as string).trim();
    if (model !== undefined && cfg.claude) cfg.claude.model = (model as string).trim();
    if (allow_tools !== undefined) cfg.allow_tools = allow_tools;

    res.json({ agent: { id: agentId, description: cfg.description, model: cfg.claude?.model, allow_tools: cfg.allow_tools ?? false } });
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
    if (source !== 'telegram' && source !== 'discord') {
      res.status(400).json({ error: 'Sessions endpoint only supports telegram/discord chats' });
      return;
    }
    try {
      const index = await runner.listSessionsForChat(rawChatId, source as 'telegram' | 'discord');
      res.json(index);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * GET /api/v1/agents/:agentId/chats/:chatId/messages
   * Paginated message history (cursor-based).
   * Query: limit, before (ts ms), after (ts ms), session_id
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
    const before = query['before'] ? parseInt(query['before'], 10) : undefined;
    const after = query['after'] ? parseInt(query['after'], 10) : undefined;
    const sessionId = query['session_id'] ?? undefined;

    const page = runner.getHistoryDb().getMessages(chatId, { limit, before, after, sessionId });
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
    if (source !== 'telegram' && source !== 'discord') {
      res.status(400).json({ error: 'Cross-channel messaging only supported for telegram/discord chats' });
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
        source as 'telegram' | 'discord',
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
      const buf = (req as Request & { rawFileBuffer?: Buffer }).rawFileBuffer;
      const mimeType = (req as Request & { rawFileMime?: string }).rawFileMime ?? '';
      if (!buf || buf.length === 0) {
        res.status(400).json({ error: 'No file body received' });
        return;
      }
      const originalName = (req.headers['x-filename'] as string | undefined) ?? `upload`;
      const safeExt = path.extname(originalName).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 10);
      const ext = safeExt || (mimeType.includes('pdf') ? '.pdf' : '.bin');
      const tmpFile = path.join(os.tmpdir(), `gw-${Date.now()}${ext}`);
      try {
        await fsp.writeFile(tmpFile, buf);
        const agentsBaseDir = runner.getAgentsBaseDir();
        const mediaPath = MediaStore.copyToMedia(agentsBaseDir, agentId, 'ui-upload', tmpFile);
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
    res.sendFile(absPath);
  });

  return router;
}

function parseHistoryChatId(fullChatId: string): { source: string; rawChatId: string } {
  if (fullChatId.startsWith('telegram-')) return { source: 'telegram', rawChatId: fullChatId.slice(9) };
  if (fullChatId.startsWith('discord-')) return { source: 'discord', rawChatId: fullChatId.slice(8) };
  return { source: 'api', rawChatId: fullChatId };
}
