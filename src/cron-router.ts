import { Router, Request, Response } from 'express';
import { CronManager } from './cron-manager';
import { ApiKey, CronJobCreate, CronJobUpdate } from './types';
import { createApiAuthMiddleware, canAccessAgent } from './api-auth';

type AuthedRequest = Request & { apiKey: ApiKey };

/**
 * Creates Express routes for managing persistent cron jobs.
 *
 * All routes require a valid API key (Authorization: Bearer or X-Api-Key header).
 * Write operations (create/update/delete/run) additionally verify that the key
 * has access to the job's agentId via canAccessAgent().
 *
 * Routes:
 *   GET    /v1/crons           — List jobs accessible by this key
 *   GET    /v1/crons/status    — Overall scheduler status
 *   POST   /v1/crons           — Create a new job
 *   GET    /v1/crons/:id       — Get a single job
 *   PUT    /v1/crons/:id       — Update a job
 *   DELETE /v1/crons/:id       — Delete a job
 *   POST   /v1/crons/:id/run   — Trigger a job manually
 *   GET    /v1/crons/:id/runs  — Get run history
 */
export function createCronRouter(manager: CronManager, apiKeys?: ApiKey[], knownAgentIds?: Set<string>): Router {
  const router = Router();

  // Apply auth middleware if apiKeys are provided
  if (apiKeys?.length) {
    router.use(createApiAuthMiddleware(apiKeys));
  }

  // Helper: check agent access for jobs retrieved by id
  function checkJobAccess(req: Request, res: Response, agentId: string): boolean {
    if (!apiKeys?.length) return true; // no auth configured — allow all
    const apiKey = (req as AuthedRequest).apiKey;
    if (!canAccessAgent(apiKey, agentId)) {
      res.status(403).json({ error: `API key has no access to agent '${agentId}'` });
      return false;
    }
    return true;
  }

  // List jobs — filtered to agents this key can access
  router.get('/v1/crons', (_req: Request, res: Response) => {
    const agentId = _req.query.agent as string | undefined;
    let jobs = manager.list(agentId);

    // Filter by key's agent scope
    if (apiKeys?.length) {
      const apiKey = (_req as AuthedRequest).apiKey;
      if (apiKey.agents !== '*') {
        const allowed = apiKey.agents as string[];
        jobs = jobs.filter((j) => allowed.includes(j.agentId));
      }
    }

    res.json({ jobs });
  });

  // Overall status
  router.get('/v1/crons/status', (_req: Request, res: Response) => {
    res.json(manager.status());
  });

  // Create job
  router.post('/v1/crons', async (req: Request, res: Response) => {
    const body = req.body as Partial<CronJobCreate>;

    if (!body.agentId || !body.name) {
      res.status(400).json({ error: 'Required fields: agentId, name' });
      return;
    }

    if (!checkJobAccess(req, res, body.agentId)) return;

    if (knownAgentIds && !knownAgentIds.has(body.agentId)) {
      res.status(404).json({ error: `Agent '${body.agentId}' not found` });
      return;
    }

    const scheduleKind = body.scheduleKind ?? 'cron';
    const type = body.type ?? 'command';

    // Schedule validation
    if (scheduleKind === 'cron' && !body.schedule) {
      res.status(400).json({ error: 'schedule is required for scheduleKind=cron' });
      return;
    }
    if (scheduleKind === 'at' && !body.scheduleAt) {
      res.status(400).json({ error: 'scheduleAt is required for scheduleKind=at' });
      return;
    }
    // Payload validation
    if (type === 'command' && !body.command) {
      res.status(400).json({ error: 'command is required for type=command' });
      return;
    }
    if (type === 'agent' && !body.prompt) {
      res.status(400).json({ error: 'prompt is required for type=agent' });
      return;
    }
    if (type === 'agent' && !body.telegram) {
      res.status(400).json({ error: 'telegram is required for type=agent' });
      return;
    }

    try {
      const job = await manager.create(body as CronJobCreate);
      res.status(201).json({ job });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Get single job
  router.get('/v1/crons/:id', (req: Request, res: Response) => {
    const job = manager.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    if (!checkJobAccess(req, res, job.agentId)) return;
    res.json({ job });
  });

  // Update job
  router.put('/v1/crons/:id', async (req: Request, res: Response) => {
    const job = manager.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    if (!checkJobAccess(req, res, job.agentId)) return;
    try {
      const updated = await manager.update(req.params.id, req.body as CronJobUpdate);
      res.json({ job: updated });
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('not found')) {
        res.status(404).json({ error: message });
      } else {
        res.status(400).json({ error: message });
      }
    }
  });

  // Delete job
  router.delete('/v1/crons/:id', async (req: Request, res: Response) => {
    const job = manager.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    if (!checkJobAccess(req, res, job.agentId)) return;
    try {
      await manager.remove(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      const message = (err as Error).message;
      res.status(500).json({ error: message });
    }
  });

  // Manual trigger
  router.post('/v1/crons/:id/run', async (req: Request, res: Response) => {
    const job = manager.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    if (!checkJobAccess(req, res, job.agentId)) return;
    try {
      const log = await manager.run(req.params.id);
      res.json({ run: log });
    } catch (err) {
      const message = (err as Error).message;
      res.status(500).json({ error: message });
    }
  });

  // Run history
  router.get('/v1/crons/:id/runs', async (req: Request, res: Response) => {
    const job = manager.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    if (!checkJobAccess(req, res, job.agentId)) return;
    const limit = parseInt(req.query.limit as string) || 20;
    try {
      const runs = await manager.getRuns(req.params.id, limit);
      res.json({ runs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
