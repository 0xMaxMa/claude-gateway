import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { AgentRunner } from './agent-runner';
import { AgentConfig, ApiKey } from './types';
import { createApiAuthMiddleware, canAccessAgent } from './api-auth';

const MAX_MESSAGE_LENGTH = 10_000;
const DEFAULT_TIMEOUT_MS = 60_000;

type AuthedRequest = Request & { apiKey: ApiKey };

export function createApiRouter(
  agentRunners: Map<string, AgentRunner>,
  agentConfigs: Map<string, AgentConfig>,
  apiKeys: ApiKey[],
): Router {
  const router = Router();
  const auth = createApiAuthMiddleware(apiKeys);

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

    const body = req.body as { message?: unknown; session_id?: unknown; stream?: unknown };
    const { message, session_id, stream } = body;

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

    if (stream) {
      // SSE streaming mode
      let cleanup: (() => void) | undefined;
      try {
        const sseCallbacks = {
          onChunk: (event: import('./types').StreamEvent) => {
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

        cleanup = await runner.sendApiMessageStream(
          sessionId,
          message.trim(),
          sseCallbacks,
          { timeoutMs: DEFAULT_TIMEOUT_MS },
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
        const response = await runner.sendApiMessage(sessionId, message.trim(), {
          timeoutMs: DEFAULT_TIMEOUT_MS,
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
   * GET /api/v1/agents
   *
   * List agents accessible by the current API key.
   */
  router.get('/v1/agents', auth, (req: Request, res: Response) => {
    const apiKey = (req as AuthedRequest).apiKey;
    const agents = [...agentConfigs.entries()]
      .filter(([id]) => canAccessAgent(apiKey, id))
      .map(([id, cfg]) => ({ id, description: cfg.description }));
    res.json({ agents });
  });

  return router;
}
