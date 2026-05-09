import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { AgentConfig, ApiKey } from '../types';
import { createApiAuthMiddleware, canAccessAgent, canWriteAgent } from './auth';

const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1MB

const ALLOWED_FILES = new Set([
  'SOUL.md',
  'USER.md',
  'MEMORY.md',
  'AGENTS.md',
  'HEARTBEAT.md',
  'IDENTITY.md',
]);

const FILENAME_RE = /^[A-Z][A-Z0-9_-]*\.md$/i;

type AuthedRequest = Request & { apiKey: ApiKey };

function validateFilename(filename: string): string | null {
  if (!FILENAME_RE.test(filename)) return 'Invalid filename format';
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return 'Path traversal not allowed';
  }
  if (!ALLOWED_FILES.has(filename)) {
    return `Filename not allowed. Allowed files: ${[...ALLOWED_FILES].join(', ')}`;
  }
  return null;
}

export function createWorkspaceRouter(
  agentConfigs: Map<string, AgentConfig>,
  apiKeys: ApiKey[],
): Router {
  const router = Router();
  const auth = createApiAuthMiddleware(apiKeys);

  /**
   * GET /api/v1/agents/:agentId/files/:filename
   *
   * Read a workspace file for an agent.
   * Returns 200 with empty content if the file does not exist yet.
   */
  router.get('/v1/agents/:agentId/files/:filename', auth, (req: Request, res: Response) => {
    const { agentId, filename } = req.params as { agentId: string; filename: string };
    const apiKey = (req as AuthedRequest).apiKey;

    if (!canAccessAgent(apiKey, agentId)) {
      res.status(403).json({ error: `API key has no access to agent '${agentId}'` });
      return;
    }

    const config = agentConfigs.get(agentId);
    if (!config) {
      res.status(404).json({ error: `Agent '${agentId}' not found` });
      return;
    }

    const err = validateFilename(filename);
    if (err) {
      res.status(400).json({ error: err });
      return;
    }

    const filePath = path.join(config.workspace, filename);
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      // File doesn't exist yet — return empty content (not an error)
    }

    res.json({ filename, content });
  });

  /**
   * PUT /api/v1/agents/:agentId/files/:filename
   *
   * Write a workspace file for an agent. Requires write access.
   * Gateway's file watcher will auto-reload CLAUDE.md after write.
   */
  router.put('/v1/agents/:agentId/files/:filename', auth, (req: Request, res: Response) => {
    const { agentId, filename } = req.params as { agentId: string; filename: string };
    const apiKey = (req as AuthedRequest).apiKey;

    if (!canWriteAgent(apiKey, agentId)) {
      res.status(403).json({ error: 'Write permission required' });
      return;
    }

    const config = agentConfigs.get(agentId);
    if (!config) {
      res.status(404).json({ error: `Agent '${agentId}' not found` });
      return;
    }

    const err = validateFilename(filename);
    if (err) {
      res.status(400).json({ error: err });
      return;
    }

    const body = req.body as { content?: unknown };
    if (typeof body.content !== 'string') {
      res.status(400).json({ error: 'content must be a string' });
      return;
    }

    if (body.content.length > MAX_FILE_SIZE) {
      res.status(400).json({ error: 'Content exceeds 1MB limit' });
      return;
    }

    const filePath = path.join(config.workspace, filename);
    const tmpPath = filePath + '.tmp.' + randomUUID();
    try {
      fs.writeFileSync(tmpPath, body.content, 'utf-8');
      fs.renameSync(tmpPath, filePath);
    } catch (writeErr) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore cleanup error */ }
      res.status(500).json({ error: `Failed to write file: ${(writeErr as Error).message}` });
      return;
    }

    res.json({ filename, message: 'File saved. CLAUDE.md will auto-reload.' });
  });

  return router;
}
